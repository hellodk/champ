import * as vscode from "vscode";
import type { WorkflowRun } from "./workflow-store";

export type PanelMessage =
  | { type: "approve" }
  | { type: "skipAgent" }
  | { type: "stop" }
  | { type: "acceptFile"; filePath: string }
  | { type: "rejectFile"; filePath: string }
  | { type: "acceptAll" }
  | { type: "rejectAll" }
  | { type: "modeChange"; mode: string };

export class WorkflowPanel {
  private readonly panel: vscode.WebviewPanel;
  private messageHandlers: Array<(msg: PanelMessage) => void> = [];
  private disposed = false;

  constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.workflowPanel",
      "⚡ Agent Workflow",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
      for (const h of this.messageHandlers) h(msg);
    });
  }

  onMessage(handler: (msg: PanelMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  update(run: WorkflowRun): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage({ type: "update", run });
    }
  }

  setTitle(title: string): void {
    this.panel.title = `⚡ ${title.slice(0, 40)}`;
  }

  onDidDispose(cb: () => void): void {
    this.panel.onDidDispose(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.panel.dispose();
  }

  private renderHtml(): string {
    // Generate a cryptographic nonce for CSP
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    const nonce = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
         color:var(--vscode-foreground);background:var(--vscode-editor-background);
         height:100vh;display:flex;flex-direction:column;overflow:hidden}
    #pipeline-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;
                  background:var(--vscode-sideBar-background);
                  border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;flex-wrap:wrap}
    #run-name{font-size:12px;font-weight:600;margin-right:4px}
    #pip-steps{display:flex;gap:4px;flex:1;flex-wrap:wrap}
    .step-pip{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;
              border-radius:4px;font-size:11px}
    .step-pip.running{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
    .step-pip.completed{color:var(--vscode-testing-iconPassed,#73c991)}
    .step-pip.failed{color:var(--vscode-testing-iconFailed,#f14c4c)}
    .step-pip.pending{color:var(--vscode-descriptionForeground);opacity:.5}
    .step-pip.awaiting-approval,.step-pip.skipped{color:var(--vscode-charts-orange,#f5a623)}
    #mode-select{background:var(--vscode-dropdown-background);
                 color:var(--vscode-dropdown-foreground);
                 border:1px solid var(--vscode-dropdown-border);
                 border-radius:4px;padding:3px 6px;font-size:11px;cursor:pointer}
    #btn-stop{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);
              color:#fff;border:none;border-radius:4px;
              padding:4px 10px;cursor:pointer;font-size:11px}
    #btn-stop:hover{opacity:.85}
    #main{display:flex;flex:1;overflow:hidden;min-height:0}
    #step-list{width:200px;flex-shrink:0;overflow-y:auto;
               border-right:1px solid var(--vscode-panel-border);padding:6px 4px}
    .step-row{display:flex;align-items:center;gap:6px;padding:5px 8px;
              border-radius:4px;cursor:pointer;margin-bottom:2px;font-size:11px}
    .step-row:hover{background:var(--vscode-list-hoverBackground)}
    .step-row.selected{background:var(--vscode-list-activeSelectionBackground);
                       color:var(--vscode-list-activeSelectionForeground)}
    .step-icon{width:14px;text-align:center;flex-shrink:0}
    .step-name{flex:1}
    .step-dur{font-size:10px;color:var(--vscode-descriptionForeground)}
    #diff-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    #diff-header{display:flex;align-items:center;gap:6px;padding:6px 10px;
                 background:var(--vscode-sideBar-background);
                 border-bottom:1px solid var(--vscode-panel-border);
                 flex-shrink:0;flex-wrap:wrap}
    #diff-pane-title{font-size:12px;font-weight:600;flex:1}
    .btn-accept{background:#2d6a4f;color:#fff;border:none;border-radius:3px;
                padding:3px 10px;cursor:pointer;font-size:11px}
    .btn-accept:hover{opacity:.85}
    .btn-reject{background:#6b2737;color:#fff;border:none;border-radius:3px;
                padding:3px 10px;cursor:pointer;font-size:11px}
    .btn-reject:hover{opacity:.85}
    #file-list{overflow-y:auto;padding:2px 0;
               border-bottom:1px solid var(--vscode-panel-border);
               flex-shrink:0;max-height:110px}
    .file-row{display:flex;align-items:center;gap:6px;
              padding:4px 10px;cursor:pointer;font-size:11px}
    .file-row:hover{background:var(--vscode-list-hoverBackground)}
    .file-row.selected{background:var(--vscode-list-activeSelectionBackground)}
    .file-status{width:12px;text-align:center;font-size:11px;flex-shrink:0}
    .file-status.pending{color:var(--vscode-charts-orange,#f5a623)}
    .file-status.accepted{color:var(--vscode-testing-iconPassed,#73c991)}
    .file-status.rejected{color:var(--vscode-testing-iconFailed,#f14c4c)}
    .file-path{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .file-actions{display:flex;gap:3px;flex-shrink:0}
    .btn-sm-accept,.btn-sm-reject{border:none;border-radius:2px;
                                   padding:1px 5px;cursor:pointer;font-size:10px}
    .btn-sm-accept{background:#2d6a4f;color:#fff}
    .btn-sm-reject{background:#6b2737;color:#fff}
    #diff-content{flex:1;overflow-y:auto;padding:8px 10px;
                  font-family:var(--vscode-editor-font-family,monospace);
                  font-size:12px;line-height:1.5}
    .diff-line{display:block;padding:1px 4px;white-space:pre-wrap;word-break:break-all}
    .diff-line.add{background:rgba(45,106,79,.25);color:#73c991}
    .diff-line.del{background:rgba(107,39,55,.25);color:#f88}
    .diff-line.ctx{color:var(--vscode-descriptionForeground)}
    #approval-bar{padding:8px 10px;background:rgba(245,166,35,.1);
                  border-top:1px solid var(--vscode-charts-orange,#f5a623);
                  display:none;align-items:center;gap:8px;flex-shrink:0}
    #approval-bar.visible{display:flex}
    #approval-msg{flex:1;font-size:11px;color:var(--vscode-charts-orange,#f5a623)}
    .btn-approve{background:#2d6a4f;color:#fff;border:none;border-radius:3px;
                 padding:4px 12px;cursor:pointer;font-size:11px}
    .btn-skip-agent{background:#444;color:#fff;border:none;border-radius:3px;
                    padding:4px 12px;cursor:pointer;font-size:11px}
    .output-pre{font-size:11px;padding:8px;white-space:pre-wrap;word-break:break-all;
                color:var(--vscode-foreground)}
    #empty-hint{display:flex;align-items:center;justify-content:center;
                height:100%;color:var(--vscode-descriptionForeground);font-size:12px}
  </style>
</head>
<body>
  <div id="pipeline-bar">
    <span id="run-name"></span>
    <span id="pip-steps"></span>
    <select id="mode-select" title="Workflow mode">
      <option value="auto">Auto</option>
      <option value="safe" selected>Safe</option>
      <option value="audit">Audit</option>
    </select>
    <button id="btn-stop">&#9632; Stop</button>
  </div>
  <div id="main">
    <div id="step-list"></div>
    <div id="diff-pane">
      <div id="diff-header">
        <span id="diff-pane-title">Select a step</span>
        <button class="btn-accept" id="btn-accept-all" style="display:none">&#10003; Accept All</button>
        <button class="btn-reject" id="btn-reject-all" style="display:none">&#10007; Reject All</button>
      </div>
      <div id="file-list"></div>
      <div id="diff-content"><div id="empty-hint">Waiting for workflow to start&#8230;</div></div>
      <div id="approval-bar">
        <span id="approval-msg"></span>
        <button class="btn-approve" id="btn-approve">&#10003; Approve</button>
        <button class="btn-skip-agent" id="btn-skip">Skip</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentRun = null;
    let selectedStep = null;
    let selectedFile = null;

    const STEP_ICONS = {
      pending:'○', running:'⟳', completed:'✓', failed:'✗',
      skipped:'⊘', 'awaiting-approval':'⏸'
    };

    // --- event wiring ---
    document.getElementById('btn-stop').addEventListener('click',
      () => vscode.postMessage({ type:'stop' }));
    document.getElementById('btn-approve').addEventListener('click',
      () => vscode.postMessage({ type:'approve' }));
    document.getElementById('btn-skip').addEventListener('click',
      () => vscode.postMessage({ type:'skipAgent' }));
    document.getElementById('btn-accept-all').addEventListener('click',
      () => vscode.postMessage({ type:'acceptAll' }));
    document.getElementById('btn-reject-all').addEventListener('click',
      () => vscode.postMessage({ type:'rejectAll' }));
    document.getElementById('mode-select').addEventListener('change', (e) =>
      vscode.postMessage({ type:'modeChange', mode: e.target.value }));

    window.addEventListener('message', (event) => {
      if (event.data.type === 'update') { currentRun = event.data.run; render(); }
    });

    // --- rendering ---
    function render() {
      if (!currentRun) return;
      const run = currentRun;

      // Pipeline bar
      document.getElementById('run-name').textContent = run.name;
      document.getElementById('mode-select').value = run.mode;
      const pipEl = document.getElementById('pip-steps');
      pipEl.innerHTML = '';
      for (const s of run.steps) {
        const sp = document.createElement('span');
        sp.className = 'step-pip ' + s.status;
        // textContent only — never innerHTML
        sp.textContent = (STEP_ICONS[s.status] || '○') + ' ' + s.agentName;
        pipEl.appendChild(sp);
      }

      // Step list
      const listEl = document.getElementById('step-list');
      listEl.innerHTML = '';
      for (const s of run.steps) {
        const row = document.createElement('div');
        row.className = 'step-row' + (selectedStep === s.agentName ? ' selected' : '');
        const icon = document.createElement('span'); icon.className = 'step-icon';
        icon.textContent = STEP_ICONS[s.status] || '○';
        const name = document.createElement('span'); name.className = 'step-name';
        name.textContent = s.agentName;
        const dur = document.createElement('span'); dur.className = 'step-dur';
        if (s.startTime && s.endTime)
          dur.textContent = ((s.endTime - s.startTime) / 1000).toFixed(1) + 's';
        row.append(icon, name, dur);
        row.addEventListener('click', () => { selectedStep = s.agentName; render(); });
        listEl.appendChild(row);
      }

      // File list + diff
      const files = run.filesChanged || [];
      const hasDiffs = files.length > 0;
      document.getElementById('btn-accept-all').style.display = hasDiffs ? '' : 'none';
      document.getElementById('btn-reject-all').style.display = hasDiffs ? '' : 'none';

      const fileListEl = document.getElementById('file-list');
      fileListEl.innerHTML = '';
      if (hasDiffs) {
        document.getElementById('diff-pane-title').textContent =
          'File changes (' + files.length + ')';
        for (const fc of files) {
          const row = document.createElement('div');
          row.className = 'file-row' + (selectedFile === fc.filePath ? ' selected' : '');
          const st = document.createElement('span');
          st.className = 'file-status ' + fc.status;
          st.textContent = fc.status === 'accepted' ? '✓' : fc.status === 'rejected' ? '✗' : '●';
          const fp = document.createElement('span'); fp.className = 'file-path';
          fp.textContent = fc.filePath.split('/').pop() || fc.filePath;
          fp.title = fc.filePath;
          const acts = document.createElement('span'); acts.className = 'file-actions';
          if (fc.status === 'pending') {
            const ab = document.createElement('button'); ab.className = 'btn-sm-accept';
            ab.textContent = '✓';
            ab.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type:'acceptFile', filePath: fc.filePath });
            });
            const rb = document.createElement('button'); rb.className = 'btn-sm-reject';
            rb.textContent = '✗';
            rb.addEventListener('click', (e) => {
              e.stopPropagation();
              vscode.postMessage({ type:'rejectFile', filePath: fc.filePath });
            });
            acts.append(ab, rb);
          }
          row.append(st, fp, acts);
          row.addEventListener('click', () => { selectedFile = fc.filePath; render(); });
          fileListEl.appendChild(row);
        }
        // Diff for selected file
        if (!selectedFile && files.length) selectedFile = files[0].filePath;
        const fc = files.find(f => f.filePath === selectedFile) || files[0];
        const diffEl = document.getElementById('diff-content');
        diffEl.innerHTML = '';
        if (fc) renderDiff(diffEl, fc.oldContent || '', fc.newContent || '');
      } else {
        // Show step output in diff pane
        const step = run.steps.find(s => s.agentName === selectedStep);
        const title = step
          ? (step.status === 'running' ? step.agentName + ' running…'
             : step.agentName + ' · ' + step.status)
          : 'Waiting…';
        document.getElementById('diff-pane-title').textContent = title;
        const diffEl = document.getElementById('diff-content');
        diffEl.innerHTML = '';
        if (step && step.output) {
          const pre = document.createElement('pre'); pre.className = 'output-pre';
          pre.textContent = step.output; // textContent — XSS safe
          diffEl.appendChild(pre);
        } else {
          const hint = document.createElement('div'); hint.id = 'empty-hint';
          hint.textContent = 'No output yet';
          diffEl.appendChild(hint);
        }
      }

      // Approval bar
      const bar = document.getElementById('approval-bar');
      if (run.status === 'awaiting-approval') {
        bar.className = 'approval-bar visible';
        const waiting = run.steps.find(s => s.status === 'awaiting-approval');
        document.getElementById('approval-msg').textContent =
          '⏸ ' + (waiting ? waiting.agentName : 'agent') +
          ' is ready to run — approve to continue';
      } else {
        bar.className = 'approval-bar';
      }
    }

    function renderDiff(container, oldContent, newContent) {
      const oldLines = oldContent.split('\\n');
      const newLines = newContent.split('\\n');
      for (let i = 0; i < Math.min(oldLines.length, newLines.length); i++) {
        if (oldLines[i] !== newLines[i]) {
          addLine(container, '- ' + oldLines[i], 'del');
          addLine(container, '+ ' + newLines[i], 'add');
        } else {
          addLine(container, '  ' + oldLines[i], 'ctx');
        }
      }
      for (let i = oldLines.length; i < newLines.length; i++)
        addLine(container, '+ ' + newLines[i], 'add');
      for (let i = newLines.length; i < oldLines.length; i++)
        addLine(container, '- ' + oldLines[i], 'del');
    }

    function addLine(container, text, cls) {
      const span = document.createElement('span');
      span.className = 'diff-line ' + cls;
      span.textContent = text; // textContent — never innerHTML
      container.appendChild(span);
    }
  </script>
</body>
</html>`;
  }
}
