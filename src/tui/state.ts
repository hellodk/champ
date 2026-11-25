/**
 * Pure state container for the full-screen Ink TUI.
 *
 * Keeping transitions here makes the user interface testable without a
 * terminal and gives the chat, provider and config screens one shared source
 * of truth.
 */
export type TuiScreen =
  | "chat"
  | "providers"
  | "config"
  | "help"
  | "sessions"
  | "review";

export interface TuiSessionSummary {
  id: string;
  label: string;
  updatedAt: string;
}

export interface TuiReviewSummary {
  id: string;
  status: string;
  files: number;
  summary: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool" | "error";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  timestamp: string;
  streaming?: boolean;
}

export interface EndpointSummary {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  hasCredential: boolean;
  models: string[];
}

export interface SetupDraft {
  name: string;
  provider: string;
  baseUrl: string;
  credentialId: string;
  apiKey: string;
  model: string;
  open: boolean;
  saving: boolean;
  status?: string;
  error?: string;
}

export interface TuiState {
  screen: TuiScreen;
  workspace: string;
  model: string;
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  selectedModel?: string;
  messages: ChatMessage[];
  input: string;
  busy: boolean;
  status: string;
  setup: SetupDraft;
  diagnostics: string[];
  cursor: number;
  sessions: TuiSessionSummary[];
  sessionCursor: number;
  reviews: TuiReviewSummary[];
  reviewCursor: number;
  /** Prompts submitted this session, oldest first. */
  history: string[];
  /** null means the user is drafting a fresh prompt. */
  historyCursor: number | null;
  draftInput: string;
  /** Lines scrolled back from the newest transcript page. */
  scrollOffset: number;
}

export type TuiAction =
  | { type: "screen/set"; screen: TuiScreen }
  | { type: "screen/next" }
  | { type: "input/set"; value: string }
  | { type: "turn/start" }
  | { type: "turn/stop" }
  | { type: "message/add"; role: ChatRole; text: string }
  | { type: "message/stream"; role: ChatRole; text: string }
  | { type: "status/set"; text: string }
  | { type: "endpoints/set"; endpoints: EndpointSummary[] }
  | { type: "endpoints/cursor"; delta: number }
  | { type: "model/select"; endpointId: string; model: string }
  | {
      type: "selection/set";
      endpointId?: string;
      model?: string;
      status?: string;
    }
  | { type: "setup/open" }
  | { type: "setup/cancel" }
  | { type: "setup/change"; field: keyof SetupDraft; value: string }
  | { type: "setup/submit" }
  | { type: "setup/result"; status: string; error?: boolean }
  | { type: "diagnostics/set"; lines: string[] }
  | { type: "messages/clear" }
  | { type: "sessions/set"; sessions: TuiSessionSummary[] }
  | { type: "sessions/cursor"; delta: number }
  | { type: "reviews/set"; reviews: TuiReviewSummary[] }
  | { type: "reviews/cursor"; delta: number }
  | { type: "history/push"; value: string }
  | { type: "history/prev" }
  | { type: "history/next" }
  | { type: "transcript/scroll"; delta: number };

export interface TuiInitialState {
  workspace: string;
  model: string;
  endpoints: EndpointSummary[];
  selectedEndpointId?: string;
  selectedModel?: string;
  status?: string;
}

const SCREENS: TuiScreen[] = [
  "chat",
  "providers",
  "config",
  "help",
  "sessions",
  "review",
];
export const TRANSCRIPT_PAGE_SIZE = 18;
const MAX_MESSAGES = 400;

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `m${sequence}`;
}

function now(): string {
  return new Date().toISOString();
}

function emptySetup(): SetupDraft {
  return {
    name: "",
    provider: "openai-compatible",
    baseUrl: "",
    credentialId: "",
    apiKey: "",
    model: "",
    open: false,
    saving: false,
  };
}

export function initialTuiState(input: TuiInitialState): TuiState {
  return {
    screen: "chat",
    workspace: input.workspace,
    model: input.model,
    endpoints: input.endpoints,
    selectedEndpointId: input.selectedEndpointId,
    selectedModel: input.selectedModel,
    messages: [],
    input: "",
    busy: false,
    status: input.status ?? "Ready",
    setup: emptySetup(),
    diagnostics: [],
    cursor: 0,
    sessions: [],
    sessionCursor: 0,
    reviews: [],
    reviewCursor: 0,
    history: [],
    historyCursor: null,
    draftInput: "",
    scrollOffset: 0,
  };
}

function clampCursor(state: TuiState, delta: number): number {
  if (state.endpoints.length === 0) return 0;
  const next = state.cursor + delta;
  return Math.max(0, Math.min(state.endpoints.length - 1, next));
}

function clampIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, current + delta));
}

