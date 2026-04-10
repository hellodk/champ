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
    currentAssistantMessage: /** @type {HTMLElement|null} */ (null),
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
  };

  // -------------------------------------------------------------------
  // DOM construction — top header
  // -------------------------------------------------------------------

  const root = document.getElementById('app');

  // Top header: app title + model indicator on the left, icon buttons on the right.
  const header = el('div', { class: 'header' });
  const headerLeft = el('div', { class: 'header-left' });
  const headerTitle = el('div', { class: 'header-title' }, ['Champ']);
  const headerSubtitle = el('div', { class: 'header-subtitle' }, ['loading…']);
  headerLeft.append(headerTitle, headerSubtitle);

  const headerRight = el('div', { class: 'header-right' });
  const newChatBtn = iconButton('+', 'New chat', () => {
    vscode.postMessage({ type: 'newSessionRequest' });
  });
  const settingsBtn = iconButton('⚙', 'Open settings', () => {
    vscode.postMessage({ type: 'openSettingsRequest' });
  });
  const helpBtn = iconButton('?', 'Show user guide', () => {
    vscode.postMessage({ type: 'showHelpRequest' });
  });
  headerRight.append(newChatBtn, settingsBtn, helpBtn);

  header.append(headerLeft, headerRight);

  // -------------------------------------------------------------------
  // DOM construction — session list (Cursor-style, time-grouped)
  // -------------------------------------------------------------------

  const sessionPanel = el('div', { class: 'session-panel' });

  // "New Agent" button at the top.
  const newAgentBtn = el('button', { class: 'new-agent-btn' }, ['New Agent']);
  newAgentBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSessionRequest' });
  });

  const sessionListEl = el('div', { class: 'session-list' });
  sessionPanel.append(newAgentBtn, sessionListEl);

  // Right-click context menu
  const ctxMenu = el('div', { class: 'ctx-menu', hidden: 'true' });
  let ctxSessionId = null;
  document.addEventListener('click', () => ctxMenu.setAttribute('hidden', 'true'));
  sessionPanel.append(ctxMenu);

  function showContextMenu(ev, sessionId) {
    ev.preventDefault();
    ev.stopPropagation();
    ctxSessionId = sessionId;
    ctxMenu.innerHTML = '';
    const items = [
      { label: 'Rename', action: () => {
        const name = prompt('Rename session:');
        if (name) vscode.postMessage({ type: 'renameSessionRequest', sessionId, newLabel: name });
      }},
      { label: 'Delete', action: () => {
        vscode.postMessage({ type: 'deleteSessionRequest', sessionId });
      }},
      { label: 'Archive', action: () => {
        // Archive is handled as delete for now — future: archiveSessionRequest
        vscode.postMessage({ type: 'deleteSessionRequest', sessionId });
      }},
    ];
    for (const item of items) {
      const row = el('div', { class: 'ctx-menu-item' }, [item.label]);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        ctxMenu.setAttribute('hidden', 'true');
        item.action();
      });
      ctxMenu.append(row);
    }
    ctxMenu.style.top = ev.clientY + 'px';
    ctxMenu.style.left = ev.clientX + 'px';
    ctxMenu.removeAttribute('hidden');
  }

  /**
   * Group sessions by time period and render, matching Cursor's style.
   */
  function renderSessionList(sessions, activeSessionId) {
    sessionListEl.innerHTML = '';
    if (!sessions || sessions.length === 0) return;

    const now = Date.now();
    const dayMs = 86400000;
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * dayMs;

    const groups = { today: [], last7: [], older: [] };
    for (const s of sessions) {
      const t = s.lastActivityAt || s.createdAt || 0;
      if (t >= todayStart) groups.today.push(s);
      else if (t >= weekAgo) groups.last7.push(s);
      else groups.older.push(s);
    }

    function renderGroup(label, items) {
      if (items.length === 0) return;
      const header = el('div', { class: 'session-group-header' }, [label]);
      sessionListEl.append(header);
      for (const s of items) {
        const row = el('div', {
          class: `session-row${s.id === activeSessionId ? ' active' : ''}`,
        });
        // Status icon
        const icon = el('span', { class: 'session-icon' });
        if (s.state === 'completed') icon.textContent = '✓';
        else if (s.state === 'errored') icon.textContent = '✗';
        else if (s.state === 'running') icon.textContent = '●';
        else icon.textContent = '○';
        icon.classList.add('state-' + s.state);

        const label = el('span', { class: 'session-label' }, [s.label || 'New chat']);

        row.append(icon, label);
        row.addEventListener('click', () => {
          if (s.id !== activeSessionId) {
            vscode.postMessage({ type: 'switchSessionRequest', sessionId: s.id });
          }
        });
        row.addEventListener('contextmenu', (ev) => showContextMenu(ev, s.id));
        sessionListEl.append(row);
      }
    }

    renderGroup('Today', groups.today);
    renderGroup('Last 7 Days', groups.last7);
    renderGroup('Older', groups.older);
  }

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

  // Hidden file input for the paperclip attach button.
  // Accept all file types: text, images, videos, PDFs, etc.
  const fileInput = el('input', { type: 'file', class: 'hidden-file-input', multiple: 'true', accept: '*/*' });
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (!files || files.length === 0) return;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = /** @type {string} */ (reader.result).split(',')[1] || '';
        pendingFiles.push({ filename: file.name, contentBase64: base64, mimeType: file.type || 'application/octet-stream' });
        vscode.postMessage({ type: 'attachFileRequest', filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64 });
        renderAttachChips();
      };
      reader.readAsDataURL(file);
    }
    // Reset so the same file can be re-selected.
    fileInput.value = '';
  });

  const attachBtn = el('button', { class: 'attach-btn', title: 'Attach file', 'aria-label': 'Attach file' }, ['📎']);
  attachBtn.addEventListener('click', () => fileInput.click());

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
    placeholder: 'Ask Champ anything... (/ for slash commands, Enter to send, Shift+Enter for newline)',
  });
  // Slash-command autocomplete dropdown — hidden until the user types
  // a / at the start of the input.
  const skillDropdown = el('div', { class: 'skill-dropdown', hidden: 'true' });

  // Bottom bar: Mode select, Model select, Cancel/Send buttons.
  const bottomBar = el('div', { class: 'bottom-bar' });

  const modeSelect = el('select', { class: 'mode-select', title: 'Agent mode' }, [
    option('agent', 'Agent'),
    option('ask', 'Ask'),
    option('manual', 'Manual'),
    option('plan', 'Plan'),
    option('composer', 'Composer'),
  ]);
  modeSelect.value = state.mode;
  modeSelect.addEventListener('change', () => {
    state.mode = modeSelect.value;
    vscode.postMessage({ type: 'setMode', mode: state.mode });
  });

  // Model picker — Cursor-style popup instead of native <select>.
  const modelPickerBtn = el('button', { class: 'model-picker-btn', title: 'Switch model' }, ['Auto']);
  const modelPickerPopup = el('div', { class: 'model-picker-popup', hidden: 'true' });
  const modelSearchInput = el('input', { type: 'text', class: 'model-search', placeholder: 'Search models' });
  const modelListEl = el('div', { class: 'model-list' });
  modelPickerPopup.append(modelSearchInput, modelListEl);

  // Toggle popup on button click.
  modelPickerBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
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

  function renderModelList(filter) {
    modelListEl.innerHTML = '';
    const available = state.providerStatus.available || [];
    const query = filter.toLowerCase();
    for (const m of available) {
      if (query && !m.label.toLowerCase().includes(query) && !m.providerName.toLowerCase().includes(query)) continue;
      const row = el('div', { class: 'model-row' });
      const isActive = m.providerName === state.providerStatus.providerName;
      if (isActive) row.classList.add('active');
      const nameEl = el('span', { class: 'model-name' }, [m.modelName || m.providerName]);
      const tagEl = el('span', { class: 'model-tag' }, [m.providerName]);
      if (isActive) {
        const check = el('span', { class: 'model-check' }, ['✓']);
        row.append(nameEl, tagEl, check);
      } else {
        row.append(nameEl, tagEl);
      }
      row.addEventListener('click', () => {
        vscode.postMessage({ type: 'setModelRequest', providerName: m.providerName });
        modelPickerPopup.setAttribute('hidden', 'true');
      });
      modelListEl.append(row);
    }
    if (modelListEl.children.length === 0) {
      modelListEl.append(el('div', { class: 'model-empty' }, ['No models match']));
    }
  }

  const bottomSpacer = el('div', { class: 'bottom-spacer' });

  const cancelBtn = el('button', { class: 'secondary', disabled: 'true' }, ['Cancel']);
  const sendBtn = el('button', {}, ['Send']);

  sendBtn.addEventListener('click', sendCurrentInput);
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelRequest' });
    setStreaming(false);
  });

  bottomBar.append(modeSelect, modelPickerBtn, bottomSpacer, cancelBtn, sendBtn);

  textarea.addEventListener('input', () => {
    handleSkillInput();
  });

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
    // Enter sends, Shift+Enter inserts newline.
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      sendCurrentInput();
    }
  });

  // Textarea row: attach button + textarea side by side.
  const textareaRow = el('div', { class: 'textarea-row' });
  textareaRow.append(attachBtn, textarea, fileInput);

  // Metrics footer — tiny status line below the bottom bar.
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

  inputArea.append(skillDropdown, attachChips, textareaRow, modelPickerPopup, bottomBar, metricsFooter);

  // Wrap messages + scroll pill in a positioned container.
  const messagesWrapper = el('div', { class: 'messages-wrapper' });
  messagesWrapper.append(messagesContainer, scrollPill);

  root.append(header, sessionPanel, messagesWrapper, inputArea);

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

    // Model picker button label.
    if (!ps.available || ps.available.length === 0) {
      modelPickerBtn.style.display = 'none';
    } else {
      modelPickerBtn.style.display = '';
      const activeLabel = ps.providerName && ps.modelName
        ? `${ps.modelName}`
        : ps.providerName || 'Auto';
      modelPickerBtn.textContent = activeLabel + ' ▾';
    }
  }

  // Initial render so the user sees "loading…" immediately on open.
  renderProviderStatus();

  // -------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------

  function sendCurrentInput() {
    const text = textarea.value.trim();
    if (!text || state.streaming) return;
    closeSkillDropdown();
    vscode.postMessage({ type: 'userMessage', text });
    appendMessage('user', text);
    state.currentAssistantMessage = appendMessage('assistant', '');
    textarea.value = '';
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
    state.skillSuggestions = [];
    state.skillHighlight = -1;
    state.lastSkillPrefix = null;
    skillDropdown.innerHTML = '';
    skillDropdown.setAttribute('hidden', 'true');
  }

  function setStreaming(streaming) {
    state.streaming = streaming;
    sendBtn.disabled = streaming;
    cancelBtn.disabled = !streaming;
    if (!streaming && state.currentAssistantMessage) {
      const body = state.currentAssistantMessage.querySelector('.body');
      if (body) body.classList.remove('streaming-cursor');
      state.currentAssistantMessage = null;
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
    const bodyEl = el('div', { class: 'body' }, [text]);
    if (role === 'assistant') bodyEl.classList.add('streaming-cursor');

    // Hover actions: copy + retry (Cursor-style — appear on hover).
    const actions = el('div', { class: 'msg-actions' });
    const copyBtn = el('button', { class: 'msg-action', title: 'Copy to clipboard' }, ['📋']);
    copyBtn.addEventListener('click', () => {
      const content = bodyEl.textContent || '';
      navigator.clipboard.writeText(content).catch(() => {});
    });
    actions.append(copyBtn);

    if (role === 'user') {
      const retryBtn = el('button', { class: 'msg-action', title: 'Retry this message' }, ['↻']);
      retryBtn.addEventListener('click', () => {
        // Truncate conversation to this message and resend.
        const originalText = state.messages[msgIdx]?.text || text;
        state.messages.splice(msgIdx);
        state.currentAssistantMessage = null;
        // Re-render all remaining messages.
        messagesContainer.innerHTML = '';
        if (state.messages.length === 0) {
          renderEmptyState();
        } else {
          for (const m of state.messages) {
            appendMessage(m.role, m.text);
          }
        }
        // Re-send.
        textarea.value = originalText;
        sendCurrentInput();
      });
      actions.append(retryBtn);
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
    }
    const body = state.currentAssistantMessage.querySelector('.body');
    if (body) {
      body.textContent = (body.textContent || '') + text;
      if (userScrolledUp) {
        scrollPill.removeAttribute('hidden');
      } else {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }
  }

  function appendToolCallCard(toolName, args) {
    if (!state.currentAssistantMessage) {
      state.currentAssistantMessage = appendMessage('assistant', '');
    }
    const card = el('div', { class: 'tool-card' });
    const name = el('div', { class: 'tool-name' }, [`🔧 ${toolName}`]);
    const argsEl = el('div', { class: 'tool-args' }, [JSON.stringify(args, null, 2)]);
    const resultEl = el('div', { class: 'tool-result' }, ['Running...']);
    card.append(name, argsEl, resultEl);
    state.currentAssistantMessage.append(card);
    card.dataset.toolName = toolName;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return card;
  }

  function updateToolCallResult(toolName, result, success) {
    if (!state.currentAssistantMessage) return;
    const cards = state.currentAssistantMessage.querySelectorAll('.tool-card');
    for (let i = cards.length - 1; i >= 0; i--) {
      const card = cards[i];
      if (card.dataset.toolName === toolName && !card.dataset.completed) {
        card.dataset.completed = 'true';
        if (!success) card.classList.add('error');
        const resultEl = card.querySelector('.tool-result');
        if (resultEl) resultEl.textContent = result;
        return;
      }
    }
  }

  function showError(message) {
    const messageEl = el('div', { class: 'message error' });
    messageEl.append(el('div', { class: 'body' }, [message]));
    messagesContainer.append(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setStreaming(false);
  }

  function renderEmptyState() {
    messagesContainer.innerHTML = '';
    const empty = el('div', { class: 'empty-state' });
    empty.append(
      el('div', { class: 'title' }, ['Welcome to Champ']),
      el('div', {}, ['Start by asking a question about your code,']),
      el('div', {}, ['requesting a fix, or asking for a refactor.']),
    );
    messagesContainer.append(empty);
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

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'streamDelta':
        appendStreamDelta(msg.text || '');
        break;
      case 'streamEnd':
        setStreaming(false);
        break;
      case 'toolCallStart':
        appendToolCallCard(msg.toolName, msg.args);
        break;
      case 'toolCallResult':
        updateToolCallResult(msg.toolName, msg.result, msg.success);
        break;
      case 'error':
        showError(msg.message);
        break;
      case 'modeChanged':
        state.mode = msg.mode;
        modeSelect.value = msg.mode;
        break;
      case 'conversationHistory':
        // Clear and re-render. If the host sent actual messages
        // (e.g. session restore/switch), render them; otherwise
        // show the empty welcome state.
        state.messages = [];
        state.currentAssistantMessage = null;
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
        break;
      case 'firstRunWelcome':
        renderOnboardingPanel(msg.templates || []);
        break;
      case 'sessionList':
        renderSessionList(msg.sessions || [], msg.activeSessionId);
        break;
      case 'metricsUpdate':
        renderMetrics(msg);
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
  function iconButton(glyph, ariaLabel, onClick) {
    const btn = el('button', { class: 'icon-btn', title: ariaLabel, 'aria-label': ariaLabel }, [glyph]);
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Signal readiness to the host.
  vscode.postMessage({ type: 'requestHistory' });
})();
