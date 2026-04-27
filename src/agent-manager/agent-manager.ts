/**
 * AgentManager: multi-session orchestrator.
 *
 * Holds a Map of AgentSessions, each wrapping an AgentController with
 * metadata (label, state, timestamps). Routes messages to the active
 * session. Emits events so the ChatViewProvider can broadcast session
 * list updates to the webview.
 */
import { AgentController } from "../agent/agent-controller";
import type { LLMProvider } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import type { SmartRouter } from "../providers/smart-router";
import type {
  SessionMetadata,
  SessionState,
  SerializedSession,
  ManagerEvent,
} from "./types";

export interface AgentSession {
  metadata: SessionMetadata;
  controller: AgentController;
}

let idCounter = 0;

function generateId(): string {
  idCounter++;
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `sess-${ts}${rand}${idCounter}`;
}

export class AgentManager {
  private sessions = new Map<string, AgentSession>();
  private activeId: string | null = null;
  private listeners = new Set<(event: ManagerEvent) => void>();
  private smartRouter: SmartRouter | null = null;

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly providerFactory: () => LLMProvider,
  ) {}

  setSmartRouter(router: SmartRouter): void {
    this.smartRouter = router;
    // Wire into all existing sessions.
    for (const session of this.sessions.values()) {
      session.controller.setSmartRouter(router);
    }
  }

  createSession(label?: string): AgentSession {
    const id = generateId();
    const now = Date.now();
    const metadata: SessionMetadata = {
      id,
      label: label || "New chat",
      state: "idle",
      createdAt: now,
      lastActivityAt: now,
      mode: "agent",
      messageCount: 0,
      modifiedFiles: [],
      archived: false,
    };
    const controller = new AgentController(
      this.providerFactory(),
      this.toolRegistry,
      this.workspaceRoot,
    );
    if (this.smartRouter) controller.setSmartRouter(this.smartRouter);
    const session: AgentSession = { metadata, controller };
    this.sessions.set(id, session);
    this.activeId = id;
    this.emit({ type: "sessionCreated", id });
    this.emit({ type: "activeChanged", id });
    return session;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  getActive(): AgentSession | null {
    if (!this.activeId) return null;
    return this.sessions.get(this.activeId) ?? null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  setActive(id: string): void {
    if (!this.sessions.has(id)) {
      throw new Error(`Unknown session id: ${id}`);
    }
    this.activeId = id;
    this.emit({ type: "activeChanged", id });
  }

  listSessions(includeArchived = false): SessionMetadata[] {
    const result: SessionMetadata[] = [];
    for (const session of this.sessions.values()) {
      if (!includeArchived && session.metadata.archived) continue;
      result.push({ ...session.metadata });
    }
    return result.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  updateSessionState(id: string, state: SessionState): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.metadata.state = state;
    session.metadata.lastActivityAt = Date.now();
    this.emit({ type: "sessionStateChanged", id, state });
  }

  abortSession(id: string): void {
    this.updateSessionState(id, "aborted");
  }

  archiveSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.metadata.archived = true;
    this.emit({ type: "sessionUpdated", id });
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
    if (this.activeId === id) {
      // Pick the most recent remaining session, or null.
      const remaining = this.listSessions(true);
      this.activeId = remaining.length > 0 ? remaining[0].id : null;
      this.emit({ type: "activeChanged", id: this.activeId });
    }
    this.emit({ type: "sessionDeleted", id });
  }

  renameSession(id: string, newLabel: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.metadata.label = newLabel;
    this.emit({ type: "sessionUpdated", id });
  }

  autoLabelSession(id: string, firstMessageText: string): void {
    const label = firstMessageText.replace(/\n/g, " ").trim().slice(0, 60);
    this.renameSession(id, label || "New chat");
  }

  exportSession(id: string): SerializedSession {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session id: ${id}`);
    }
    return {
      version: 1,
      metadata: { ...session.metadata },
      history: session.controller.getHistory(),
    };
  }

  importSession(serialized: SerializedSession): AgentSession {
    const controller = new AgentController(
      this.providerFactory(),
      this.toolRegistry,
      this.workspaceRoot,
    );
    controller.setHistory(serialized.history ?? []);
    const session: AgentSession = {
      metadata: { ...serialized.metadata },
      controller,
    };
    this.sessions.set(serialized.metadata.id, session);
    this.emit({ type: "sessionCreated", id: serialized.metadata.id });
    return session;
  }

  swapProvider(provider: LLMProvider): void {
    for (const session of this.sessions.values()) {
      session.controller.setProvider(provider);
    }
  }

  onChange(listener: (event: ManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors.
      }
    }
  }
}
