// webview-ui/src/components/RulesEditorPanel.tsx
import { signal } from "@preact/signals";
import {
  isValidMessage,
  type RulesListMessage,
  type RulesListAckMessage,
} from "../../../src/ui/messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuleEntry {
  name: string;
  content: string;
  type: "always" | "auto-attached" | "agent-requested";
  glob?: string;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const rulesSignal = signal<RuleEntry[]>([]);
const editingRuleSignal = signal<RuleEntry | null>(null);
const isNewRuleSignal = signal(false);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (
    typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined"
  ) {
    return (
      window as unknown as { vscode: { postMessage: (msg: unknown) => void } }
    ).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent) => {
  if (!isValidMessage(e.data)) return; // drop malformed
  const msg = e.data;
  if (msg.type === "rulesList") {
    rulesSignal.value = (msg as RulesListMessage).rules;
  } else if (msg.type === "rulesListAck") {
    rulesSignal.value = (msg as RulesListAckMessage).rules;
    editingRuleSignal.value = null;
    isNewRuleSignal.value = false;
  }
});

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RuleForm(): JSX.Element | null {
  const rule = editingRuleSignal.value;
  if (!rule) return null;

  const isNew = isNewRuleSignal.value;

  function update(field: keyof RuleEntry, value: unknown): void {
    editingRuleSignal.value = {
      ...editingRuleSignal.value!,
      [field]: value,
    };
  }

  function save(): void {
    if (!editingRuleSignal.value) return;
    getVsCode().postMessage({ type: "ruleAdd", rule: editingRuleSignal.value });
  }

  function cancel(): void {
    editingRuleSignal.value = null;
    isNewRuleSignal.value = false;
  }

  const inputStyle =
    "width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;margin-bottom:8px;";
  const labelStyle =
    "font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;display:block;";

  return (
    <div style="padding:14px;border-left:1px solid var(--vscode-panel-border);width:320px;flex-shrink:0;overflow-y:auto;box-sizing:border-box;">
      <div style="font-size:12px;font-weight:700;margin-bottom:12px;">
        {isNew ? "New Rule" : `Edit: ${rule.name}`}
      </div>

      {isNew && (
        <>
          <label style={labelStyle}>Name (filename without .md)</label>
          <input
            style={inputStyle}
            value={rule.name}
            onInput={(e) =>
              update("name", (e.target as HTMLInputElement).value)
            }
            placeholder="e.g. no-console"
          />
        </>
      )}

      <label style={labelStyle}>Type</label>
      <select
        style={inputStyle}
        value={rule.type}
        onChange={(e) => update("type", (e.target as HTMLSelectElement).value)}
      >
        <option value="always">always — injected into every prompt</option>
        <option value="auto-attached">
          auto-attached — injected when file matches glob
        </option>
        <option value="agent-requested">
          agent-requested — fetched on demand
        </option>
      </select>

      {rule.type === "auto-attached" && (
        <>
          <label style={labelStyle}>Glob pattern</label>
          <input
            style={inputStyle}
            value={rule.glob ?? ""}
            onInput={(e) =>
              update("glob", (e.target as HTMLInputElement).value || undefined)
            }
            placeholder="e.g. **/*.ts"
          />
        </>
      )}

      <label style={labelStyle}>Content</label>
      <textarea
        style={`${inputStyle}height:200px;resize:vertical;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;`}
        value={rule.content}
        onInput={(e) =>
          update("content", (e.target as HTMLTextAreaElement).value)
        }
        placeholder="Rule content (plain text or Markdown)"
      />

      <div style="display:flex;gap:8px;">
        <button
          onClick={save}
          style="flex:1;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:11px;"
        >
          Save Rule
        </button>
        <button
          onClick={cancel}
          style="flex:1;padding:6px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:11px;"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function RuleTypeTag({ type }: { type: RuleEntry["type"] }): JSX.Element {
  const colors: Record<RuleEntry["type"], string> = {
    always: "var(--vscode-terminal-ansiGreen)",
    "auto-attached": "var(--vscode-progressBar-background)",
    "agent-requested": "var(--vscode-descriptionForeground)",
  };
  return (
    <span
      style={`font-size:9px;padding:1px 5px;border-radius:10px;background:${colors[type]}22;color:${colors[type]};border:1px solid ${colors[type]}44;`}
    >
      {type}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RulesEditorPanel(): JSX.Element {
  function openNew(): void {
    editingRuleSignal.value = { name: "", content: "", type: "always" };
    isNewRuleSignal.value = true;
  }

  function openEdit(rule: RuleEntry): void {
    editingRuleSignal.value = { ...rule };
    isNewRuleSignal.value = false;
  }

  function deleteRule(name: string): void {
    getVsCode().postMessage({ type: "ruleDelete", name });
  }

  const rules = rulesSignal.value;

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      {/* Toolbar */}
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0;">
        <span style="font-size:13px;font-weight:700;flex:1;">Rules Editor</span>
        <button
          onClick={openNew}
          style="padding:5px 12px;border:none;border-radius:3px;cursor:pointer;font-size:11px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);"
        >
          + New Rule
        </button>
      </div>

      {/* Body */}
      <div style="display:flex;flex:1;overflow:hidden;">
        {/* List */}
        <div style="flex:1;overflow-y:auto;">
          {rules.length === 0 && (
            <div style="padding:20px;color:var(--vscode-descriptionForeground);font-size:12px;">
              No rules yet. Create one with &quot;+ New Rule&quot; or add a{" "}
              <code>.md</code> file to <code>.champ/rules/</code>.
            </div>
          )}
          {rules.map((rule) => (
            <div
              key={rule.name}
              style="padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:flex-start;gap:10px;cursor:pointer;transition:background .1s;"
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  "var(--vscode-list-hoverBackground)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "";
              }}
              onClick={() => openEdit(rule)}
            >
              <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
                  <span style="font-size:12px;font-weight:600;font-family:monospace;">
                    {rule.name}
                  </span>
                  <RuleTypeTag type={rule.type} />
                  {rule.glob && (
                    <span style="font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;opacity:.7;">
                      {rule.glob}
                    </span>
                  )}
                </div>
                <div style="font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {rule.content.slice(0, 80)}
                  {rule.content.length > 80 ? "…" : ""}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteRule(rule.name);
                }}
                style="padding:3px 8px;background:none;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:10px;color:var(--vscode-errorForeground);flex-shrink:0;"
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        {/* Edit form */}
        {editingRuleSignal.value && <RuleForm />}
      </div>
    </div>
  );
}
