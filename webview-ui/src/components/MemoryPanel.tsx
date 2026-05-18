// webview-ui/src/components/MemoryPanel.tsx
import { h, Fragment } from "preact";
import { useState, useEffect } from "preact/hooks";

interface MemoryItem {
  id: string;
  timestamp: number;
  userQuery: string;
  assistantSummary: string;
  sessionId: string;
  pinned?: boolean;
}

const vscode = (
  window as unknown as {
    acquireVsCodeApi?: () => { postMessage: (m: unknown) => void };
  }
).acquireVsCodeApi?.();

function formatTime(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MemoryRow({
  item,
  onDelete,
  onTogglePin,
}: {
  item: MemoryItem;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
}): JSX.Element {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--vscode-panel-border)",
        padding: "10px 0",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <span
          style={{
            fontSize: "13px",
            color: "var(--vscode-foreground)",
            flex: 1,
            marginRight: "8px",
          }}
        >
          {item.assistantSummary}
        </span>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <button
            title={item.pinned ? "Unpin" : "Pin (always inject)"}
            onClick={() => onTogglePin(item.id, !item.pinned)}
            style={{
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: item.pinned
                ? "var(--vscode-charts-yellow)"
                : "var(--vscode-descriptionForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px",
            }}
          >
            {item.pinned ? "📌 Pinned" : "📌 Pin"}
          </button>
          <button
            title="Delete memory"
            onClick={() => onDelete(item.id)}
            style={{
              background: "none",
              border: "1px solid var(--vscode-button-border, #555)",
              borderRadius: "3px",
              color: "var(--vscode-errorForeground)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: "12px",
            }}
          >
            ✕
          </button>
        </div>
      </div>
      <span
        style={{
          fontSize: "11px",
          color: "var(--vscode-descriptionForeground)",
        }}
      >
        {item.userQuery !== "manual"
          ? `From: "${item.userQuery}"`
          : "Manual entry"}{" "}
        · {formatTime(item.timestamp)}
      </span>
    </div>
  );
}

function AddMemoryForm({
  onAdd,
}: {
  onAdd: (text: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  return (
    <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
      <input
        type="text"
        placeholder="Remember... (e.g. 'We use Postgres not MySQL')"
        value={text}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            onAdd(text.trim());
            setText("");
          }
        }}
        style={{
          flex: 1,
          background: "var(--vscode-input-background)",
          border: "1px solid var(--vscode-input-border, #555)",
          color: "var(--vscode-input-foreground)",
          borderRadius: "3px",
          padding: "6px 8px",
          fontSize: "13px",
        }}
      />
      <button
        onClick={() => {
          if (text.trim()) {
            onAdd(text.trim());
            setText("");
          }
        }}
        disabled={!text.trim()}
        style={{
          background: "var(--vscode-button-background)",
          color: "var(--vscode-button-foreground)",
          border: "none",
          borderRadius: "3px",
          padding: "6px 12px",
          cursor: text.trim() ? "pointer" : "not-allowed",
          fontSize: "13px",
        }}
      >
        Add
      </button>
    </div>
  );
}

export function MemoryPanel(): JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type: string; items?: MemoryItem[] };
      if (msg.type === "memoryList" && Array.isArray(msg.items)) {
        setItems(msg.items);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleDelete = (id: string) => {
    vscode?.postMessage({ type: "memoryDelete", id });
    setItems((prev) => prev.filter((m) => m.id !== id));
  };

  const handleTogglePin = (id: string, pinned: boolean) => {
    vscode?.postMessage({ type: "memoryPin", id, pinned });
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, pinned } : m)));
  };

  const handleAdd = (text: string) => {
    vscode?.postMessage({ type: "memoryAdd", text });
  };

  const pinnedItems = items.filter((m) => m.pinned);
  const unpinnedItems = items.filter((m) => !m.pinned);

  return (
    <div style={{ maxWidth: "700px", margin: "0 auto", padding: "8px" }}>
      <h2
        style={{
          fontSize: "16px",
          marginBottom: "16px",
          color: "var(--vscode-foreground)",
        }}
      >
        Memory Bank
        <span
          style={{
            fontSize: "12px",
            color: "var(--vscode-descriptionForeground)",
            marginLeft: "8px",
            fontWeight: "normal",
          }}
        >
          {items.length} stored · {pinnedItems.length} pinned
        </span>
      </h2>

      <AddMemoryForm onAdd={handleAdd} />

      {pinnedItems.length > 0 && (
        <>
          <h3
            style={{
              fontSize: "13px",
              color: "var(--vscode-charts-yellow)",
              marginBottom: "8px",
            }}
          >
            📌 Always injected
          </h3>
          {pinnedItems.map((item) => (
            <MemoryRow
              key={item.id}
              item={item}
              onDelete={handleDelete}
              onTogglePin={handleTogglePin}
            />
          ))}
          {unpinnedItems.length > 0 && (
            <h3
              style={{
                fontSize: "13px",
                color: "var(--vscode-descriptionForeground)",
                margin: "16px 0 8px",
              }}
            >
              Recent memories
            </h3>
          )}
        </>
      )}

      {unpinnedItems.length === 0 && pinnedItems.length === 0 && (
        <p
          style={{
            color: "var(--vscode-descriptionForeground)",
            fontSize: "13px",
          }}
        >
          No memories yet. Champ stores conversation summaries here
          automatically, or add one manually above.
        </p>
      )}

      {unpinnedItems.map((item) => (
        <MemoryRow
          key={item.id}
          item={item}
          onDelete={handleDelete}
          onTogglePin={handleTogglePin}
        />
      ))}
    </div>
  );
}
