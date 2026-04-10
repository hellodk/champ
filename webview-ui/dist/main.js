/*
 * AIDev chat UI — vanilla JS webview entry point.
 *
 * Layout (Chat UI v2 — Phase A):
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Top header                               │
 *   │   AIDev                       [+] [⚙] [?]│
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
  const headerTitle = el('div', { class: 'header-title' }, ['AIDev']);
  const headerSubtitle = el('div', { class: 'header-subtitle' }, ['loading…']);
  headerLeft.append(headerTitle, headerSubtitle);

  const headerRight = el('div', { class: 'header-right' });
  const newChatBtn = iconButton('+', 'New chat', () => {
    vscode.postMessage({ type: 'newChat' });
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
  // DOM construction — messages list
  // -------------------------------------------------------------------

  const messagesContainer = el('div', { class: 'messages' });
  renderEmptyState();

  // -------------------------------------------------------------------
  // DOM construction — input area + bottom bar
  // -------------------------------------------------------------------

  const inputArea = el('div', { class: 'input-area' });
  const textarea = el('textarea', {
    placeholder: 'Ask AIDev anything... (/ for slash commands, Cmd/Ctrl+Enter to send)',
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

  const modelSelect = el('select', {
    class: 'model-select',
    title: 'Active model — pick a different one to switch providers',
  });
  modelSelect.addEventListener('change', () => {
    const providerName = modelSelect.value;
    if (!providerName) return;
    vscode.postMessage({ type: 'setModelRequest', providerName });
  });

  const bottomSpacer = el('div', { class: 'bottom-spacer' });

  const cancelBtn = el('button', { class: 'secondary', disabled: 'true' }, ['Cancel']);
  const sendBtn = el('button', {}, ['Send']);

  sendBtn.addEventListener('click', sendCurrentInput);
  cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelRequest' });
    setStreaming(false);
  });

  bottomBar.append(modeSelect, modelSelect, bottomSpacer, cancelBtn, sendBtn);

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
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      sendCurrentInput();
    }
  });

  inputArea.append(skillDropdown, textarea, bottomBar);

  root.append(header, messagesContainer, inputArea);

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

    // Model dropdown — populate from `available` and select the active row.
    modelSelect.innerHTML = '';
    if (!ps.available || ps.available.length === 0) {
      // Hide the dropdown when there's nothing to choose. The legacy
      // VS Code settings path doesn't enumerate providers so this is
      // the expected state on a fresh install with no YAML config.
      modelSelect.style.display = 'none';
      return;
    }
    modelSelect.style.display = '';
    for (const entry of ps.available) {
      const o = document.createElement('option');
      o.value = entry.providerName;
      o.textContent = entry.label;
      modelSelect.append(o);
    }
    if (ps.providerName) {
      modelSelect.value = ps.providerName;
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
    const msg = { role, text, toolCalls: [] };
    state.messages.push(msg);

    const messageEl = el('div', { class: `message ${role}` });
    const roleEl = el('div', { class: 'role' }, [role]);
    const bodyEl = el('div', { class: 'body' }, [text]);
    if (role === 'assistant') bodyEl.classList.add('streaming-cursor');
    messageEl.append(roleEl, bodyEl);
    messagesContainer.append(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return messageEl;
  }

  function appendStreamDelta(text) {
    if (!state.currentAssistantMessage) {
      state.currentAssistantMessage = appendMessage('assistant', '');
    }
    const body = state.currentAssistantMessage.querySelector('.body');
    if (body) {
      body.textContent = (body.textContent || '') + text;
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
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
    messageEl.append(
      el('div', { class: 'role' }, ['error']),
      el('div', { class: 'body' }, [message]),
    );
    messagesContainer.append(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setStreaming(false);
  }

  function renderEmptyState() {
    messagesContainer.innerHTML = '';
    const empty = el('div', { class: 'empty-state' });
    empty.append(
      el('div', { class: 'title' }, ['Welcome to AIDev']),
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
      el('div', { class: 'onboarding-title' }, ['Welcome to AIDev']),
      el('div', { class: 'onboarding-subtitle' }, [
        'No configuration found. Pick a starter template to create .aidev/config.yaml:',
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
        // Clear and render.
        state.messages = [];
        state.currentAssistantMessage = null;
        renderEmptyState();
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
