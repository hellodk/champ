// webview-ui/src/components/DiffOverlayPanel.tsx
import { signal, computed } from "@preact/signals";
import { splitHunks, type WebviewHunk } from "../utils/diff";
import type { EditSummaryMessage, EditSummary } from "../types";

export const editsSignal = signal<EditSummary[]>([]);
const isVisibleSignal = computed(() => editsSignal.value.length > 0);

/** Index of the file currently shown in the main content area. */
const selectedFileIndexSignal = signal<number>(0);

window.addEventListener("champ:editSummary", (e: Event) => {
  const msg = (e as CustomEvent<EditSummaryMessage>).detail;
  if (Array.isArray(msg.edits)) {
    editsSignal.value = msg.edits;
    selectedFileIndexSignal.value = 0; // reset to first file on new batch
  }
});

const hunkResolutions = signal<Map<string, "accepted" | "rejected">>(new Map());

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

/** Extract the filename (basename) from an absolute or relative path. */
function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Extract the directory portion for display in the navigator tooltip. */
function dirname(p: string): string {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || ".";
}

function HunkRow({
  edit,
  hunk,
}: {
  edit: EditSummary;
  hunk: WebviewHunk;
}): JSX.Element {
  const key = `${edit.path}:${hunk.index}`;
  const resolution = hunkResolutions.value.get(key);

  function handleAccept(): void {
    getVsCode().postMessage({
      type: "acceptHunkAtLine",
      filePath: edit.path,
      line: hunk.newDocStartLine,
    });
    const next = new Map(hunkResolutions.value);
    next.set(key, "accepted");
    hunkResolutions.value = next;
  }

  function handleReject(): void {
    getVsCode().postMessage({
      type: "rejectHunkAtLine",
      filePath: edit.path,
      line: hunk.newDocStartLine,
    });
    const next = new Map(hunkResolutions.value);
    next.set(key, "rejected");
    hunkResolutions.value = next;
  }

  return (
    <div
      class={`hunk-row${resolution ? ` hunk-${resolution}` : ""}`}
      style="margin: 4px 0; padding: 4px 8px; background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-focusBorder);"
    >
      <div style="display:flex; gap:6px; margin-bottom:4px; align-items:center;">
        <span style="font-size:11px; color:var(--vscode-descriptionForeground);">
          Hunk {hunk.index + 1}
        </span>
        {!resolution && (
          <>
            <button
              onClick={handleAccept}
              style="font-size:11px; padding:1px 6px; cursor:pointer;"
            >
              Accept
            </button>
            <button
              onClick={handleReject}
              style="font-size:11px; padding:1px 6px; cursor:pointer;"
            >
              Reject
            </button>
          </>
        )}
        {resolution === "accepted" && (
          <span style="font-size:11px; color:var(--vscode-terminal-ansiGreen);">
            Accepted
          </span>
        )}
        {resolution === "rejected" && (
          <span style="font-size:11px; color:var(--vscode-editorError-foreground);">
            Rejected
          </span>
        )}
      </div>
      <pre style="margin:0; font-size:11px; overflow-x:auto;">
        {hunk.removedLines.map((l, i) => (
          <div
            key={`del-${i}`}
            style="color:var(--vscode-gitDecoration-deletedResourceForeground);"
          >
            - {l}
          </div>
        ))}
        {hunk.addedLines.map((l, i) => (
          <div
            key={`add-${i}`}
            style="color:var(--vscode-gitDecoration-addedResourceForeground);"
          >
            + {l}
          </div>
        ))}
      </pre>
    </div>
  );
}

function FileSection({ edit }: { edit: EditSummary }): JSX.Element {
  const hunks = splitHunks(edit.oldContent, edit.newContent);

  function handleRevertFile(): void {
    getVsCode().postMessage({
      type: "revertEdit",
      path: edit.path,
      restoreContent: edit.oldContent,
    });
  }

  return (
    <div style="margin-bottom:12px;">
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:4px 8px; background:var(--vscode-sideBarSectionHeader-background);"
      >
        <span style="font-size:12px; font-weight:600; font-family:monospace;">
          {edit.path}
        </span>
        <button
          onClick={handleRevertFile}
          style="font-size:11px; padding:1px 6px; cursor:pointer;"
        >
          Revert File
        </button>
      </div>
      {hunks.map((hunk) => (
        <HunkRow key={`${edit.path}:${hunk.index}`} edit={edit} hunk={hunk} />
      ))}
    </div>
  );
}

