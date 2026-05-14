/**
 * TeamPanel: VS Code WebviewPanel for the agent team control room.
 *
 * Shows live execution state: agent roster, streaming output, shared plan,
 * and metrics. Users can stop runs, skip blocked agents, and retry failures.
 */
import * as vscode from "vscode";
import type { TeamRunState } from "../agent/team-definition";

export type TeamPanelMessage =
  | { type: "teamStop" }
  | { type: "teamSkipAgent"; agentId: string }
  | { type: "teamRetryAgent"; agentId: string };

export class TeamPanel {
  private panel: vscode.WebviewPanel;
  private messageHandler: ((msg: TeamPanelMessage) => void) | undefined;
  private _disposed = false;

  constructor(extensionUri: vscode.Uri, teamName: string) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.teamPanel",
      `👥 ${teamName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    this.panel.webview.html = this.renderHtml(teamName);
    this.panel.webview.onDidReceiveMessage((msg: TeamPanelMessage) => {
      this.messageHandler?.(msg);
    });
    this.panel.onDidDispose(() => {
      this._disposed = true;
    });
  }

  onMessage(handler: (msg: TeamPanelMessage) => void): void {
    this.messageHandler = handler;
  }

  update(state: TeamRunState): void {
    if (this._disposed) return;
    void this.panel.webview.postMessage({ type: "teamUpdate", state });
  }

  streamChunk(agentId: string, chunk: string): void {
    if (this._disposed) return;
    void this.panel.webview.postMessage({
      type: "agentStream",
      agentId,
      chunk,
    });
  }

  setTitle(title: string): void {
    if (this._disposed) return;
    this.panel.title = `👥 ${title}`;
  }

  dispose(): void {
    this._disposed = true;
    this.panel.dispose();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  private renderHtml(teamName: string): string {
    const nonce =
      Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--vscode-font-family);font-size:13px;background:var(--vscode-editor-background);color:var(--vscode-foreground);display:flex;flex-direction:column;height:100vh;overflow:hidden}
/* Toolbar */
.tb{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0}
.tb-title{flex:1;font-weight:700;font-size:14px}
.tb-meta{font-size:11px;opacity:.65}
.btn{padding:3px 10px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-stop{background:var(--vscode-errorForeground);color:#fff;border-color:transparent}
/* Main layout */
.main{display:flex;flex:1;overflow:hidden}
/* Roster */
.roster{width:220px;flex-shrink:0;border-right:1px solid var(--vscode-panel-border);display:flex;flex-direction:column;overflow-y:auto}
.ra{padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-panel-border);transition:background .1s}
.ra:hover,.ra.active{background:var(--vscode-list-activeSelectionBackground)}
.ra-name{font-weight:600;font-size:12px;display:flex;align-items:center;gap:6px}
.ra-status{font-size:10px;opacity:.6;margin-top:2px;text-transform:uppercase}
.ra-warn{font-size:10px;color:var(--vscode-editorWarning-foreground);margin-top:2px}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-pending{background:var(--vscode-disabledForeground)}
.dot-running{background:var(--vscode-progressBar-background);animation:pulse 1s infinite}
.dot-done{background:#4ec9b0}
.dot-failed{background:var(--vscode-errorForeground)}
.dot-skipped{background:var(--vscode-disabledForeground);opacity:.35}
.dot-blocked{background:var(--vscode-editorWarning-foreground);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.ra-acts{display:flex;gap:4px;margin-top:5px}
.ra-act{font-size:10px;padding:1px 6px;background:none;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;color:var(--vscode-foreground)}
/* Metrics strip */
.metrics{padding:8px 10px;border-top:1px solid var(--vscode-panel-border);font-size:10px;opacity:.7;margin-top:auto}
.mrow{display:flex;justify-content:space-between;margin-bottom:1px}
/* Output pane */
.out{flex:1;display:flex;flex-direction:column;overflow:hidden}
.out-hdr{padding:6px 12px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-panel-border);font-size:11px;font-weight:600;flex-shrink:0}
.out-body{flex:1;overflow-y:auto;padding:10px 14px;font-family:var(--vscode-editor-font-family,monospace);font-size:12px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
/* Shared plan */
.plan{padding:8px 12px;border-top:1px solid var(--vscode-panel-border);font-size:11px;max-height:140px;overflow-y:auto;flex-shrink:0}
.plan-title{font-weight:600;margin-bottom:4px;opacity:.6;font-size:10px;text-transform:uppercase}
.pi{display:flex;gap:6px;margin:2px 0}
/* Blocked banner */
.blocked-banner{background:var(--vscode-inputValidation-warningBackground,rgba(255,200,0,.15));border:1px solid var(--vscode-inputValidation-warningBorder,#ff0);padding:8px 12px;margin:8px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<div class="tb">
  <span class="tb-title">👥 ${this.escHtml(teamName)}</span>
  <span class="tb-meta" id="meta">Starting…</span>
  <button class="btn btn-stop" id="stopBtn" onclick="stop()">■ Stop</button>
</div>
<div class="main">
  <div class="roster" id="roster"></div>
  <div class="out">
    <div class="out-hdr" id="outHdr">Select an agent to view output</div>
    <div class="out-body" id="outBody"></div>
    <div class="plan" id="plan" style="display:none">
      <div class="plan-title">Shared plan</div>
      <div id="planItems"></div>
    </div>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let state = null;
let sel = null;
const streams = {};

const DOTS = {pending:'dot-pending',running:'dot-running',done:'dot-done',failed:'dot-failed',skipped:'dot-skipped',blocked:'dot-blocked'};
const ICONS = {pending:'○',running:'●',done:'✓',failed:'✗',skipped:'⊘',blocked:'⚠'};

function stop() { vscode.postMessage({type:'teamStop'}); }
function skipAgent(id,e) { e.stopPropagation(); vscode.postMessage({type:'teamSkipAgent',agentId:id}); }
function retryAgent(id,e) { e.stopPropagation(); vscode.postMessage({type:'teamRetryAgent',agentId:id}); }

function esc(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderRoster() {
  if (!state) return;
  const r = document.getElementById('roster');
  r.innerHTML = '';
  for (const a of state.agents) {
    const elapsed = a.startTime
      ? a.endTime
        ? ((a.endTime - a.startTime)/1000).toFixed(1)+'s'
        : ((Date.now() - a.startTime)/1000).toFixed(0)+'s'
      : '';
    const div = document.createElement('div');
    div.className = 'ra' + (sel===a.id?' active':'');
    div.onclick = () => selectAgent(a.id);
    div.innerHTML =
      '<div class="ra-name"><span class="dot '+(DOTS[a.status]||'')+'"></span>'
      +esc(a.name)
      +(elapsed?'<span style="margin-left:auto;opacity:.45;font-size:10px">'+esc(elapsed)+'</span>':'')
      +'</div>'
      +'<div class="ra-status">'+esc(a.status)+'</div>'
      +(a.validationWarnings&&a.validationWarnings.length?'<div class="ra-warn">⚠ '+a.validationWarnings.length+' warning(s)</div>':'');
    if (a.status==='blocked'||a.status==='failed') {
      const acts = document.createElement('div');
      acts.className = 'ra-acts';
      const skip = document.createElement('button');
      skip.className='ra-act'; skip.textContent='Skip';
      skip.onclick = (e)=>skipAgent(a.id,e);
      const retry = document.createElement('button');
      retry.className='ra-act'; retry.textContent='Retry';
      retry.onclick = (e)=>retryAgent(a.id,e);
      acts.append(skip,retry);
      div.append(acts);
    }
    r.append(div);
  }
  const done = state.agents.filter(a=>a.status==='done').length;
  const total = state.agents.length;
  const elapsed = state.startTime ? ((Date.now()-state.startTime)/1000).toFixed(0)+'s' : '—';
  const m = document.createElement('div');
  m.className='metrics';
  m.innerHTML='<div class="mrow"><span>Agents</span><span>'+done+'/'+total+'</span></div>'
    +'<div class="mrow"><span>Time</span><span>'+elapsed+'</span></div>'
    +'<div class="mrow"><span>Tokens</span><span>'+(state.totalTokens||0).toLocaleString()+'</span></div>'
    +'<div class="mrow"><span>Cost</span><span>~$0.00</span></div>';
  r.append(m);
}

function selectAgent(id) {
  sel = id;
  renderRoster();
  renderOutput();
}

function renderOutput() {
  if (!state||!sel) return;
  const a = state.agents.find(x=>x.id===sel);
  if (!a) return;
  document.getElementById('outHdr').textContent = a.name+' — '+a.status;
  const body = document.getElementById('outBody');
  if (a.status==='blocked') {
    body.innerHTML='<div class="blocked-banner"><strong>⚠ BLOCKED</strong><br>'+esc(a.blockedReason||'Agent could not complete task')+'</div>';
    return;
  }
  body.textContent = streams[sel] || a.output || '(no output yet)';
}

function renderPlan() {
  if (!state) return;
  const snap = state.sharedMemorySnapshot||{};
  const planKey = Object.keys(snap).find(k=>k==='plan'||k.includes('plan'));
  const panel = document.getElementById('plan');
  if (!planKey) { panel.style.display='none'; return; }
  let assignments;
  try {
    const parsed = JSON.parse(snap[planKey]||'{}');
    assignments = parsed.assignments||parsed.tasks||parsed;
  } catch { panel.style.display='none'; return; }
  if (!assignments||typeof assignments!=='object') { panel.style.display='none'; return; }
  panel.style.display='';
  const items = document.getElementById('planItems');
  items.innerHTML='';
  const statMap={};
  for (const a of (state.agents||[])) statMap[a.id]=a.status;
  for (const [k,v] of Object.entries(assignments)) {
    if (!v) continue;
    const d=document.createElement('div'); d.className='pi';
    const status=statMap[k]||'pending';
    d.innerHTML='<span>'+(ICONS[status]||'○')+'</span><span>'+esc(k)+'</span><span style="opacity:.55"> — '+esc(String(v).slice(0,70))+'</span>';
    items.append(d);
  }
}

function updateMeta() {
  if (!state) return;
  const STATUS_TEXT={running:'Running…',paused:'Paused — agent blocked',completed:'✓ Completed',failed:'Failed',stopped:'Stopped'};
  document.getElementById('meta').textContent=STATUS_TEXT[state.status]||state.status;
  document.getElementById('stopBtn').style.display=['completed','stopped'].includes(state.status)?'none':'';
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type==='teamUpdate') {
    state = msg.state;
    if (!sel) {
      const running = state.agents.find(a=>a.status==='running');
      if (running) sel = running.id;
      else if (state.agents.length) sel = state.agents[0].id;
    }
    renderRoster(); renderOutput(); renderPlan(); updateMeta();
  } else if (msg.type==='agentStream') {
    streams[msg.agentId]=(streams[msg.agentId]||'')+msg.chunk;
    if (sel===msg.agentId) renderOutput();
  }
});
</script>
</body>
</html>`;
  }

  /** HTML-escape a string for safe injection into the panel title. */
  private escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
