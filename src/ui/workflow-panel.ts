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
  | { type: "acceptHunk"; filePath: string; hunkIndex: number }
  | { type: "rejectHunk"; filePath: string; hunkIndex: number }
  | { type: "modeChange"; mode: string };

export class WorkflowPanel {
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private messageHandlers: Array<(msg: PanelMessage) => void> = [];
  private disposed = false;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
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

  private generateNonce(): string {
    const { randomBytes } = require("crypto") as typeof import("crypto");
    return randomBytes(32).toString("base64url");
  }

  private renderHtml(): string {
    // Cryptographic nonce — node crypto randomBytes, base64url (#112 parity
    // with ChatViewProvider.getHtml; Math.random is not a CSP-grade nonce).
    const nonce = this.generateNonce();

    // Resolve the stylesheet from webview-ui/dist (copied there by
    // scripts/copy-assets.mjs). The strict CSP below has no 'unsafe-inline',
    // so styles must come from a linked webview resource. In tests the URI
    // resolution may fail — the HTML still renders, just unstyled.
    let cssUri = "";
    try {
      cssUri = this.panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            this.extensionUri,
            "webview-ui",
            "dist",
            "workflow.css",
          ),
        )
        .toString();
    } catch {
      cssUri = "";
    }

    const cspSource = this.panel.webview.cspSource ?? "vscode-resource:";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; connect-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;"/>
  ${cssUri ? `<link href="${cssUri}" rel="stylesheet" />` : ""}
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

    // NOTE: computeLCS and splitHunks duplicate the logic in src/utils/diff-utils.ts.
    // This is intentional — the webview runs in a sandboxed iframe with no module
    // imports, so the diff logic must be inlined. Keep both versions in sync.
    function computeLCS(a, b) {
      const m = a.length, n = b.length;
      const dp = Array.from({length: m+1}, () => new Array(n+1).fill(0));
      for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
          dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
      const pairs = [];
      let i = m, j = n;
      while (i > 0 && j > 0) {
        if (a[i-1]===b[j-1]) { pairs.unshift([i-1,j-1]); i--; j--; }
        else if (dp[i-1][j] > dp[i][j-1]) i--;
        else j--;
      }
      return pairs;
    }
    function splitHunks(oldText, newText) {
      if (oldText === newText) return [];
      const a = oldText.split('\n'), b = newText.split('\n');
      const lcs = computeLCS(a, b);
      const edits = [];
      let ia = 0, ib = 0;
      for (const [ai, bi] of lcs) {
        while (ia < ai) { edits.push({t:'del', l:a[ia++]}); }
        while (ib < bi) { edits.push({t:'ins', l:b[ib++]}); }
        edits.push({t:'eq', l:a[ia++]}); ib++;
      }
      while (ia < a.length) { edits.push({t:'del', l:a[ia++]}); }
      while (ib < b.length) { edits.push({t:'ins', l:b[ib++]}); }
      const hunks = [];
      let oldPos = 0;
      for (let i = 0; i < edits.length; ) {
        if (edits[i].t === 'eq') { oldPos++; i++; continue; }
        const start = oldPos;
        const dels = [], ins = [];
        while (i < edits.length && edits[i].t !== 'eq') {
          if (edits[i].t === 'del') { dels.push(edits[i].l); oldPos++; }
          else { ins.push(edits[i].l); }
          i++;
        }
        hunks.push({changeStartOld: start, changeCountOld: dels.length, oldLines: dels, newLines: ins});
      }
      return hunks;
    }
    function renderDiff(container, oldContent, newContent) {
      container.innerHTML = '';
      if (oldContent === newContent) {
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:8px;opacity:.5;font-size:11px';
        msg.textContent = 'No changes';
        container.appendChild(msg);
        return;
      }
      const hunks = splitHunks(oldContent, newContent);
      if (hunks.length === 0) {
        const msg = document.createElement('div');
        msg.style.cssText = 'padding:8px;opacity:.5;font-size:11px';
        msg.textContent = 'Content identical';
        container.appendChild(msg);
        return;
      }
      hunks.forEach((hunk, idx) => {
        const hunkEl = document.createElement('div');
        hunkEl.className = 'hunk';
        hunkEl.dataset.idx = String(idx);
        hunk.oldLines.forEach(line => { const s = document.createElement('span'); s.className = 'diff-line del'; s.textContent = '- ' + line; hunkEl.appendChild(s); });
        hunk.newLines.forEach(line => { const s = document.createElement('span'); s.className = 'diff-line add'; s.textContent = '+ ' + line; hunkEl.appendChild(s); });
        const btns = document.createElement('div');
        btns.className = 'hunk-actions';
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'hunk-btn accept';
        acceptBtn.title = 'Accept this change';
        acceptBtn.textContent = '✓ Accept';
        const rejectBtn = document.createElement('button');
        rejectBtn.className = 'hunk-btn reject';
        rejectBtn.title = 'Reject this change';
        rejectBtn.textContent = '✗ Reject';
        acceptBtn.addEventListener('click', () => {
          hunkEl.classList.add('accepted'); hunkEl.classList.remove('rejected');
          vscode.postMessage({ type: 'acceptHunk', filePath: selectedFile, hunkIndex: idx });
        });
        rejectBtn.addEventListener('click', () => {
          hunkEl.classList.add('rejected'); hunkEl.classList.remove('accepted');
          vscode.postMessage({ type: 'rejectHunk', filePath: selectedFile, hunkIndex: idx });
        });
        btns.appendChild(acceptBtn); btns.appendChild(rejectBtn);
        hunkEl.appendChild(btns);
        container.appendChild(hunkEl);
      });
    }
  </script>
</body>
</html>`;
  }
}