function appendMessage(
  state: TuiState,
  role: ChatRole,
  text: string,
  streaming: boolean,
): ChatMessage[] {
  const last = state.messages[state.messages.length - 1];
  if (
    streaming &&
    last?.streaming &&
    last.role === role &&
    role === "assistant"
  ) {
    const updated = { ...last, text: last.text + text };
    return [...state.messages.slice(0, -1), updated];
  }
  const message: ChatMessage = {
    id: nextId(),
    role,
    text,
    timestamp: now(),
    streaming: streaming && role === "assistant",
  };
  return [...state.messages, message].slice(-MAX_MESSAGES);
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "screen/set":
      return { ...state, screen: action.screen };
    case "screen/next": {
      const index = SCREENS.indexOf(state.screen);
      return { ...state, screen: SCREENS[(index + 1) % SCREENS.length] };
    }
    case "input/set":
      return {
        ...state,
        input: action.value,
        historyCursor: null,
        draftInput: action.value,
      };
    case "turn/start": {
      const submitted = state.input.trim();
      return {
        ...state,
        busy: true,
        status: "Thinking…",
        messages: appendMessage(state, "user", submitted, false),
        input: "",
        draftInput: "",
        historyCursor: null,
        history: submitted ? [...state.history, submitted] : state.history,
        scrollOffset: 0,
      };
    }
    case "turn/stop": {
      const messages = state.messages.map((message, index) =>
        index === state.messages.length - 1
          ? { ...message, streaming: false }
          : message,
      );
      return { ...state, busy: false, messages };
    }
    case "message/add":
      return {
        ...state,
        messages: appendMessage(state, action.role, action.text, false),
      };
    case "message/stream":
      return {
        ...state,
        messages: appendMessage(state, action.role, action.text, true),
      };
    case "status/set":
      return { ...state, status: action.text };
    case "endpoints/set":
      return {
        ...state,
        endpoints: action.endpoints,
        cursor: Math.min(
          state.cursor,
          Math.max(0, action.endpoints.length - 1),
        ),
      };
    case "endpoints/cursor":
      return { ...state, cursor: clampCursor(state, action.delta) };
    case "model/select":
      return {
        ...state,
        selectedEndpointId: action.endpointId,
        selectedModel: action.model,
        status: `Model ${action.model} selected`,
      };
    case "selection/set":
      return {
        ...state,
        selectedEndpointId: action.endpointId ?? state.selectedEndpointId,
        selectedModel: action.model ?? state.selectedModel,
        status: action.status ?? state.status,
      };
    case "setup/open":
      return {
        ...state,
        screen: "providers",
        setup: { ...emptySetup(), open: true },
      };
    case "setup/cancel":
      return { ...state, setup: emptySetup() };
    case "setup/change":
      return {
        ...state,
        setup: {
          ...state.setup,
          [action.field]: action.value,
          error: undefined,
        },
      };
    case "setup/submit": {
      if (!state.setup.name.trim()) {
        return {
          ...state,
          setup: { ...state.setup, error: "Endpoint name is required" },
        };
      }
      return {
        ...state,
        setup: { ...state.setup, saving: true, error: undefined },
      };
    }
    case "setup/result":
      return {
        ...state,
        setup: {
          ...state.setup,
          open: false,
          saving: false,
          status: action.status,
          error: action.error ? action.status : undefined,
        },
        status: action.status,
      };
    case "diagnostics/set":
      return { ...state, diagnostics: action.lines };
    case "messages/clear":
      return { ...state, messages: [], status: "New session" };
    case "sessions/set":
      return {
        ...state,
        sessions: action.sessions,
        sessionCursor: Math.min(
          state.sessionCursor,
          Math.max(0, action.sessions.length - 1),
        ),
      };
    case "sessions/cursor":
      return {
        ...state,
        sessionCursor: clampIndex(
          state.sessionCursor,
          action.delta,
          state.sessions.length,
        ),
      };
    case "reviews/set":
      return {
        ...state,
        reviews: action.reviews,
        reviewCursor: Math.min(
          state.reviewCursor,
          Math.max(0, action.reviews.length - 1),
        ),
      };
    case "reviews/cursor":
      return {
        ...state,
        reviewCursor: clampIndex(
          state.reviewCursor,
          action.delta,
          state.reviews.length,
        ),
      };
    case "history/push":
      return {
        ...state,
        history: [...state.history, action.value].slice(-200),
        historyCursor: null,
        draftInput: "",
      };
    case "history/prev": {
      if (state.history.length === 0) return state;
      const cursor =
        state.historyCursor === null
          ? state.history.length - 1
          : Math.max(0, state.historyCursor - 1);
      return {
        ...state,
        historyCursor: cursor,
        input: state.history[cursor],
      };
    }
    case "history/next": {
      if (state.historyCursor === null) return state;
      const next = state.historyCursor + 1;
      if (next >= state.history.length) {
        return {
          ...state,
          historyCursor: null,
          input: state.draftInput,
        };
      }
      return { ...state, historyCursor: next, input: state.history[next] };
    }
    case "transcript/scroll": {
      const max = Math.max(0, state.messages.length - TRANSCRIPT_PAGE_SIZE);
      return {
        ...state,
        scrollOffset: Math.max(
          0,
          Math.min(max, state.scrollOffset + action.delta),
        ),
      };
    }
    default:
      return state;
  }
}
