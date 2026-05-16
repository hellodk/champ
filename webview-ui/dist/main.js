/*
 * Champ chat UI — vanilla JS webview entry point.
 *
 * Layout (Chat UI v2 — Phase A):
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Top header                               │
 *   │   Champ                       [+] [⚙] [?]│
 *   │   <provider:model> indicator             │
 *   ├──────────────────────────────────────────┤
 *   │ Messages                                 │
 *   │  ...                                     │
 *   ├──────────────────────────────────────────┤
 *   │ Input area                               │
 *   │  [skill autocomplete dropdown]           │
 *   │  textarea                                │
 *   │  ── bottom bar ──                        │
 *   │  [Mode ▾] [Model ▾]        [Cancel][Send]│
 *   └──────────────────────────────────────────┘
 *
 * Handles message routing between the host and the DOM. Intentionally
 * framework-free to keep the bundle tiny and avoid a webview build
 * step.
 */
(function () {
  'use strict';

  // VS Code webview API handle — globally available via window.
  const vscode = acquireVsCodeApi();

  const state = {
    mode: 'agent',
    messages: /** @type {Array<{role: string, text: string, toolCalls?: Array<any>}>} */ ([]),
    streaming: false,
    streamingHasText: false,
    currentAssistantMessage: /** @type {HTMLElement|null} */ (null),
    /** Messages typed while a response is in-flight; sent in order after stream ends. */
    messageQueue: /** @type {string[]} */ ([]),
    /** Sent message history for up/down arrow navigation (terminal-style). */
    inputHistory: /** @type {string[]} */ ([]),
    /** Current position in inputHistory when navigating. -1 = not navigating. */
    historyIndex: -1,
    /** Draft saved when the user starts navigating history. */
    historyDraft: '',
    /** Active session ID, used to persist per-session input history. */
    activeSessionId: null,
    /** @type {Array<{name: string, description: string}>} */
    skillSuggestions: [],
    /** Index of the highlighted dropdown row, -1 when closed. */
    skillHighlight: -1,
    /** Last prefix we asked the host for, used to ignore stale responses. */
    lastSkillPrefix: null,
    /** Last providerStatus we received — used to render the header indicator
     *  and the bottom-bar model dropdown. */
    providerStatus: {
      state: 'loading',
      providerName: undefined,
      modelName: undefined,
      errorMessage: undefined,
      available: /** @type {Array<{providerName: string, modelName: string, label: string}>} */ ([]),
    },
    /** Whether YOLO mode (skip approval prompts) is enabled. */
    yoloMode: false,
    /** Whether inline autocomplete is enabled. */
    autocompleteEnabled: true,
  };

  // Tour / onboarding hints (sessionStorage-backed, one-time per session)
  let tourShown = sessionStorage.getItem('champ-tour-shown') === 'true';
  let modeTooltipShown = sessionStorage.getItem('champ-mode-tip') === 'true';

  // -------------------------------------------------------------------
  // DOM construction — top header
  // -------------------------------------------------------------------

  const root = document.getElementById('app');

  // Top header: app title + model indicator on the left, icon buttons on the right.
  const header = el('div', { class: 'header' });
  const headerLeft = el('div', { class: 'header-left' });
  const headerTitleRow = el('div', { class: 'header-title-row' });
  const headerTitle = el('div', { class: 'header-title' }, ['Champ']);
  const v = typeof window.__CHAMP_VERSION__ === 'string' && window.__CHAMP_VERSION__ ? window.__CHAMP_VERSION__ : '';
  const headerVersion = el('span', { class: 'header-version' }, [v ? `v${v}` : '']);
  headerTitleRow.append(headerTitle, headerVersion);
  const headerSubtitle = el('div', { class: 'header-subtitle' }, ['loading…']);
  headerLeft.append(headerTitleRow, headerSubtitle);

  const headerRight = el('div', { class: 'header-right' });
  const newChatBtn = iconButton('codicon-add', 'New chat', () => {
    vscode.postMessage({ type: 'newSessionRequest' });
  });
  const historyBtn = iconButton('codicon-history', 'Chat history', (ev) => {
    ev.stopPropagation();
    // Toggle the tab overflow menu which shows all sessions.
    if (tabOverflowMenu.hidden) {
      renderOverflowMenu();
      tabOverflowMenu.removeAttribute('hidden');
    } else {
      tabOverflowMenu.setAttribute('hidden', 'true');
    }
  });
  // Settings panel — toggled by the gear icon in the header.
  const settingsPanel = el('div', { class: 'settings-panel' });
  settingsPanel.setAttribute('hidden', 'true');

  function renderSettingsPanel() {
    settingsPanel.innerHTML = '';
    const ps = state.providerStatus;
    const providerRow = el('div', { class: 'settings-row' });
    const providerLabel = el('span', { class: 'settings-label' }, ['Provider']);
    const providerVal = el('span', { class: 'settings-value' }, [
      ps ? `${ps.providerName || 'none'} — ${ps.modelName || ''}` : 'Not configured'
    ]);
    const switchBtn = el('button', { class: 'settings-action-btn' }, ['Switch…']);
    switchBtn.addEventListener('click', () => vscode.postMessage({ type: 'openSettingsRequest' }));
    providerRow.append(providerLabel, providerVal, switchBtn);

    const yoloRow = el('div', { class: 'settings-row' });
    const yoloLabel = el('span', { class: 'settings-label' }, ['YOLO mode']);
    const yoloDesc = el('span', { class: 'settings-desc' }, ['Skip approval prompts']);
    const yoloToggle = el('button', { class: `settings-toggle ${state.yoloMode ? 'settings-toggle-on' : ''}` }, [state.yoloMode ? 'ON' : 'OFF']);
    yoloToggle.addEventListener('click', () => {
      state.yoloMode = !state.yoloMode;
      vscode.postMessage({ type: 'setYoloMode', enabled: state.yoloMode });
      renderSettingsPanel();
    });
    yoloRow.append(yoloLabel, yoloDesc, yoloToggle);

    const acRow = el('div', { class: 'settings-row' });
    const acLabel = el('span', { class: 'settings-label' }, ['Autocomplete']);
    const acDesc = el('span', { class: 'settings-desc' }, ['Inline code suggestions']);
    const acToggle = el('button', { class: `settings-toggle ${state.autocompleteEnabled !== false ? 'settings-toggle-on' : ''}` }, [state.autocompleteEnabled !== false ? 'ON' : 'OFF']);
    acToggle.addEventListener('click', () => {
      state.autocompleteEnabled = state.autocompleteEnabled === false ? true : false;
      vscode.postMessage({ type: 'setAutocomplete', enabled: state.autocompleteEnabled !== false });
      renderSettingsPanel();
    });
    acRow.append(acLabel, acDesc, acToggle);

    settingsPanel.append(providerRow, yoloRow, acRow);
  }

  const settingsBtn = iconButton('codicon-settings-gear', 'Settings', () => {
    if (settingsPanel.hasAttribute('hidden')) {
      settingsPanel.removeAttribute('hidden');
      renderSettingsPanel();
    } else {
      settingsPanel.setAttribute('hidden', 'true');
    }
  });
  const helpBtn = iconButton('codicon-question', 'Show user guide', () => {
    vscode.postMessage({ type: 'showHelpRequest' });
  });
  headerRight.append(newChatBtn, historyBtn, settingsBtn, helpBtn);

  header.append(headerLeft, headerRight);

  // -------------------------------------------------------------------
  // DOM construction — tab bar (browser-style session tabs)
  // -------------------------------------------------------------------

  const tabBar = el('div', { class: 'tab-bar' });
  const tabContainer = el('div', { class: 'tab-container' });
  const tabAddBtn = el('button', { class: 'tab-add', title: 'New chat' });
  tabAddBtn.append(codicon('add'));
  tabAddBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSessionRequest' });
  });
  // Overflow menu for when there are too many tabs.
  const tabOverflowBtn = el('button', { class: 'tab-overflow', title: 'All sessions' });
  tabOverflowBtn.append(codicon('list-unordered'));
  const tabOverflowMenu = el('div', { class: 'tab-overflow-menu', hidden: 'true' });
  tabOverflowBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (tabOverflowMenu.hidden) {
      renderOverflowMenu();
      tabOverflowMenu.removeAttribute('hidden');
    } else {
      tabOverflowMenu.setAttribute('hidden', 'true');
    }
  });
  document.addEventListener('click', () => tabOverflowMenu.setAttribute('hidden', 'true'));

  tabBar.append(tabContainer, tabAddBtn, tabOverflowBtn, tabOverflowMenu);

  // Recently-deleted sessions — kept for 10 minutes as a soft-delete safety net.
  const recentlyDeleted = []; // { id, label, deletedAt }

  const trashStrip = el('div', { class: 'trash-strip' });

  function renderTrashStrip() {
    trashStrip.innerHTML = '';
    // Only show entries from last 10 minutes.
    const now = Date.now();
    const recent = recentlyDeleted.filter(e => now - e.deletedAt < 10 * 60 * 1000);
    if (recent.length === 0) return;
    const label = el('div', { class: 'trash-label' }, ['Recently deleted']);
    trashStrip.append(label);
    for (const entry of recent) {
      const row = el('div', { class: 'trash-row' });
      const name = el('span', { class: 'trash-name' }, [(entry.label || 'New chat').slice(0, 28)]);
      const restoreBtn = el('button', { class: 'trash-restore' }, ['Restore']);
      restoreBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'newSessionRequest', label: entry.label });
        recentlyDeleted.splice(recentlyDeleted.indexOf(entry), 1);
        renderTrashStrip();
      });
      row.append(name, restoreBtn);
      trashStrip.append(row);
    }
  }

  // Append trashStrip right after the tab bar (below tabs).
  tabBar.append(trashStrip);

  let lastSessionData = { sessions: [], activeSessionId: null };

  function renderSessionList(sessions, activeSessionId) {
    lastSessionData = { sessions, activeSessionId };
    tabContainer.innerHTML = '';
    if (!sessions || sessions.length === 0) return;
    for (const s of sessions) {
      const tab = el('div', { class: `tab${s.id === activeSessionId ? ' active' : ''}` });

      // State dot badge — shown only for non-idle, non-completed states.
      if (s.state === 'running') {
        tab.append(el('span', { class: 'session-dot session-dot-running', title: 'Running' }));
      } else if (s.state === 'errored') {
        tab.append(el('span', { class: 'session-dot session-dot-error', title: 'Error' }));
      } else if (s.state === 'aborted') {
        tab.append(el('span', { class: 'session-dot session-dot-aborted', title: 'Aborted' }));
      }

      const label = el('span', { class: 'tab-label' }, [
        (s.label || 'New chat').slice(0, 22) + ((s.label || '').length > 22 ? '…' : '')
      ]);
      const closeBtn = el('button', { class: 'tab-close', title: 'Close' }, ['×']);
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete "${(s.label || 'New chat').slice(0, 40)}"? This cannot be undone.`)) return;
        // Capture label before deleting for soft-delete recovery.
        const sessionLabel = s.label || 'New chat';
        recentlyDeleted.unshift({ id: s.id, label: sessionLabel, deletedAt: Date.now() });
        if (recentlyDeleted.length > 5) recentlyDeleted.pop();
        renderTrashStrip();
        vscode.postMessage({ type: 'deleteSessionRequest', sessionId: s.id });
      });
      tab.append(label, closeBtn);
      tab.addEventListener('click', () => {
        if (s.id !== activeSessionId) {
          vscode.postMessage({ type: 'switchSessionRequest', sessionId: s.id });
        }
      });
      tabContainer.append(tab);
    }
  }

  function renderOverflowMenu() {
    tabOverflowMenu.innerHTML = '';
    const sessions = lastSessionData.sessions || [];
    if (sessions.length === 0) {
      tabOverflowMenu.append(el('div', { class: 'overflow-item' }, ['No sessions']));
      return;
    }
    for (const s of sessions) {
      const isActive = s.id === lastSessionData.activeSessionId;
      const item = el('div', { class: `overflow-item${isActive ? ' active' : ''}` });
      item.append(el('span', {}, [s.label || 'New chat']));
      item.addEventListener('click', (ev) => {
        ev.stopPropagation();
        tabOverflowMenu.setAttribute('hidden', 'true');
        if (!isActive) vscode.postMessage({ type: 'switchSessionRequest', sessionId: s.id });
      });
      tabOverflowMenu.append(item);
    }
  }

  // -------------------------------------------------------------------
  // DOM construction — action bar (below tabs, above messages)
  // -------------------------------------------------------------------

  const actionBar = el('div', { class: 'action-bar' });
  let compactMode = false;

  function actionBtn(label, title, onClick) {
    const btn = el('button', { class: 'action-btn', title });
    if (label && label.startsWith('codicon-')) {
      btn.append(codicon(label.replace('codicon-', '')));
    } else {
      btn.append(document.createTextNode(label || ''));
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  const compactBtn = actionBtn('codicon-list-flat', 'Compact view', () => {
    compactMode = !compactMode;
    messagesContainer.classList.toggle('compact', compactMode);
    compactBtn.classList.toggle('active', compactMode);
  });
  const deleteChatBtn = actionBtn('codicon-trash', 'Delete chat', () => {
    const id = lastSessionData.activeSessionId;
    if (!id) return;
    if (!confirm('Delete this chat? All messages will be lost and cannot be recovered.')) return;
    // Find the session label for the soft-delete strip.
    const activeSession = (lastSessionData.sessions || []).find(s => s.id === id);
    const sessionLabel = activeSession ? (activeSession.label || 'New chat') : 'New chat';
    recentlyDeleted.unshift({ id, label: sessionLabel, deletedAt: Date.now() });
    if (recentlyDeleted.length > 5) recentlyDeleted.pop();
    renderTrashStrip();
    vscode.postMessage({ type: 'deleteSessionRequest', sessionId: id });
  });
  const copyChatBtn = actionBtn('codicon-copy', 'Copy chat', () => {
    const text = state.messages
      .map(m => `${m.role}: ${m.text}`)
      .join('\n\n');
    navigator.clipboard.writeText(text).catch(() => {});
  });
  const actionSpacer = el('div', { class: 'action-spacer' });

  // MCP status panel — toggled by the plug button in the action bar.
  const mcpPanel = el('div', { class: 'mcp-panel' });
  mcpPanel.setAttribute('hidden', 'true');

  function renderMcpPanel(servers) {
    mcpPanel.innerHTML = '';
    if (!servers || servers.length === 0) {
      const empty = el('div', { class: 'mcp-empty' });
      empty.append(
        el('p', {}, ['No MCP servers configured.']),
        el('p', { class: 'mcp-help' }, ['Add servers to ']),
      );
      const code = el('code', {}, ['.champ/config.yaml']);
      const link = el('span', { class: 'mcp-help-link', title: 'Open config file' }, ['Open config']);
      link.addEventListener('click', () => vscode.postMessage({ type: 'openSettingsRequest' }));
      empty.querySelector('.mcp-help').append(code, document.createTextNode(' — '), link);
      empty.append(el('p', { class: 'mcp-help' }, ['Example: npx @modelcontextprotocol/server-github']));
      mcpPanel.append(empty);
    } else {
      for (const s of servers) {
        const row = el('div', { class: 'mcp-row' });
        const dot = el('span', { class: `mcp-dot ${s.connected ? 'mcp-dot-ok' : 'mcp-dot-err'}` });
        const name = el('span', { class: 'mcp-name' }, [s.name]);
        const info = el('span', { class: 'mcp-info' }, [
          s.connected
            ? `${s.toolCount} tool${s.toolCount !== 1 ? 's' : ''}`
            : (s.error
                ? `Error: ${s.error.slice(0, 60)}`
                : 'Not connected — check server command in config')
        ]);
        const reloadTitle = s.connected ? 'Reload server (full config reload)' : 'Reconnect server';
        const reloadBtn = el('button', { class: 'mcp-reload', title: reloadTitle }, ['↺']);
        reloadBtn.addEventListener('click', () => vscode.postMessage({ type: 'reloadMcpServer', serverName: s.name }));
        const removeBtn = el('button', { class: 'mcp-reload mcp-remove', title: 'Remove this server' }, ['✕']);
        removeBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'mcpConfigSave', server: { name: s.name, transport: 'stdio' }, action: 'delete' });
        });
        row.append(dot, name, info, reloadBtn, removeBtn);
        mcpPanel.append(row);
      }
    }
    // Add server button
    const addBtn = el('button', { class: 'mcp-add-btn', title: 'Add an MCP server' }, ['+ Add server']);
    addBtn.addEventListener('click', () => {
      const existingForm = mcpPanel.querySelector('#mcp-add-form');
      if (existingForm) { existingForm.remove(); return; }
      const formEl = el('div', { id: 'mcp-add-form', class: 'mcp-form' });
      const titleEl = el('div', { class: 'mcp-form-title' }, ['New MCP server']);
      const nameInput = el('input', { type: 'text', placeholder: 'Server name (e.g. github)', class: 'mcp-input', id: 'mcp-form-name' });
      const transportSel = el('select', { class: 'mcp-input' });
      const optStdio = el('option', { value: 'stdio' }, ['stdio — local process']);
      const optSse = el('option', { value: 'sse' }, ['sse — remote HTTP']);
      transportSel.append(optStdio, optSse);
      const cmdInput = el('input', { type: 'text', placeholder: 'Command (e.g. npx @modelcontextprotocol/server-github)', class: 'mcp-input mcp-form-cmd' });
      const urlInput = el('input', { type: 'text', placeholder: 'URL (e.g. http://localhost:3000)', class: 'mcp-input mcp-form-url', style: 'display:none' });
      transportSel.addEventListener('change', () => {
        if (transportSel.value === 'sse') {
          cmdInput.style.display = 'none';
          urlInput.style.display = '';
        } else {
          cmdInput.style.display = '';
          urlInput.style.display = 'none';
        }
      });
      const actions = el('div', { class: 'mcp-form-actions' });
      const saveBtn = el('button', { class: 'mcp-form-save' }, ['Save']);
      const cancelBtn = el('button', { class: 'mcp-form-cancel secondary' }, ['Cancel']);
      nameInput.addEventListener('input', () => { nameInput.style.outline = ''; });
      cmdInput.addEventListener('input', () => { cmdInput.style.outline = ''; });
      urlInput.addEventListener('input', () => { urlInput.style.outline = ''; });
      saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.style.outline = '1px solid var(--vscode-errorForeground)'; return; }
        const isSSE = transportSel.value === 'sse';
        if (isSSE && !urlInput.value.trim()) {
          urlInput.style.outline = '1px solid var(--vscode-errorForeground)';
          return;
        }
        if (!isSSE && !cmdInput.value.trim()) {
          cmdInput.style.outline = '1px solid var(--vscode-errorForeground)';
          return;
        }
        const serverCfg = {
          name,
          transport: transportSel.value,
          ...(isSSE ? { url: urlInput.value.trim() } : { command: cmdInput.value.trim() }),
        };
        vscode.postMessage({ type: 'mcpConfigSave', server: serverCfg, action: 'add' });
        formEl.remove();
      });
      cancelBtn.addEventListener('click', () => formEl.remove());
      actions.append(saveBtn, cancelBtn);
      formEl.append(titleEl, nameInput, transportSel, cmdInput, urlInput, actions);
      mcpPanel.appendChild(formEl);
    });
    mcpPanel.append(addBtn);
  }

  const mcpBtn = actionBtn('codicon-plug', 'MCP servers', () => {
    if (mcpPanel.hasAttribute('hidden')) {
      mcpPanel.removeAttribute('hidden');
    } else {
      mcpPanel.setAttribute('hidden', 'true');
    }
  });

  // ⚡ Run Agents button — labeled so it's easy to spot
  const multiAgentBtn = el('button', {
    class: 'action-btn multi-agent-btn',
    title: 'Run Multi-Agent Workflow',
  });
  multiAgentBtn.append(codicon('run-all'), document.createTextNode(' Run'));
  multiAgentBtn.addEventListener('click', () => vscode.postMessage({ type: 'runMultiAgent' }));

  // Activity log data store
  const activityLog = []; // { toolName, args, success, time }

  // Activity log panel — hidden by default, toggled by activityBtn.
  const activityPanel = el('div', { class: 'activity-panel' });
  activityPanel.setAttribute('hidden', 'true');

  function renderActivityLog() {
    activityPanel.innerHTML = '';
    if (activityLog.length === 0) {
      activityPanel.append(el('div', { class: 'activity-empty' }, ['No tool calls this session.']));
      return;
    }
    const header = el('div', { class: 'activity-header' });
    header.append(
      el('span', {}, [`${activityLog.length} tool call${activityLog.length !== 1 ? 's' : ''} this session`]),
      el('button', { class: 'activity-clear', title: 'Clear' }, ['Clear'])
    );
    header.querySelector('.activity-clear').addEventListener('click', () => {
      activityLog.length = 0;
      renderActivityLog();
    });
    activityPanel.append(header);
    for (const entry of [...activityLog].reverse()) {
      const row = el('div', { class: `activity-row ${entry.success === false ? 'activity-row-err' : ''}` });
      const icon = entry.success === false ? '✗' : entry.success === true ? '✓' : '⋯';
      row.append(
        el('span', { class: 'activity-icon' }, [icon]),
        el('span', { class: 'activity-tool' }, [entry.toolName]),
        el('span', { class: 'activity-time' }, [entry.time])
      );
      activityPanel.append(row);
    }
  }

  const activityBtn = actionBtn('codicon-history', 'Activity log', () => {
    activityPanel.hasAttribute('hidden')
      ? activityPanel.removeAttribute('hidden')
      : activityPanel.setAttribute('hidden', 'true');
    renderActivityLog();
  });

  actionBar.append(mcpBtn, multiAgentBtn, activityBtn, compactBtn, deleteChatBtn, copyChatBtn, actionSpacer);

  // -------------------------------------------------------------------
  // DOM construction — messages list
  // -------------------------------------------------------------------

  const messagesContainer = el('div', { class: 'messages' });
  renderEmptyState();

  // Scroll pill — floating "↓ new messages" affordance shown when the
  // user scrolls up during streaming. Clicking it jumps to the bottom.
  const scrollPill = el('div', { class: 'scroll-pill', hidden: 'true' }, ['↓ New messages']);
  scrollPill.addEventListener('click', () => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    scrollPill.setAttribute('hidden', 'true');
  });

  // Track whether the user has manually scrolled up.
  let userScrolledUp = false;
  messagesContainer.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    userScrolledUp = !atBottom;
    if (atBottom) {
      scrollPill.setAttribute('hidden', 'true');
    }
  });

  // -------------------------------------------------------------------
  // DOM construction — input area + bottom bar
  // -------------------------------------------------------------------

  const inputArea = el('div', { class: 'input-area' });

  // Attachment chips displayed above the textarea when files are pending.
  const attachChips = el('div', { class: 'attach-chips' });
  /** @type {Array<{filename: string, contentBase64: string, mimeType: string}>} */
  const pendingFiles = [];

  // Attach button — sends a message to the host which opens VS Code's
  // native file picker (webview CSP blocks <input type="file">).
  const attachBtn = el('button', { class: 'attach-btn', title: 'Attach file', 'aria-label': 'Attach file' });
  attachBtn.append(codicon('attach'));
  attachBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFilePickerRequest' });
  });

  function renderAttachChips() {
    attachChips.innerHTML = '';
    for (let i = 0; i < pendingFiles.length; i++) {
      const chip = el('span', { class: 'attach-chip' });
      chip.append(
        el('span', {}, [pendingFiles[i].filename]),
        (() => {
          const x = el('button', { class: 'attach-chip-remove', title: 'Remove' }, ['×']);
          x.addEventListener('click', () => {
            pendingFiles.splice(i, 1);
            renderAttachChips();
          });
          return x;
        })(),
      );
      attachChips.append(chip);
    }
  }

  const textarea = el('textarea', {
    placeholder: 'Ask Champ anything... (@ for context, / for commands, ↑↓ history)',
  });
  // Slash-command autocomplete dropdown — hidden until the user types
  // a / at the start of the input.
  const skillDropdown = el('div', { class: 'skill-dropdown', hidden: 'true' });

  // Bottom bar: Mode picker, Model picker, Cancel/Send buttons.
  const bottomBar = el('div', { class: 'bottom-bar' });

  // Mode picker — styled popup replacing native <select>.
  const modeIcons = { agent: '⚙', ask: '💬', manual: '🛡', plan: '📋', composer: '🎼' };
  const modeDescs = {
    agent:    '🔴 Autonomous — reads & edits files, runs commands',
    ask:      '🟢 Read-only — answers questions, never edits files',
    manual:   '🟡 Step-by-step — asks approval before every action',
    plan:     '🟡 Plan only — researches and proposes, no file changes',
    composer: '🔴 Multi-file — edits multiple files with diff review',
  };
  const modePickerBtn = el('button', { class: 'mode-picker-btn' }, [`${modeIcons[state.mode] || '⚙'} ${state.mode.charAt(0).toUpperCase() + state.mode.slice(1)} ▾`]);
  const modePickerPopup = el('div', { class: 'mode-picker-popup', hidden: 'true' });
  modePickerBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Close sibling pickers so only one is open at a time.
    modelPickerPopup.setAttribute('hidden', 'true');
    if (modePickerPopup.hidden) {
      renderModeList();
      if (!modeTooltipShown) {
        modeTooltipShown = true;
        sessionStorage.setItem('champ-mode-tip', 'true');
        const tip = el('div', { class: 'mode-tip' }, [
          '🟢 Ask = read-only safe   🟡 Plan/Manual = supervised   🔴 Agent/Composer = edits files'
        ]);
        modePickerPopup.insertBefore(tip, modePickerPopup.firstChild);
      }
      modePickerPopup.removeAttribute('hidden');
    } else {
      modePickerPopup.setAttribute('hidden', 'true');
    }
  });
  document.addEventListener('click', () => modePickerPopup.setAttribute('hidden', 'true'));
  modePickerPopup.addEventListener('click', (ev) => ev.stopPropagation());

  function renderModeList() {
    modePickerPopup.innerHTML = '';
    for (const m of ['agent', 'ask', 'manual', 'plan', 'composer']) {
      const row = el('div', { class: `mode-row${m === state.mode ? ' active' : ''}` });
      const icon = el('span', { class: 'mode-icon' }, [modeIcons[m] || '']);
      const textCol = el('div', { class: 'mode-text' });
      const nameEl = el('span', { class: 'mode-name' }, [m.charAt(0).toUpperCase() + m.slice(1)]);
      const descEl = el('span', { class: 'mode-desc' }, [modeDescs[m] || '']);
      textCol.append(nameEl, descEl);
      if (m === state.mode) {
        const check = el('span', { class: 'mode-check' }, ['✓']);
        row.append(icon, textCol, check);
      } else {
        row.append(icon, textCol);
      }
      row.addEventListener('click', () => {
        state.mode = m;
        vscode.postMessage({ type: 'setMode', mode: m });
        modePickerBtn.textContent = `${modeIcons[m]} ${m.charAt(0).toUpperCase() + m.slice(1)} ▾`;
        modePickerPopup.setAttribute('hidden', 'true');
      });
      modePickerPopup.append(row);
    }
    const hint = el('div', { class: 'picker-hint' }, ['Ctrl+Shift+M to toggle']);
    modePickerPopup.append(hint);
  }

  // Model picker — Cursor-style popup instead of native <select>.
  const modelPickerBtn = el('button', { class: 'model-picker-btn', title: 'Switch model' }, ['Auto']);
  const modelPickerPopup = el('div', { class: 'model-picker-popup', hidden: 'true' });
  const modelSearchInput = el('input', { type: 'text', class: 'model-search', placeholder: 'Search models' });
  const modelListEl = el('div', { class: 'model-list' });
  modelPickerPopup.append(modelSearchInput, modelListEl);

  // Toggle popup on button click.
  modelPickerBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    // Close sibling pickers so only one is open at a time.
    modePickerPopup.setAttribute('hidden', 'true');
    if (modelPickerPopup.hidden) {
      modelPickerPopup.removeAttribute('hidden');
      modelSearchInput.value = '';
      renderModelList('');
      modelSearchInput.focus();
    } else {
      modelPickerPopup.setAttribute('hidden', 'true');
    }
  });
  // Close on outside click.
  document.addEventListener('click', () => modelPickerPopup.setAttribute('hidden', 'true'));
  modelPickerPopup.addEventListener('click', (ev) => ev.stopPropagation());
  // Filter on search input.
  modelSearchInput.addEventListener('input', () => renderModelList(modelSearchInput.value));

  let modelAutoMode = true;  // true = smart routing, false = manual pick

  function renderModelList(filter) {
    modelListEl.innerHTML = '';
    const available = state.providerStatus.available || [];

    // ── "Auto" option at the top ──
    const autoRow = el('div', { class: `model-row auto-row${modelAutoMode ? ' active' : ''}` });
    const autoIcon = codicon('sparkle');
    autoIcon.style.marginRight = '6px';
    const autoName = el('span', { class: 'model-name' }, ['Auto']);
    const autoDesc = el('span', { class: 'model-tag' }, ['best model per task']);
    if (modelAutoMode) {
      const check = el('span', { class: 'model-check' }, ['✓']);
      autoRow.append(autoIcon, autoName, autoDesc, check);
    } else {
      autoRow.append(autoIcon, autoName, autoDesc);
    }
    autoRow.addEventListener('click', () => {
      modelAutoMode = true;
      modelPickerBtn.textContent = 'Auto ▾';
      modelPickerPopup.setAttribute('hidden', 'true');
      vscode.postMessage({ type: 'resetToAutoRequest' });
    });
    modelListEl.append(autoRow);

    // ── Filter ──
    const query = filter.toLowerCase();
    const filtered = query
      ? available.filter(m =>
          (m.label || '').toLowerCase().includes(query) ||
          (m.providerName || '').toLowerCase().includes(query) ||
          (m.modelName || '').toLowerCase().includes(query))
      : available;

    // Separate reachable vs offline models.
    const reachable = filtered.filter(m => !(m.label || '').startsWith('[offline]'));
    const offline = filtered.filter(m => (m.label || '').startsWith('[offline]'));

    // ── Group reachable by provider ──
    const groups = {};
    for (const m of reachable) {
      const key = m.providerName || 'unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }

    for (const [providerName, models] of Object.entries(groups)) {
      const groupHeader = el('div', { class: 'model-group-header' }, [`${providerName}`]);
      modelListEl.append(groupHeader);
      for (const m of models) {
        const row = el('div', { class: 'model-row' });
        const isActive = !modelAutoMode &&
          m.providerName === state.providerStatus.providerName &&
          m.modelName === state.providerStatus.modelName;
        if (isActive) row.classList.add('active');
        const nameEl = el('span', { class: 'model-name' }, [m.modelName || m.providerName]);
        const capMatch = m.label.match(/\)(.*)/);
        const capText = capMatch ? capMatch[1].trim() : 'autodetected';
        const tagEl = el('span', { class: 'model-tag' }, [capText || 'autodetected']);
        if (isActive) {
          const check = el('span', { class: 'model-check' }, ['✓']);
          row.append(nameEl, tagEl, check);
        } else {
          row.append(nameEl, tagEl);
        }
        row.addEventListener('click', () => {
          modelAutoMode = false;
          vscode.postMessage({ type: 'setModelRequest', providerName: m.providerName, modelName: m.modelName });
          modelPickerBtn.textContent = (m.modelName || m.providerName) + ' ▾';
          modelPickerPopup.setAttribute('hidden', 'true');
        });
        modelListEl.append(row);
      }
    }

    // ── Offline / unreachable models (greyed out) ──
    if (offline.length > 0) {
      const offlineHeader = el('div', { class: 'model-group-header offline' }, ['Offline']);
      modelListEl.append(offlineHeader);
      for (const m of offline) {
        const row = el('div', { class: 'model-row offline' });
        const nameEl = el('span', { class: 'model-name' }, [m.modelName || m.providerName]);
        const tagEl = el('span', { class: 'model-tag' }, [`${m.providerName} — unreachable`]);
        row.append(nameEl, tagEl);
        // No click handler — disabled.
        modelListEl.append(row);
      }
    }

    if (reachable.length === 0 && offline.length === 0) {
      modelListEl.append(el('div', { class: 'model-empty' }, ['Scanning providers...']));
    }
    // Footer: + Add model + shortcut hint.
    const footer = el('div', { class: 'model-footer' });
    const addBtn = el('div', { class: 'model-add' }, ['+ Configure providers']);
    addBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'openConfigFile' });
      modelPickerPopup.setAttribute('hidden', 'true');
    });
    const rescanBtn = el('div', { class: 'model-add' }, ['↻ Re-scan models']);
    rescanBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'rescanModels' });
      modelPickerPopup.setAttribute('hidden', 'true');
    });
    footer.append(addBtn, rescanBtn);
    modelListEl.append(footer);
  }

  const bottomSpacer = el('div', { class: 'bottom-spacer' });

  // Primary action button — shows Send (blue ▶) when text is present,
  // shows Stop (red ■) while streaming. Hidden when idle with no text.
  // Named primaryBtn to avoid collision with the existing actionBtn() helper above.
  const primaryBtn = el('button', { class: 'primary-btn', title: 'Send' });
  primaryBtn.style.display = 'none';

  const queueBadge = el('span', { class: 'queue-badge' });
  queueBadge.style.cssText = 'display:none;font-size:11px;opacity:0.7;padding:0 6px;white-space:nowrap;align-self:center;';

  primaryBtn.addEventListener('click', () => {
    if (state.streaming) {
      vscode.postMessage({ type: 'cancelRequest' });
      setStreaming(false);
    } else {
      sendCurrentInput();
    }
  });

  function updatePrimaryBtn() {
    const hasText = textarea.value.trim().length > 0;
    if (state.streaming) {
      primaryBtn.style.display = '';
      primaryBtn.className = 'primary-btn primary-btn--stop';
      primaryBtn.title = 'Stop';
      primaryBtn.innerHTML = '■';
    } else if (hasText) {
      primaryBtn.style.display = '';
      primaryBtn.className = 'primary-btn primary-btn--send';
      primaryBtn.title = 'Send (Enter)';
      primaryBtn.innerHTML = '▶';
    } else {
      primaryBtn.style.display = 'none';
    }
  }

  bottomBar.append(modePickerBtn, modelPickerBtn, bottomSpacer, queueBadge, primaryBtn);

  let skillDebounceTimer = null;
  textarea.addEventListener('input', () => {
    autoResizeTextarea();
    updatePrimaryBtn();
    // Close dropdown immediately if no longer a slash-command prefix.
    const value = textarea.value;
    if (!value.match(/^\/([A-Za-z][\w-]*)?$/)) {
      closeSkillDropdown();
    } else {
      // Debounce the extension-host round-trip so rapid typing doesn't lag.
      clearTimeout(skillDebounceTimer);
      skillDebounceTimer = setTimeout(() => handleSkillInput(), 150);
    }
    // Show @ hint popover when user types a bare '@' (at start or after space).
    const atMatch = value.match(/(^|\s)@$/);
    if (atMatch) {
      showAtHint();
    } else {
      hideAtHint();
    }
  });

  function autoResizeTextarea() {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  textarea.addEventListener('keydown', (ev) => {
    // Dropdown navigation takes priority over send-on-enter when open.
    if (state.skillSuggestions.length > 0 && !skillDropdown.hidden) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        setSkillHighlight(state.skillHighlight + 1);
        return;
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        setSkillHighlight(state.skillHighlight - 1);
        return;
      }
      if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey)) {
        ev.preventDefault();
        acceptSkillCompletion();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeSkillDropdown();
        return;
      }
    }
    // Terminal-style history navigation with ArrowUp / ArrowDown.
    // Only activates when the cursor is at the very first line (Up) or
    // last line (Down) of the textarea, so multi-line editing still works.
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const lines = textarea.value.split('\n');
      const cursorPos = textarea.selectionStart;
      const textBefore = textarea.value.slice(0, cursorPos);
      const isOnFirstLine = !textBefore.includes('\n') || textarea.selectionStart === 0;
      const isOnLastLine = !textarea.value.slice(cursorPos).includes('\n');

      if (ev.key === 'ArrowUp' && isOnFirstLine && state.inputHistory.length > 0) {
        ev.preventDefault();
        if (state.historyIndex === -1) {
          // Save current draft before starting navigation.
          state.historyDraft = textarea.value;
          state.historyIndex = state.inputHistory.length - 1;
        } else if (state.historyIndex > 0) {
          state.historyIndex--;
        }
        textarea.value = state.inputHistory[state.historyIndex];
        textarea.classList.add('history-mode');
        autoResizeTextarea();
        updatePrimaryBtn();
        // Move caret to end.
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        return;
      }

      if (ev.key === 'ArrowDown' && isOnLastLine && state.historyIndex !== -1) {
        ev.preventDefault();
        if (state.historyIndex < state.inputHistory.length - 1) {
          state.historyIndex++;
          textarea.value = state.inputHistory[state.historyIndex];
        } else {
          // Reached the bottom — restore the saved draft.
          state.historyIndex = -1;
          textarea.value = state.historyDraft;
          state.historyDraft = '';
          textarea.classList.remove('history-mode');
        }
        autoResizeTextarea();
        updatePrimaryBtn();
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        return;
      }
    }

    // Enter sends, Shift+Enter inserts newline.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      hideAtHint();
      sendCurrentInput();
    }
  });

  // Move attachBtn into the bottom bar (left-most item, before mode picker).
  // The textarea now lives directly inside the unified chatBox.
  bottomBar.prepend(attachBtn);

  // Unified chat input box — textarea on top, bottom strip inside the same border.
  const chatBox = el('div', { class: 'chat-box' });
  chatBox.append(attachChips, textarea, bottomBar);

  // Metrics footer — tiny status line below the chat box.
  const metricsFooter = el('div', { class: 'metrics-footer' });
  metricsFooter.textContent = '';

  function renderMetrics(m) {
    if (!m || m.totalRequests === 0) {
      metricsFooter.textContent = '';
      return;
    }
    const tokensIn = m.totalTokensIn.toLocaleString();
    const tokensOut = m.totalTokensOut.toLocaleString();
    metricsFooter.textContent = `${m.totalRequests} req · ${tokensIn} in · ${tokensOut} out · ${m.averageLatency}ms avg${m.totalFailures > 0 ? ` · ${m.totalFailures} err` : ''}`;
  }

  // @ hint popover — shown when the user types a bare '@'.
  const atHintEl = el('div', { class: 'at-hint', hidden: 'true' });
  atHintEl.innerHTML = `
    <div class="at-hint-title">Context references</div>
    <div class="at-hint-grid">
      <span class="at-hint-sym">@Files(path)</span><span class="at-hint-desc">File contents</span>
      <span class="at-hint-sym">@Folders(path)</span><span class="at-hint-desc">Directory listing</span>
      <span class="at-hint-sym">@Code</span><span class="at-hint-desc">Editor selection</span>
      <span class="at-hint-sym">@Git</span><span class="at-hint-desc">Diff &amp; recent commits</span>
      <span class="at-hint-sym">@Codebase</span><span class="at-hint-desc">Semantic search</span>
      <span class="at-hint-sym">@Symbols(name)</span><span class="at-hint-desc">Workspace symbols</span>
      <span class="at-hint-sym">@Web</span><span class="at-hint-desc">Web search</span>
    </div>`;

  function showAtHint() { atHintEl.removeAttribute('hidden'); }
  function hideAtHint() { atHintEl.setAttribute('hidden', 'true'); }

  inputArea.append(skillDropdown, atHintEl, chatBox, modePickerPopup, modelPickerPopup, metricsFooter);

  // Wrap messages + scroll pill in a positioned container.
  const messagesWrapper = el('div', { class: 'messages-wrapper' });
  messagesWrapper.append(messagesContainer, scrollPill);

  // Workflow history strip — shows active run + recent past runs.
  const workflowStrip = el('div', { class: 'workflow-strip', hidden: 'true' });
  const workflowStripHeader = el('div', { class: 'workflow-strip-header' });
  const workflowStripTitle = el('span', {}, ['WORKFLOWS']);
  const workflowNewBtn = el('button', { class: 'workflow-new-btn', title: 'New workflow' }, ['⚡ New']);
  workflowNewBtn.addEventListener('click', () => vscode.postMessage({ type: 'runMultiAgent' }));
  const teamsBtn = el('button', { class: 'workflow-new-btn', title: 'Run agent team' }, ['👥 Teams']);
  teamsBtn.addEventListener('click', () => vscode.postMessage({ type: 'runTeam' }));
  workflowStripHeader.append(workflowStripTitle, workflowNewBtn, teamsBtn);
  const workflowStripBody = el('div', { class: 'workflow-strip-body' });
  workflowStrip.append(workflowStripHeader, workflowStripBody);

  const STATUS_ICON_MAP = { running: '⟳', 'awaiting-approval': '⏸', completed: '✓', failed: '✗', stopped: '■' };
  const STATUS_COLOR_MAP = {
    running: 'var(--vscode-testing-iconPassed,#73c991)',
    'awaiting-approval': 'var(--vscode-charts-orange,#f5a623)',
    completed: 'var(--vscode-testing-iconPassed,#73c991)',
    failed: 'var(--vscode-testing-iconFailed,#f14c4c)',
    stopped: 'var(--vscode-descriptionForeground)',
  };

  function renderWorkflowStrip(runs) {
    if (!runs || runs.length === 0) {
      workflowStrip.setAttribute('hidden', 'true');
      return;
    }
    workflowStrip.removeAttribute('hidden');
    workflowStripBody.innerHTML = '';
    for (const run of runs.slice(0, 5)) {
      const row = el('div', { class: 'workflow-strip-row' });
      const icon = el('span', { class: 'workflow-strip-icon' });
      icon.textContent = STATUS_ICON_MAP[run.status] || '○';
      icon.style.color = STATUS_COLOR_MAP[run.status] || 'inherit';
      const info = el('div', { class: 'workflow-strip-info' });
      const name = el('div', { class: 'workflow-strip-name' });
      name.textContent = run.name.length > 35 ? run.name.slice(0, 35) + '…' : run.name;
      info.appendChild(name);
      if (run.status === 'running' && run.progress) {
        const bar = el('div', { class: 'workflow-strip-progress' });
        const fill = el('div', { class: 'workflow-strip-progress-fill' });
        const pct = Math.round((run.progress.current / Math.max(run.progress.total, 1)) * 100);
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        info.appendChild(bar);
      }
      const meta = el('div', { class: 'workflow-strip-meta' });
      if (run.status === 'running' && run.progress) {
        meta.textContent = 'step ' + run.progress.current + '/' + run.progress.total + ' · ' + run.mode;
      } else {
        const ago = run.endTime
          ? (Date.now() - run.endTime < 60000
              ? 'just now'
              : Math.round((Date.now() - run.endTime) / 60000) + 'm ago')
          : 'just now';
        const fileStr = run.filesChanged > 0 ? run.filesChanged + ' file' + (run.filesChanged !== 1 ? 's' : '') + ' · ' : '';
        meta.textContent = fileStr + ago;
      }
      info.appendChild(meta);
      const actions = el('div', { class: 'workflow-strip-actions' });
      const openBtn = el('button', { class: 'workflow-strip-btn', title: 'Open run' });
      openBtn.textContent = '↗';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openWorkflowRun', runId: run.id });
      });
      const rerunBtn = el('button', { class: 'workflow-strip-btn', title: 'Re-run' });
      rerunBtn.textContent = '↺';
      rerunBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'rerunWorkflow', runId: run.id });
      });
      actions.append(openBtn, rerunBtn);
      row.append(icon, info, actions);
      workflowStripBody.appendChild(row);
    }
  }

  root.append(header, tabBar, actionBar, mcpPanel, activityPanel, workflowStrip, settingsPanel, messagesWrapper, inputArea);

  // -------------------------------------------------------------------
  // Provider status rendering — header indicator + model dropdown
  // -------------------------------------------------------------------

  /**
   * Re-render the header subtitle and the bottom-bar model dropdown
   * from the latest providerStatus snapshot. Idempotent — safe to call
   * on every providerStatus message.
   */
  function renderProviderStatus() {
    const ps = state.providerStatus;

    // Header subtitle
    if (ps.state === 'loading') {
      headerSubtitle.textContent = 'loading…';
      headerSubtitle.classList.remove('error');
    } else if (ps.state === 'error') {
      headerSubtitle.textContent = `error: ${ps.errorMessage || 'provider not ready'}`;
      headerSubtitle.classList.add('error');
    } else {
      const label =
        ps.providerName && ps.modelName
          ? `${ps.providerName}: ${ps.modelName}`
          : ps.providerName || 'ready';
      headerSubtitle.textContent = label;
      headerSubtitle.classList.remove('error');
    }

    // Model picker button — show "Auto" in smart mode, specific model in manual.
    if (modelAutoMode) {
      modelPickerBtn.textContent = 'Auto ▾';
    } else {
      const activeLabel = ps.providerName && ps.modelName
        ? `${ps.modelName}`
        : ps.providerName || 'Auto';
      modelPickerBtn.textContent = activeLabel + ' ▾';
    }
    modelPickerBtn.style.display = '';
  }

  // Initial render so the user sees "loading…" immediately on open.
  renderProviderStatus();

  // -------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------

  function updateQueueBadge() {
    const n = state.messageQueue.length;
    queueBadge.style.display = n === 0 ? 'none' : '';
    queueBadge.textContent = n === 1 ? '1 queued' : `${n} queued`;
  }

  function showTourHintIfNeeded() {
    if (tourShown) return;
    tourShown = true;
    sessionStorage.setItem('champ-tour-shown', 'true');
    const banner = el('div', { class: 'tour-banner' });
    banner.append(
      el('span', { class: 'tour-text' }, [
        '💡 Tip: Use @ for context (@Files, @Codebase, @Git), / for slash commands, and switch modes (Ask/Agent/Plan) in the bottom bar.'
      ]),
      Object.assign(el('button', { class: 'tour-dismiss' }, ['✕']), {
        onclick: () => banner.remove()
      })
    );
    messagesContainer.insertBefore(banner, messagesContainer.firstChild);
  }

  function saveInputHistory() {
    try {
      const sessionId = state.activeSessionId || lastSessionData.activeSessionId;
      if (!sessionId) return; // no session ID yet — skip to avoid 'default' key corruption
      const s = vscode.getState() || {};
      const histories = s.inputHistories || {};
      histories[sessionId] = state.inputHistory.slice(-50);
      vscode.setState({ ...s, inputHistories: histories });
    } catch { /* storage failure must not break send */ }
  }

  function loadInputHistory(sessionId) {
    try {
      const s = vscode.getState() || {};
      return (s.inputHistories || {})[sessionId] || [];
    } catch { return []; }
  }

  function sendCurrentInput() {
    const text = textarea.value.trim();
    if (!text) return;

    // Record in history regardless of whether we send now or queue.
    if (state.inputHistory[state.inputHistory.length - 1] !== text) {
      state.inputHistory.push(text);
      saveInputHistory();        // persist immediately
    }
    state.historyIndex = -1;
    state.historyDraft = '';
    textarea.classList.remove('history-mode');

    // While a response is in-flight, queue the message instead of dropping it.
    if (state.streaming) {
      state.messageQueue.push(text);
      textarea.value = '';
      updateQueueBadge();
      return;
    }
    closeSkillDropdown();
    hideAtHint();
    vscode.postMessage({ type: 'userMessage', text });
    showTourHintIfNeeded();
    appendMessage('user', text);
    state.currentAssistantMessage = appendMessage('assistant', '');
    state.streamingHasText = false;
    // Show thinking dots until first token arrives.
    const cursorBody = state.currentAssistantMessage.querySelector('.body');
    if (cursorBody) cursorBody.classList.add('thinking');
    textarea.value = '';
    autoResizeTextarea();
    // Clear pending attachment chips after sending.
    pendingFiles.length = 0;
    renderAttachChips();
    setStreaming(true);
  }

  // -------------------------------------------------------------------
  // Skill autocomplete (slash commands)
  // -------------------------------------------------------------------

  /**
   * Called on every textarea input event. If the user has typed a /
   * at the very beginning of the input (and hasn't typed a space yet),
   * we send a skillAutocompleteRequest to the host. Otherwise we
   * close any open dropdown.
   */
  function handleSkillInput() {
    const value = textarea.value;
    // Only trigger when the FIRST character is / and there's no space
    // yet (i.e. we're still typing the command name).
    const match = value.match(/^\/([A-Za-z][\w-]*)?$/);
    if (!match) {
      closeSkillDropdown();
      return;
    }
    const prefix = match[1] || '';
    state.lastSkillPrefix = prefix;
    vscode.postMessage({ type: 'skillAutocompleteRequest', prefix });
  }

  function renderSkillDropdown(suggestions, prefix) {
    // Ignore stale responses.
    if (state.lastSkillPrefix !== prefix) return;
    state.skillSuggestions = suggestions;
    if (suggestions.length === 0) {
      closeSkillDropdown();
      return;
    }
    skillDropdown.innerHTML = '';
    suggestions.forEach((s, idx) => {
      const row = el('div', { class: 'skill-row' });
      const name = el('div', { class: 'skill-name' }, [`/${s.name}`]);
      const desc = el('div', { class: 'skill-desc' }, [s.description]);
      row.append(name, desc);
      row.addEventListener('mouseenter', () => setSkillHighlight(idx));
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        setSkillHighlight(idx);
        acceptSkillCompletion();
      });
      skillDropdown.append(row);
    });
    state.skillHighlight = 0;
    skillDropdown.removeAttribute('hidden');
    refreshHighlight();
  }

  function setSkillHighlight(idx) {
    if (state.skillSuggestions.length === 0) return;
    const n = state.skillSuggestions.length;
    state.skillHighlight = ((idx % n) + n) % n;
    refreshHighlight();
  }

  function refreshHighlight() {
    const rows = skillDropdown.querySelectorAll('.skill-row');
    rows.forEach((row, i) => {
      if (i === state.skillHighlight) row.classList.add('highlighted');
      else row.classList.remove('highlighted');
    });
  }

  function acceptSkillCompletion() {
    const pick = state.skillSuggestions[state.skillHighlight];
    if (!pick) return;
    // Replace the in-progress /<prefix> with /<full-name> + a trailing
    // space so the user can immediately type their argument.
    textarea.value = `/${pick.name} `;
    textarea.focus();
    // Move the caret to end.
    textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
    closeSkillDropdown();
  }

  function closeSkillDropdown() {
    if (skillDropdown.hasAttribute('hidden') && state.skillSuggestions.length === 0) return;
    state.skillSuggestions = [];
    state.skillHighlight = -1;
    state.lastSkillPrefix = null;
    skillDropdown.innerHTML = '';
    skillDropdown.setAttribute('hidden', 'true');
  }

  function setStreaming(streaming) {
    state.streaming = streaming;
    updatePrimaryBtn();
    if (!streaming && state.currentAssistantMessage) {
      const body = state.currentAssistantMessage.querySelector('.body');
      if (body) {
        body.classList.remove('streaming-cursor');
        body.classList.remove('thinking');
      }
      state.currentAssistantMessage = null;
      state.streamingHasText = false;
    }
    // Drain the queue: send the next message automatically after stream ends.
    if (!streaming && state.messageQueue.length > 0) {
      const next = state.messageQueue.shift();
      updateQueueBadge();
      setTimeout(() => {
        textarea.value = next;
        sendCurrentInput();
      }, 50);
    }
  }

  function appendMessage(role, text) {
    if (state.messages.length === 0) {
      messagesContainer.innerHTML = '';
    }
    const msgIdx = state.messages.length;
    const msg = { role, text, toolCalls: [] };
    state.messages.push(msg);

    const messageEl = el('div', { class: `message ${role}` });
    const bodyEl = el('div', { class: 'body' });
    // Render markdown for assistant messages; user messages stay as
    // plain text (what the user typed).
    if (text) {
      if (role === 'assistant') {
        bodyEl.dataset.rawText = text;
        bodyEl.innerHTML = renderMarkdown(text);
      } else {
        bodyEl.textContent = text;
      }
    }
    // Only show the blinking cursor on the CURRENT streaming message —
    // not on restored/completed ones. The caller sets
    // state.currentAssistantMessage after this returns, which is only
    // done for new live messages, not for history restores.
    // We add the class here and the caller is responsible for it being
    // the active streaming message or removing it immediately.

    // Per-message action bar (Continue.dev style) — floats on the right, visible on hover.
    const actions = el('div', { class: 'msg-actions' });

    if (role === 'user') {
      const retryBtn = el('button', { class: 'msg-action', title: 'Retry' });
      retryBtn.append(codicon('refresh'));
      retryBtn.addEventListener('click', () => {
        const originalText = state.messages[msgIdx]?.text || text;
        state.messages.splice(msgIdx);
        state.currentAssistantMessage = null;
        messagesContainer.innerHTML = '';
        if (state.messages.length === 0) renderEmptyState();
        else for (const m of state.messages) appendMessage(m.role, m.text);
        textarea.value = originalText;
        sendCurrentInput();
      });
      const copyBtn = el('button', { class: 'msg-action', title: 'Copy' });
      copyBtn.append(codicon('copy'));
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(bodyEl.textContent || '').catch(() => {});
      });
      actions.append(retryBtn, copyBtn);
    }

    if (role === 'assistant') {
      const copyBtn = el('button', { class: 'msg-action', title: 'Copy' });
      copyBtn.append(codicon('copy'));
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(bodyEl.textContent || '').catch(() => {});
      });
      const delBtn = el('button', { class: 'msg-action', title: 'Delete' });
      delBtn.append(codicon('trash'));
      delBtn.addEventListener('click', () => {
        state.messages.splice(msgIdx, 1);
        messageEl.remove();
      });
      actions.append(copyBtn, delBtn);
    }

    messageEl.append(bodyEl, actions);
    messagesContainer.append(messageEl);
    if (!userScrolledUp) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
    return messageEl;
  }

  function appendStreamDelta(text) {
    if (!state.currentAssistantMessage) {
      state.currentAssistantMessage = appendMessage('assistant', '');
      const b = state.currentAssistantMessage.querySelector('.body');
      if (b) b.classList.add('streaming-cursor');
    }
    const body = state.currentAssistantMessage.querySelector('.body');
    // First token — swap thinking dots for the streaming cursor.
    if (!state.streamingHasText && body) {
      state.streamingHasText = true;
      body.classList.remove('thinking');
      body.classList.add('streaming-cursor');
    }
    if (body) {
      // Buffer the raw markdown text and re-render on every delta.
      // This is O(n) per delta but fine for typical message sizes.
      const raw = (body.dataset.rawText || '') + text;
      body.dataset.rawText = raw;
      body.innerHTML = renderMarkdown(raw);
      if (userScrolledUp) {
        scrollPill.removeAttribute('hidden');
      } else {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }
  }

  /**
   * Minimal markdown-to-HTML renderer. Handles the patterns LLMs
   * most commonly produce: headings, code blocks, inline code,
   * bold, italic, links, unordered/ordered lists, and paragraphs.
   * Escapes HTML in text to prevent XSS.
   */
  function renderMarkdown(md) {
    if (!md) return '';
    // HTML-escape first, then apply markdown rules.
    const esc = (s) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Extract fenced code blocks first so their content isn't touched
    // by inline rules.
    const codeBlocks = [];
    let text = md.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang, code });
      return `\x00CODE${idx}\x00`;
    });

    // Escape remaining HTML.
    text = esc(text);

    // Inline code (after escaping, so backticks are still literal).
    text = text.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

    // Bold + italic.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // Links: [text](url)
    text = text.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2">$1</a>',
    );

    // Headings (ATX).
    text = text.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    text = text.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    text = text.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // Lists: group consecutive - or * lines into <ul>, 1. lines into <ol>.
    const lines = text.split('\n');
    const out = [];
    let listType = null;
    let listBuffer = [];
    const flushList = () => {
      if (listBuffer.length > 0) {
        const tag = listType === 'ul' ? 'ul' : 'ol';
        out.push(`<${tag}>${listBuffer.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
        listBuffer = [];
        listType = null;
      }
    };
    for (const line of lines) {
      const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
      const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (ulMatch) {
        if (listType !== 'ul') flushList();
        listType = 'ul';
        listBuffer.push(ulMatch[1]);
      } else if (olMatch) {
        if (listType !== 'ol') flushList();
        listType = 'ol';
        listBuffer.push(olMatch[1]);
      } else {
        flushList();
        out.push(line);
      }
    }
    flushList();
    text = out.join('\n');

    // Paragraphs: split on double-newline, wrap non-block lines in <p>.
    const blocks = text.split(/\n\n+/);
    const htmlBlocks = blocks.map((b) => {
      const trimmed = b.trim();
      if (!trimmed) return '';
      // Already a block-level element? pass through.
      if (/^<(h\d|ul|ol|pre|blockquote|table|div)/.test(trimmed)) return trimmed;
      // Otherwise wrap in <p>, converting single newlines to <br>.
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    });
    text = htmlBlocks.join('\n');

    // Restore code blocks with a copy button.
    text = text.replace(/\x00CODE(\d+)\x00/g, (_, idx) => {
      const { lang, code } = codeBlocks[parseInt(idx, 10)];
      const langLabel = lang ? `<span class="code-lang-label">${esc(lang)}</span>` : '';
      return `<div class="code-block-wrapper">`
        + `<div class="code-block-header">${langLabel}<button class="code-copy-btn">Copy</button></div>`
        + `<pre class="code-block"><code class="lang-${esc(lang || 'text')}">${esc(code)}</code></pre>`
        + `</div>`;
    });

    return text;
  }

  function appendToolCallCard(toolName, args) {
    if (!state.currentAssistantMessage) {
      state.currentAssistantMessage = appendMessage('assistant', '');
      const b = state.currentAssistantMessage.querySelector('.body');
      if (b) b.classList.add('streaming-cursor');
    }
    const card = el('div', { class: 'tool-card' });
    // Tool name row with copy button on the right.
    const nameRow = el('div', { class: 'tool-name-row' });
    const toolIcon = codicon('tools');
    toolIcon.style.marginRight = '6px';
    const name = el('span', { class: 'tool-name' });
    name.append(toolIcon, document.createTextNode(toolName));
    const copyToolBtn = el('button', { class: 'tool-copy-btn', title: 'Copy' });
    copyToolBtn.append(codicon('copy'));
    copyToolBtn.addEventListener('click', () => {
      const text = JSON.stringify(args, null, 2);
      navigator.clipboard.writeText(text).catch(() => {});
    });
    nameRow.append(name, copyToolBtn);
    const argsEl = el('div', { class: 'tool-args' }, [JSON.stringify(args, null, 2)]);
    const resultEl = el('div', { class: 'tool-result' }, ['Running...']);
    card.append(nameRow, argsEl, resultEl);
    state.currentAssistantMessage.append(card);
    card.dataset.toolName = toolName;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return card;
  }

  function updateToolCallResult(toolName, result, success) {
    const cards = messagesContainer.querySelectorAll('.tool-card');
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i];
      if (card.dataset.toolName === toolName && !card.dataset.completed) {
        card.dataset.completed = 'true';
        if (!success) card.classList.add('error');
        const resultEl = card.querySelector('.tool-result');
        if (!resultEl) return;

        // For generated files, render a clickable link that opens the file
        // in the editor with a side-by-side Markdown preview.
        const fileMatch = success && result && result.match(
          /(?:written|created)\s+to\s+(.+\.(?:md|txt|json|yaml|yml))$/i
        );
        if (fileMatch) {
          const relPath = fileMatch[1].trim();
          resultEl.innerHTML = '';
          resultEl.append(document.createTextNode('✓ '));
          const link = el('button', { class: 'tool-file-link' }, [relPath]);
          link.addEventListener('click', () => {
            vscode.postMessage({ type: 'openGeneratedFileRequest', filePath: relPath });
          });
          resultEl.append(link);
        } else {
          resultEl.textContent = result;
        }
        return;
      }
    }
  }

  function getErrorHint(msg) {
    if (/unauthorized|401|api.?key|authentication/i.test(msg))
      return 'Run Champ: Set API Key from the command palette (Ctrl+Shift+P).';
    if (/econnrefused|connection refused|ECONNREFUSED/i.test(msg))
      return 'Is your local server running? For Ollama try: ollama serve';
    if (/enotfound|network|getaddrinfo/i.test(msg))
      return 'Check your network connection and provider base URL in .champ/config.yaml.';
    if (/context.?length|token.?limit|too long/i.test(msg))
      return 'The conversation is too long. Start a new chat or use a model with a larger context window.';
    return null;
  }

  function showError(message) {
    const messageEl = el('div', { class: 'message error' });
    const bodyEl = el('div', { class: 'body' });
    bodyEl.appendChild(document.createTextNode(message));
    const hint = getErrorHint(message);
    if (hint) {
      const hintEl = el('p', { class: 'error-hint' }, [hint]);
      bodyEl.append(hintEl);
    }
    messageEl.append(bodyEl);
    messagesContainer.append(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setStreaming(false);
  }

  function showPiiNotice(summary) {
    const notice = el('div', { class: 'pii-notice' });
    const em = el('em', {}, [summary]);
    notice.append(document.createTextNode('🔒 '), em);
    messagesContainer.append(notice);
    if (!userScrolledUp) messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setTimeout(() => { if (notice.parentNode) notice.remove(); }, 8000);
  }

  // Per-session auto-approve flag. When true, all subsequent approval
  // requests are auto-allowed without showing a dialog.
  let sessionAutoApprove = false;

  /**
   * Show an inline approval dialog when the agent wants to execute
   * a destructive tool (create/edit/delete file, run terminal).
   *
   * Options:
   *   Allow            — approve this one tool call
   *   Allow for Session — auto-approve all remaining calls in this session
   *   Deny             — skip this tool, agent continues
   *   Deny & Stop      — skip and abort the entire agent loop
   */
  function showApprovalDialog(id, description, preview) {
    // If session auto-approve is active, approve immediately.
    if (sessionAutoApprove) {
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      return;
    }

    const dialog = el('div', { class: 'approval-dialog' });
    const desc = el('div', { class: 'approval-desc' }, [description]);
    const btnRow = el('div', { class: 'approval-btns' });

    if (preview && preview.content) {
      const previewWrap = el('div', { class: 'approval-preview' });
      if (preview.label) {
        previewWrap.appendChild(el('div', { class: 'approval-preview-label' }, [preview.label]));
      }
      if (preview.type === 'diff') {
        const diffEl = el('div', { class: 'approval-preview-diff' });
        preview.content.split('\n').forEach(function(line) {
          if (line.startsWith('-')) {
            diffEl.appendChild(el('span', { class: 'diff-line del' }, [line]));
          } else if (line.startsWith('+')) {
            diffEl.appendChild(el('span', { class: 'diff-line add' }, [line]));
          } else if (line.trim() !== '') {
            diffEl.appendChild(el('span', { class: 'diff-line' }, [line]));
          } else {
            diffEl.appendChild(document.createElement('br'));
          }
        });
        previewWrap.appendChild(diffEl);
      } else if (preview.type === 'command') {
        const codeEl = el('pre', { class: 'approval-preview-cmd' });
        codeEl.appendChild(el('code', {}, [preview.content]));
        previewWrap.appendChild(codeEl);
      }
      dialog.append(desc, previewWrap);
    } else {
      dialog.append(desc);
    }

    const allowBtn = el('button', { class: 'approval-allow' }, ['Allow']);
    allowBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      dialog.remove();
    });

    const allowSessionBtn = el('button', { class: 'approval-allow-session' }, ['Allow for Session']);
    allowSessionBtn.addEventListener('click', () => {
      sessionAutoApprove = true;
      vscode.postMessage({ type: 'approvalResponse', id, approved: true });
      dialog.remove();
    });

    const denyBtn = el('button', { class: 'approval-deny' }, ['Deny']);
    denyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', id, approved: false });
      dialog.remove();
    });

    const denyStopBtn = el('button', { class: 'approval-deny-stop' }, ['Deny & Stop']);
    denyStopBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'approvalResponse', id, approved: false });
      // Also cancel the entire agent loop.
      vscode.postMessage({ type: 'cancelRequest' });
      dialog.remove();
      setStreaming(false);
    });

    btnRow.append(allowBtn, allowSessionBtn, denyBtn, denyStopBtn);
    dialog.append(btnRow);
    messagesContainer.append(dialog);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function renderEmptyState() {
    messagesContainer.innerHTML = '';
    const wrap = el('div', { class: 'empty-state' });
    wrap.append(el('div', { class: 'empty-state-title' }, ['What can I help with?']));
    const prompts = [
      { icon: '🔍', label: 'Explain this file', text: '@Code Explain what this code does and how it works.' },
      { icon: '🐛', label: 'Find bugs', text: 'Review @Files(src/) for bugs, edge cases, and improvements.' },
      { icon: '✨', label: 'Add a feature', text: 'Add [describe feature] to the codebase with tests.' },
      { icon: '📖', label: 'Understand codebase', text: '@Codebase How is authentication implemented in this project?' },
    ];
    const grid = el('div', { class: 'empty-state-grid' });
    for (const p of prompts) {
      const btn = el('button', { class: 'empty-state-prompt' });
      btn.append(el('span', { class: 'empty-state-icon' }, [p.icon]), el('span', {}, [p.label]));
      btn.addEventListener('click', () => {
        textarea.value = p.text;
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
      });
      grid.append(btn);
    }
    wrap.append(grid);
    messagesContainer.append(wrap);
  }

  // -------------------------------------------------------------------
  // Onboarding (first-run) panel
  // -------------------------------------------------------------------

  /**
   * Render the onboarding picker in the messages area. Shows a set of
   * radio-button template options with a Create + Skip button. Replaces
   * whatever was previously in messagesContainer.
   */
  function renderOnboardingPanel(templates) {
    messagesContainer.innerHTML = '';
    const panel = el('div', { class: 'onboarding-panel' });
    panel.append(
      el('div', { class: 'onboarding-title' }, ['Welcome to Champ']),
      el('div', { class: 'onboarding-subtitle' }, [
        'No configuration found. Pick a starter template to create .champ/config.yaml:',
      ]),
    );

    let selectedId = templates.length > 0 ? templates[0].id : null;

    const radioGroup = el('div', { class: 'onboarding-radios' });
    for (const t of templates) {
      const row = el('label', { class: 'onboarding-radio-row' });
      const radio = el('input', { type: 'radio', name: 'onboarding-template' });
      radio.value = t.id;
      if (t.id === selectedId) radio.checked = true;
      radio.addEventListener('change', () => {
        selectedId = t.id;
      });
      const textGroup = el('div', { class: 'onboarding-radio-text' });
      textGroup.append(
        el('div', { class: 'onboarding-radio-label' }, [t.label]),
        el('div', { class: 'onboarding-radio-desc' }, [t.description]),
      );
      row.append(radio, textGroup);
      radioGroup.append(row);
    }
    panel.append(radioGroup);

    const actions = el('div', { class: 'onboarding-actions' });
    const createBtn = el('button', { class: 'onboarding-create' }, ['Create Config']);
    createBtn.addEventListener('click', () => {
      if (!selectedId) return;
      vscode.postMessage({ type: 'firstRunSelectRequest', templateId: selectedId });
    });
    const skipBtn = el('button', { class: 'onboarding-skip secondary' }, ['Skip']);
    skipBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'firstRunDismissRequest' });
      renderEmptyState();
    });
    actions.append(createBtn, skipBtn);
    panel.append(actions);

    messagesContainer.append(panel);
  }

  // -------------------------------------------------------------------
  // Diff hunk splitter — splits old/new full-file text into changed hunks
  // -------------------------------------------------------------------
  function splitHunks(oldText, newText) {
    if (oldText === newText) return [];
    var oldLines = oldText.split('\n');
    var newLines = newText.split('\n');
    var hunks = [];
    var i = 0; var j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        i++; j++;
      } else {
        var oldStart = i; var newStart = j;
        while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) { i++; }
        while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) { j++; }
        hunks.push({
          oldLines: oldLines.slice(oldStart, i),
          newLines: newLines.slice(newStart, j)
        });
      }
    }
    return hunks;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'streamStart':
        // Multi-agent workflow starting: show user request bubble, enter streaming mode.
        if (msg.userText) appendMessage('user', msg.userText);
        state.currentAssistantMessage = appendMessage('assistant', '');
        state.streamingHasText = false;
        {
          const startBody = state.currentAssistantMessage.querySelector('.body');
          if (startBody) startBody.classList.add('thinking');
        }
        setStreaming(true);
        break;
      case 'streamDelta':
        appendStreamDelta(msg.text || '');
        break;
      case 'streamEnd':
        setStreaming(false);
        // Safety net: mark any tool cards still showing "Running..."
        // as completed (the result message may have been lost).
        for (const card of messagesContainer.querySelectorAll('.tool-card')) {
          if (!card.dataset.completed) {
            card.dataset.completed = 'true';
            const resultEl = card.querySelector('.tool-result');
            if (resultEl && resultEl.textContent === 'Running...') {
              resultEl.textContent = 'Done';
            }
          }
        }
        break;
      case 'toolCallStart': {
        appendToolCallCard(msg.toolName, msg.args);
        activityLog.push({ toolName: msg.toolName, args: msg.args, success: null, time: new Date().toLocaleTimeString() });
        break;
      }
      case 'toolCallResult': {
        updateToolCallResult(msg.toolName, msg.result, msg.success);
        // Update last matching pending entry in activityLog.
        for (let _i = activityLog.length - 1; _i >= 0; _i--) {
          if (activityLog[_i].toolName === msg.toolName && activityLog[_i].success === null) {
            activityLog[_i].success = msg.success !== false;
            break;
          }
        }
        break;
      }
      case 'approvalRequest':
        showApprovalDialog(msg.id, msg.description, msg.preview);
        break;
      case 'attachFileAdded':
        pendingFiles.push({ filename: msg.filename });
        renderAttachChips();
        break;
      case 'clearAttachments':
        pendingFiles.length = 0;
        renderAttachChips();
        break;
      case 'piiNotice':
        showPiiNotice(msg.summary);
        break;
      case 'error':
        showError(msg.message);
        break;
      case 'modeChanged':
        state.mode = msg.mode;
        modeSelect.value = msg.mode;
        break;
      case 'conversationHistory':
        // Save current session history before switching.
        if (state.activeSessionId) saveInputHistory();
        // Clear and re-render. If the host sent actual messages
        // (e.g. session restore/switch), render them; otherwise
        // show the empty welcome state.
        state.messages = [];
        state.currentAssistantMessage = null;
        state.messageQueue = [];
        state.streaming = false;
        // Restore persisted history for the active session rather than clearing it.
        const _chId = state.activeSessionId || lastSessionData.activeSessionId;
        state.inputHistory = _chId ? loadInputHistory(_chId) : [];
        state.historyIndex = -1;
        state.historyDraft = '';
        textarea.classList.remove('history-mode');
        updateQueueBadge();
        updatePrimaryBtn();
        // Reset per-session auto-approve on session switch/new chat.
        sessionAutoApprove = false;
        // Clear activity log on new chat / session switch.
        activityLog.length = 0;
        if (msg.messages && msg.messages.length > 0) {
          messagesContainer.innerHTML = '';
          for (const m of msg.messages) {
            const role = m.role === 'user' ? 'user'
              : m.role === 'assistant' ? 'assistant'
              : null;
            if (role) {
              const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              appendMessage(role, text);
            }
          }
          // Not streaming — clear the cursor.
          state.currentAssistantMessage = null;
          // Show tour hint for users with prior history.
          showTourHintIfNeeded();
        } else {
          renderEmptyState();
        }
        break;
      case 'ready':
        // Initial handshake; could populate model info.
        break;
      case 'skillAutocompleteResponse':
        renderSkillDropdown(msg.suggestions || [], msg.prefix || '');
        break;
      case 'providerStatus':
        state.providerStatus = {
          state: msg.state,
          providerName: msg.providerName,
          modelName: msg.modelName,
          errorMessage: msg.errorMessage,
          available: msg.available || [],
        };
        renderProviderStatus();
        // Refresh the settings panel if it's currently visible.
        if (!settingsPanel.hasAttribute('hidden')) renderSettingsPanel();
        break;
      case 'firstRunWelcome':
        renderOnboardingPanel(msg.templates || []);
        break;
      case 'sessionList':
        // Update active session and restore its history.
        if (msg.activeSessionId && msg.activeSessionId !== state.activeSessionId) {
          if (state.activeSessionId) saveInputHistory();
          state.activeSessionId = msg.activeSessionId;
          state.inputHistory = loadInputHistory(msg.activeSessionId);
          state.historyIndex = -1;
          state.historyDraft = '';
        }
        renderSessionList(msg.sessions || [], msg.activeSessionId);
        break;
      case 'metricsUpdate':
        renderMetrics(msg);
        break;
      case 'mcpStatus':
        renderMcpPanel(msg.servers || []);
        break;
      case 'workflowHistoryUpdate':
        renderWorkflowStrip(msg.runs || []);
        break;
      case 'fileEditDiff': {
        const diffCard = el('div', { class: 'edit-diff-card' });
        const header = el('div', { class: 'edit-diff-header' });
        header.append(
          el('span', { class: 'edit-diff-path' }, [msg.path]),
          el('span', { class: 'edit-diff-badge' }, ['edited'])
        );
        const body = el('div', { class: 'edit-diff-body' });
        const hunks = splitHunks(msg.oldContent, msg.newContent);
        if (hunks.length === 0) {
          body.appendChild(el('div', { style: 'opacity:.5;font-size:11px;padding:2px 4px' }, ['No changes detected']));
        } else {
          hunks.slice(0, 3).forEach(function(hunk) {
            hunk.oldLines.forEach(function(l) { body.appendChild(el('div', { class: 'diff-line del' }, ['- ' + l])); });
            hunk.newLines.forEach(function(l) { body.appendChild(el('div', { class: 'diff-line add' }, ['+ ' + l])); });
          });
          if (hunks.length > 3) {
            body.appendChild(el('div', { style: 'opacity:.5;font-size:10px;padding:2px 4px' }, [
              '… ' + (hunks.length - 3) + ' more hunk(s) — see Review panel below'
            ]));
          }
        }
        diffCard.append(header, body);
        messagesWrapper.appendChild(diffCard);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        break;
      }
      case 'editSummary': {
        if (!msg.edits || msg.edits.length === 0) break;
        const panel = el('div', { class: 'edit-summary-panel' });
        panel.appendChild(el('div', { class: 'edit-summary-title' }, [
          '📝 Review ' + msg.edits.length + ' file change' + (msg.edits.length !== 1 ? 's' : '')
        ]));

        // Collect per-file revert buttons so bulk actions can disable them
        const perFileRevertBtns = [];

        // Bulk action row
        const bulkRow = el('div', { class: 'edit-summary-bulk-row' });
        const acceptAllBtn = el('button', { class: 'edit-accept-all-btn' }, ['✓ Accept All']);
        acceptAllBtn.title = 'Keep all agent file changes';
        const rejectAllBtn = el('button', { class: 'edit-reject-all-btn' }, ['↩ Reject All']);
        rejectAllBtn.title = 'Revert all agent file changes at once';

        acceptAllBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'acceptAllEdits' });
          acceptAllBtn.textContent = '✓ Accepted';
          acceptAllBtn.disabled = true;
          rejectAllBtn.disabled = true;
          perFileRevertBtns.forEach(function(btn) { btn.disabled = true; btn.textContent = '✓ Accepted'; });
          panel.style.opacity = '0.5';
        });

        rejectAllBtn.addEventListener('click', function() {
          var allEdits = msg.edits.map(function(e) { return { path: e.path, restoreContent: e.oldContent }; });
          vscode.postMessage({ type: 'revertAllEdits', edits: allEdits });
          rejectAllBtn.textContent = '✓ Reverted All';
          rejectAllBtn.disabled = true;
          acceptAllBtn.disabled = true;
          perFileRevertBtns.forEach(function(btn) { btn.disabled = true; btn.textContent = '✓ Reverted'; });
          panel.style.opacity = '0.5';
        });

        bulkRow.append(acceptAllBtn, rejectAllBtn);
        panel.appendChild(bulkRow);

        msg.edits.forEach(function(edit) {
          const fileSection = el('div', { class: 'edit-summary-file' });
          const fileHeader = el('div', { class: 'edit-summary-file-header' });
          const rejectBtn = el('button', { class: 'edit-reject-btn' }, ['↩ Revert']);
          perFileRevertBtns.push(rejectBtn);
          rejectBtn.title = 'Revert this file to its state before the agent edited it';
          rejectBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'revertEdit', path: edit.path, restoreContent: edit.oldContent });
            rejectBtn.textContent = '✓ Reverted';
            rejectBtn.disabled = true;
            fileSection.style.opacity = '0.5';
          });
          fileHeader.append(el('span', { class: 'edit-diff-path' }, [edit.path]), rejectBtn);
          const hunksEl = el('div', { class: 'edit-summary-hunks' });
          splitHunks(edit.oldContent, edit.newContent).forEach(function(hunk) {
            const hunkEl = el('div', { class: 'hunk' });
            hunk.oldLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line del' }, ['- ' + l])); });
            hunk.newLines.forEach(function(l) { hunkEl.appendChild(el('span', { class: 'diff-line add' }, ['+ ' + l])); });
            hunksEl.appendChild(hunkEl);
          });
          fileSection.append(fileHeader, hunksEl);
          panel.appendChild(fileSection);
        });
        messagesWrapper.appendChild(panel);
        messagesWrapper.scrollTop = messagesWrapper.scrollHeight;
        window.dispatchEvent(new CustomEvent('champ:editSummary', { detail: msg }));
        break;
      }
      case 'autoContextNotice': {
        if (!msg.files || msg.files.length === 0) break;
        var notice = el('div', { class: 'auto-context-notice' });
        notice.appendChild(el('span', { class: 'auto-context-icon' }, ['📎']));
        notice.appendChild(el('span', { class: 'auto-context-text' }, ['Auto-included: ' + msg.files.join(', ')]));
        messagesContainer.appendChild(notice);
        setTimeout(function() {
          notice.style.transition = 'opacity 0.5s';
          notice.style.opacity = '0';
          setTimeout(function() { notice.remove(); }, 500);
        }, 4000);
        break;
      }
      case 'mcpMarketplaceOpen':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceOpen', { detail: msg }));
        break;
      case 'mcpMarketplaceEntries':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceEntries', { detail: msg }));
        break;
      case 'mcpMarketplaceInstallComplete':
        window.dispatchEvent(new CustomEvent('champ:mcpMarketplaceInstallComplete', { detail: msg }));
        break;
      case 'teamRunSnapshot':
        window.dispatchEvent(new CustomEvent('champ:teamUpdate', { detail: msg }));
        break;
    }
  });

  // -------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else if (k === 'disabled' && v === 'true') node.setAttribute('disabled', 'disabled');
        else if (v !== undefined) node.setAttribute(k, String(v));
      }
    }
    if (children) {
      for (const child of children) {
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else node.appendChild(child);
      }
    }
    return node;
  }

  /** Create a codicon <i> element: codicon('copy') → <i class="codicon codicon-copy"></i> */
  function codicon(name) {
    return el('i', { class: `codicon codicon-${name}` });
  }

  function option(value, label) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }

  /**
   * Build a header icon button. Uses a single character glyph rather
   * than an SVG to keep the bundle tiny — VS Code's font already
   * includes glyphs that look reasonable in any theme.
   */
  /**
   * Build a header icon button. If glyph starts with 'codicon-', render
   * as a codicon <i> element; otherwise use the glyph as text.
   */
  function iconButton(glyph, ariaLabel, onClick) {
    const btn = el('button', { class: 'icon-btn', title: ariaLabel, 'aria-label': ariaLabel });
    if (glyph && glyph.startsWith('codicon-')) {
      btn.append(codicon(glyph.replace('codicon-', '')));
    } else if (glyph) {
      btn.append(document.createTextNode(glyph));
    }
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Delegated copy handler for code blocks.
  messagesContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.code-copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-block-wrapper')?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent || '').catch(() => {});
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  // Restore persisted input history if available.
  try {
    const s = vscode.getState() || {};
    if (s.inputHistories) {
      // Will be populated properly when sessionList arrives.
    }
  } catch {}
  // Signal readiness to the host.
  vscode.postMessage({ type: 'requestHistory' });
})();