/**
 * Vertical file list shown on the left side of the panel.
 * Clicking a file name scrolls the right pane to that file's diff.
 */
function FileNavigator({ edits }: { edits: EditSummary[] }): JSX.Element {
  const selectedIdx = selectedFileIndexSignal.value;

  return (
    <div
      style="width:180px; min-width:140px; max-width:220px; overflow-y:auto;
             border-right:1px solid var(--vscode-panel-border);
             background:var(--vscode-sideBar-background); flex-shrink:0;"
    >
      <div
        style="padding:4px 8px; font-size:11px; font-weight:600;
               color:var(--vscode-descriptionForeground);
               border-bottom:1px solid var(--vscode-panel-border);
               text-transform:uppercase; letter-spacing:0.05em;"
      >
        Files changed ({edits.length})
      </div>
      {edits.map((edit, idx) => {
        const isSelected = idx === selectedIdx;
        const name = basename(edit.path);
        const dir = dirname(edit.path);
        const hunkCount = splitHunks(edit.oldContent, edit.newContent).length;
        return (
          <div
            key={edit.path}
            title={edit.path}
            onClick={() => {
              selectedFileIndexSignal.value = idx;
            }}
            style={[
              "padding:5px 8px",
              "cursor:pointer",
              "border-left:3px solid " +
                (isSelected ? "var(--vscode-focusBorder)" : "transparent"),
              "background:" +
                (isSelected
                  ? "var(--vscode-list-activeSelectionBackground)"
                  : "transparent"),
              "color:" +
                (isSelected
                  ? "var(--vscode-list-activeSelectionForeground)"
                  : "var(--vscode-foreground)"),
            ].join(";")}
          >
            <div style="font-size:12px; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              {name}
            </div>
            <div style="font-size:10px; opacity:0.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              {dir}
            </div>
            <div style="font-size:10px; margin-top:2px; color:var(--vscode-gitDecoration-modifiedResourceForeground);">
              {hunkCount} hunk{hunkCount !== 1 ? "s" : ""}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DiffOverlayPanel(): JSX.Element | null {
  if (!isVisibleSignal.value) return null;

  const edits = editsSignal.value;
  const selectedIdx = selectedFileIndexSignal.value;
  const selectedEdit = edits[selectedIdx] ?? edits[0];

  function handleAcceptAll(): void {
    getVsCode().postMessage({ type: "acceptAllEdits" });
    editsSignal.value = [];
    hunkResolutions.value = new Map();
  }

  function handleRejectAll(): void {
    const allEdits = edits.map((e) => ({
      path: e.path,
      restoreContent: e.oldContent,
    }));
    getVsCode().postMessage({ type: "revertAllEdits", edits: allEdits });
    editsSignal.value = [];
    hunkResolutions.value = new Map();
  }

  return (
    <div
      style="position:fixed; bottom:0; left:0; right:0; max-height:50vh;
             background:var(--vscode-sideBar-background);
             border-top:1px solid var(--vscode-panel-border);
             z-index:50; box-shadow:0 -4px 12px rgba(0,0,0,0.3);
             display:flex; flex-direction:column;"
    >
      {/* Header bar */}
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:6px 12px; background:var(--vscode-titleBar-activeBackground);
               flex-shrink:0;"
      >
        <span style="font-weight:600; font-size:13px;">
          Champ Edits ({edits.length} file{edits.length !== 1 ? "s" : ""})
        </span>
        <div style="display:flex; gap:8px;">
          <button
            onClick={handleAcceptAll}
            style="padding:3px 10px; cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:2px;"
          >
            Accept All
          </button>
          <button
            onClick={handleRejectAll}
            style="padding:3px 10px; cursor:pointer;"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* Body: navigator + diff content side by side */}
      <div style="display:flex; flex:1; min-height:0; overflow:hidden;">
        <FileNavigator edits={edits} />
        <div style="flex:1; overflow-y:auto; padding:8px 12px;">
          {selectedEdit && (
            <FileSection key={selectedEdit.path} edit={selectedEdit} />
          )}
        </div>
      </div>
    </div>
  );
}
