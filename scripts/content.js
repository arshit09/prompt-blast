if (window.PromptBlastLoaded) {
  // If already loaded, just return but allow the listener registration below
  // Actually, we want to prevent double-registration.
} else {
  window.PromptBlastLoaded = true;
}

/**
 * ============================================================
 *  PromptBlast — Content Script
 * ============================================================
 *
 *  Injected into each AI website. Listens for the "fillQuery"
 *  message from the background worker, then:
 *    1. Finds the input element using the provided CSS selector
 *    2. Fills it with the user's query (handling textarea,
 *       contenteditable, and ProseMirror editors)
 *    3. Optionally submits the query (Enter key or button click)
 *
 *  Why is this complicated?
 *  ────────────────────────
 *  Modern AI chat UIs use React/Vue/Svelte with synthetic event
 *  systems. Simply setting `.value` won't trigger their state
 *  updates. We have to dispatch native DOM events so the
 *  framework "sees" the change. Contenteditable and ProseMirror
 *  editors need different handling altogether.
 * ============================================================
 */

// ── Configuration ────────────────────────────────────────────
const MAX_RETRIES = 30;      // Increased for slow-loading SPAs
const RETRY_INTERVAL = 500;  // ms between retries
const SUBMIT_DELAY = 100;    // Reduced since we now wait for the button specifically

// ── Message Listener ─────────────────────────────────────────
// Only add the listener if it hasn't been added before
if (!window.PromptBlastListenerAdded) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "fillQuery") {
      fillAndSubmit(message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep the message channel open for async response
    }

    if (message.action === "toggleOverlay") {
      toggleOverlay();
      sendResponse({ ok: true });
      return true;
    }
  });
  window.PromptBlastListenerAdded = true;
}

// ── Overlay Implementation ───────────────────────────────────
let overlayInstance = null;

async function toggleOverlay() {
  if (!overlayInstance) {
    overlayInstance = new PromptBlastOverlay();
    await overlayInstance.initPromise;
  }
  overlayInstance.toggle();
}

class PromptBlastOverlay {
  constructor() {
    this.visible = false;
    this.container = null;
    this.shadow = null;
    this.allServices = [];
    this.enabledServiceIds = [];
    this.promptHistory = [];
    this.MAX_HISTORY = 5;

    this.initPromise = this.init();
  }

  async init() {
    // 1. Create the container
    this.container = document.createElement("div");
    this.container.id = "prompt-blast-root";
    this.container.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 2147483647;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    `;

    // 2. Attach Shadow DOM
    this.shadow = this.container.attachShadow({ mode: "closed" });

    // 3. Inject CSS
    const style = document.createElement("style");
    style.textContent = this.getStyles();
    this.shadow.appendChild(style);

    // 4. Inject HTML
    this.shadow.innerHTML += this.getHTML();

    // 5. Setup Local State & Listeners
    await this.loadData();
    this.setupListeners();
    this.renderServiceChips();
    this.renderHistory();
    this.updateShortcutHint();

    document.body.appendChild(this.container);
  }

  async loadData() {
    // Fetch services from background
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getServices" }, resolve);
    });
    this.allServices = response?.services || [];

    // Load settings
    const stored = await chrome.storage.sync.get("settings");
    const settings = stored.settings || {};
    this.enabledServiceIds = settings.enabledServices || this.allServices.map((s) => s.id);

    // Load history
    const historyData = await chrome.storage.local.get("promptHistory");
    this.promptHistory = historyData.promptHistory || [];

    // Set toggles
    const autoSubmitToggle = this.shadow.getElementById("autoSubmitToggle");
    if (autoSubmitToggle) {
      autoSubmitToggle.checked = settings.autoSubmit !== false;
    }

    const groupTabsToggle = this.shadow.getElementById("groupTabsToggle");
    if (groupTabsToggle) {
      groupTabsToggle.checked = settings.groupTabs !== false;
    }

    const cycleTabsToggle = this.shadow.getElementById("cycleTabsToggle");
    if (cycleTabsToggle) {
      cycleTabsToggle.checked = settings.cycleTabs === true;
    }
  }

  setupListeners() {
    const promptInput = this.shadow.getElementById("promptInput");
    const sendBtn = this.shadow.getElementById("sendBtn");
    const settingsBtn = this.shadow.getElementById("settingsBtn");
    const autoSubmitToggle = this.shadow.getElementById("autoSubmitToggle");
    const groupTabsToggle = this.shadow.getElementById("groupTabsToggle");
    const cycleTabsToggle = this.shadow.getElementById("cycleTabsToggle");

    const modal = this.shadow.querySelector(".modal-container");

    // Close on backdrop click (but NOT when clicking inside the modal)
    this.container.addEventListener("click", (e) => {
      if (e.target === this.container) this.hide();
    });

    // Prevent clicks inside the modal from bubbling up to the backdrop
    modal.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Close on Escape - scoped to the overlay container when visible
    this.container.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.hide();
      }
    });

    // Send button click
    sendBtn.addEventListener("click", () => this.handleSend());

    // Enter to send, Shift+Enter for newline
    promptInput.addEventListener("keydown", (e) => {
      e.stopPropagation(); // Prevent the host page from seeing this keydown
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    promptInput.addEventListener("keyup", (e) => {
      e.stopPropagation();
    });

    promptInput.addEventListener("keypress", (e) => {
      e.stopPropagation();
    });

    // Enable/disable send button based on input
    promptInput.addEventListener("input", () => this.updateSendButton());

    // Settings button
    settingsBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openOptions" });
      this.hide();
    });

    // Auto-submit toggle change
    autoSubmitToggle.addEventListener("change", () => this.saveSettings());

    // Group tabs toggle change
    groupTabsToggle.addEventListener("change", () => this.saveSettings());

    // Cycle tabs toggle change
    cycleTabsToggle.addEventListener("change", () => this.saveSettings());
  }

  toggle() {
    if (this.visible) {
      this.hide();
    } else {
      this.show();
    }
  }

  show() {
    this.visible = true;
    this.container.style.display = "flex";
    setTimeout(() => {
      const input = this.shadow.getElementById("promptInput");
      input.focus();
    }, 50);
  }

  hide() {
    this.visible = false;
    this.container.style.display = "none";
  }

  renderServiceChips() {
    const serviceChipsEl = this.shadow.getElementById("serviceChips");
    serviceChipsEl.innerHTML = "";

    this.allServices.forEach((service) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      if (this.enabledServiceIds.includes(service.id)) {
        chip.classList.add("active");
      }
      chip.innerHTML = `<span class="dot"></span>${service.name}`;
      chip.addEventListener("click", () => this.toggleService(service.id));
      serviceChipsEl.appendChild(chip);
    });

    this.updateSendButton();
  }

  toggleService(id) {
    const index = this.enabledServiceIds.indexOf(id);
    if (index >= 0) {
      this.enabledServiceIds.splice(index, 1);
    } else {
      this.enabledServiceIds.push(id);
    }
    this.renderServiceChips();
    this.saveSettings();
  }

  updateSendButton() {
    const promptInput = this.shadow.getElementById("promptInput");
    const sendBtn = this.shadow.getElementById("sendBtn");
    const hasQuery = promptInput.value.trim().length > 0;
    const hasServices = this.enabledServiceIds.length > 0;
    sendBtn.disabled = !(hasQuery && hasServices);
  }

  async handleSend() {
    const promptInput = this.shadow.getElementById("promptInput");
    const query = promptInput.value.trim();
    if (!query || this.enabledServiceIds.length === 0) return;

    const sendBtn = this.shadow.getElementById("sendBtn");
    sendBtn.disabled = true;
    promptInput.disabled = true;

    await this.saveSettings();
    this.addToHistory(query);

    chrome.runtime.sendMessage(
      { action: "multicast", query: query },
      () => {
        setTimeout(() => {
          this.hide();
          promptInput.value = "";
          promptInput.disabled = false;
          this.updateSendButton();
        }, 300);
      }
    );
  }

  addToHistory(query) {
    this.promptHistory = this.promptHistory.filter((h) => h !== query);
    this.promptHistory.unshift(query);
    this.promptHistory = this.promptHistory.slice(0, this.MAX_HISTORY);
    chrome.storage.local.set({ promptHistory: this.promptHistory });
    this.renderHistory();
  }

  renderHistory() {
    const historySection = this.shadow.getElementById("historySection");
    const historyList = this.shadow.getElementById("historyList");
    if (this.promptHistory.length === 0) {
      historySection.classList.add("hidden");
      return;
    }
    historySection.classList.remove("hidden");
    historyList.innerHTML = "";
    this.promptHistory.forEach((prompt) => {
      const li = document.createElement("li");
      li.textContent = prompt;
      li.title = prompt;
      li.addEventListener("click", () => {
        const input = this.shadow.getElementById("promptInput");
        input.value = prompt;
        input.focus();
        this.updateSendButton();
      });
      historyList.appendChild(li);
    });
  }

  saveSettings() {
    const autoSubmitToggle = this.shadow.getElementById("autoSubmitToggle");
    const groupTabsToggle = this.shadow.getElementById("groupTabsToggle");
    const cycleTabsToggle = this.shadow.getElementById("cycleTabsToggle");
    return chrome.storage.sync.set({
      settings: {
        enabledServices: this.enabledServiceIds,
        autoSubmit: autoSubmitToggle.checked,
        groupTabs: groupTabsToggle.checked,
        cycleTabs: cycleTabsToggle.checked,
      },
    });
  }

  updateShortcutHint() {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const hint = this.shadow.getElementById("shortcutHint");
    if (hint) hint.textContent = isMac ? "⌃⇧A" : "Ctrl+Shift+A";
  }

  getHTML() {
    return `
      <div class="modal-container">
        <header class="header">
          <div class="logo">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="2"/>
              <path d="M8 12l3 3 5-6" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <h1>PromptBlast</h1>
          </div>
          <button id="settingsBtn" class="icon-btn" title="Settings">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.32 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </header>

        <div id="serviceChips" class="service-chips"></div>

        <div class="input-area">
          <textarea id="promptInput" placeholder="Type your prompt here…" rows="3" autofocus></textarea>
          <div class="input-footer">
            <div class="toggles">
              <label class="toggle-control">
                <input type="checkbox" id="autoSubmitToggle">
                <span>Auto-submit</span>
              </label>
              <label class="toggle-control">
                <input type="checkbox" id="groupTabsToggle">
                <span>Group Tabs</span>
              </label>
              <label class="toggle-control has-tooltip">
                <input type="checkbox" id="cycleTabsToggle">
                <span>Cycle Tabs</span>
                <div class="tooltip">Force activates each tab sequentially. Use this if AI sites fail to load in the background.</div>
              </label>
            </div>
            <button id="sendBtn" class="send-btn" disabled>
              <span>Multicast</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"/>
                <polyline points="12 5 19 12 12 19"/>
              </svg>
            </button>
          </div>
        </div>

        <div id="historySection" class="history-section hidden">
          <p class="history-label">Recent prompts</p>
          <ul id="historyList" class="history-list"></ul>
        </div>

        <footer class="footer">
          <span class="shortcut-hint" id="shortcutHint"></span>
          <a href="https://github.com/arshit09/prompt-blast" target="_blank" class="gh-link">GitHub ↗</a>
        </footer>
      </div>
    `;
  }

  getStyles() {
    return `
      :host {
        --bg-primary: #0f0f12;
        --bg-secondary: #1a1a22;
        --bg-tertiary: #24242f;
        --bg-hover: #2c2c3a;
        --text-primary: #e8e8ed;
        --text-secondary: #8888a0;
        --text-muted: #555568;
        --accent: #6c8aff;
        --accent-hover: #8ca4ff;
        --accent-glow: rgba(108, 138, 255, 0.15);
        --border: #2a2a38;
        --radius: 12px;
        --radius-sm: 8px;
        --transition: 150ms ease;
        --font: "Segoe UI", system-ui, -apple-system, sans-serif;
      }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      .modal-container {
        width: 100%;
        max-width: 600px;
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 24px;
        display: flex;
        flex-direction: column;
        gap: 20px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes slideUp {
        from { opacity: 0; transform: translateY(20px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      .header { display: flex; align-items: center; justify-content: space-between; }
      .logo { display: flex; align-items: center; gap: 10px; }
      .logo h1 { font-size: 1.25rem; font-weight: 700; }

      .icon-btn {
        background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
        color: var(--text-secondary); cursor: pointer; padding: 8px;
        display: flex; align-items: center; justify-content: center;
        transition: all var(--transition);
      }
      .icon-btn:hover { color: var(--text-primary); border-color: var(--text-muted); background: var(--bg-secondary); }

      .service-chips { display: flex; flex-wrap: wrap; gap: 8px; }
      .chip {
        display: flex; align-items: center; gap: 6px; padding: 6px 14px;
        border-radius: 999px; border: 1px solid var(--border);
        background: var(--bg-secondary); color: var(--text-secondary);
        font-size: 0.9rem; font-weight: 500; cursor: pointer;
        transition: all var(--transition); user-select: none;
      }
      .chip:hover { border-color: var(--text-muted); color: var(--text-primary); }
      .chip.active { background: var(--accent-glow); border-color: var(--accent); color: var(--accent); }
      .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
      .chip.active .dot { background: var(--accent); box-shadow: 0 0 8px var(--accent); }

      .input-area {
        display: flex; flex-direction: column; background: var(--bg-secondary);
        border: 1px solid var(--border); border-radius: var(--radius);
        overflow: hidden; transition: border-color var(--transition);
      }
      .input-area:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow); }

      textarea {
        width: 100%; padding: 16px; background: transparent; border: none; outline: none;
        color: var(--text-primary); font-family: var(--font); font-size: 1.1rem;
        line-height: 1.6; resize: none; min-height: 100px;
      }
      textarea::placeholder { color: var(--text-muted); }

      .input-footer {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 16px; border-top: 1px solid var(--border); background: var(--bg-tertiary);
      }

      .toggles { display: flex; align-items: center; gap: 16px; }

      .toggle-control { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: var(--text-secondary); cursor: pointer; }
      .toggle-control input { appearance: none; width: 16px; height: 16px; border: 2px solid var(--text-muted); border-radius: 4px; position: relative; cursor: pointer; transition: all var(--transition); }
      .toggle-control input:checked { background: var(--accent); border-color: var(--accent); }
      .toggle-control input:checked::after {
        content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
        border: solid white; border-width: 0 2px 2px 0; transform: rotate(45deg);
      }
      .toggle-control:hover span { color: var(--text-primary); }

      .has-tooltip { position: relative; }
      .tooltip {
        position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
        width: 200px; padding: 10px; background: var(--bg-tertiary); border: 1px solid var(--border);
        border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 0.75rem;
        line-height: 1.4; pointer-events: none; opacity: 0; visibility: hidden;
        transition: all var(--transition); z-index: 10;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      }
      .tooltip::after {
        content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
        border-width: 6px; border-style: solid; border-color: var(--border) transparent transparent transparent;
      }
      .has-tooltip:hover .tooltip { opacity: 1; visibility: visible; bottom: calc(100% + 6px); }

      .send-btn {
        display: flex; align-items: center; gap: 8px; padding: 10px 20px;
        border: none; border-radius: var(--radius-sm);
        background: var(--accent); color: #fff; font-family: var(--font);
        font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all var(--transition);
      }
      .send-btn:hover:not(:disabled) { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 15px rgba(108, 138, 255, 0.4); }
      .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .history-section { display: flex; flex-direction: column; gap: 8px; }
      .hidden { display: none; }
      .history-label { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
      .history-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
      .history-list li {
        padding: 10px 14px; border-radius: var(--radius-sm); font-size: 0.9rem;
        color: var(--text-secondary); cursor: pointer; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; transition: all var(--transition);
      }
      .history-list li:hover { background: var(--bg-hover); color: var(--text-primary); }

      .footer { display: flex; align-items: center; justify-content: space-between; padding-top: 10px; border-top: 1px solid var(--border); }
      .shortcut-hint { font-size: 0.8rem; color: var(--text-muted); background: var(--bg-secondary); padding: 4px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
      .gh-link { font-size: 0.8rem; color: var(--text-muted); text-decoration: none; }
      .gh-link:hover { color: var(--accent); }
    `;
  }
}


/**
 * Main entry point. Finds the input element (with retries),
 * fills it with the query, and optionally submits.
 *
 * @param {Object} params - Destructured from the message
 * @param {string} params.query       — The user's prompt
 * @param {string} params.inputType   — "textarea" | "contenteditable" | "prosemirror"
 * @param {string} params.selector    — CSS selector for the input
 * @param {boolean} params.autoSubmit — Whether to auto-press Enter / click Send
 * @param {string} params.submitType  — "enter" | "button" | "both"
 * @param {string} [params.buttonSel] — CSS selector for the send button
 */
async function fillAndSubmit({
  query,
  inputType,
  selector,
  autoSubmit,
  submitType,
  buttonSel,
}) {
  // Step 1: Wait for the input element to appear in the DOM
  const element = await waitForElement(selector);
  if (!element) {
    return { ok: false, error: `Input not found: ${selector}` };
  }

  // Step 2: Focus the element (some sites need this to initialize)
  element.focus();
  await sleep(200);

  // Step 3: Fill the query based on the input type
  let filled = false;
  switch (inputType) {
    case "textarea":
      filled = fillTextarea(element, query);
      break;
    case "contenteditable":
      filled = fillContentEditable(element, query);
      break;
    case "prosemirror":
      filled = fillProseMirror(element, query);
      break;
    default:
      // Fallback: try textarea first, then contenteditable
      filled = fillTextarea(element, query) || fillContentEditable(element, query);
  }

  if (!filled) {
    return { ok: false, error: "Could not fill the input element" };
  }

  // Step 4: Submit if auto-submit is enabled
  if (autoSubmit) {
    // If we have a button selector, wait for it to be visible/enabled
    if (buttonSel && submitType !== "enter") {
      const btn = await waitForElement(buttonSel, true);
      if (btn) {
        await sleep(SUBMIT_DELAY);
        submit(element, submitType, buttonSel);
      } else {
        console.warn("[PromptBlast] Submit button NOT found after filling:", buttonSel);
        // Fallback: try enter key anyway
        submit(element, "enter", null);
      }
    } else {
      await sleep(SUBMIT_DELAY);
      submit(element, submitType, buttonSel);
    }
  }

  return { ok: true };
}


// ── Input Filling Strategies ─────────────────────────────────

/**
 * Fills a standard <textarea> or <input> element.
 * Uses the native setter to bypass React's synthetic event system.
 */
function fillTextarea(el, query) {
  try {
    // Use the native HTMLTextAreaElement/HTMLInputElement setter
    // so React/Vue/Angular detect the change
    const nativeSetter =
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value"
      )?.set ||
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, "value"
      )?.set;

    if (nativeSetter) {
      nativeSetter.call(el, query);
    } else {
      el.value = query;
    }

    // Dispatch events that frameworks listen for
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));

    return true;
  } catch (err) {
    console.error("[PromptBlast] fillTextarea failed:", err);
    return false;
  }
}


/**
 * Fills a contenteditable div (used by Claude, Gemini, etc.).
 * Sets innerHTML and fires the 'input' event so the framework
 * picks up the change.
 */
function fillContentEditable(el, query) {
  try {
    el.focus();

    // Clear existing content
    el.textContent = "";

    // Insert a text node (more reliable than innerHTML for editors)
    const textNode = document.createTextNode(query);
    el.appendChild(textNode);

    // Move cursor to end
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    // Notify the framework with multiple events
    el.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: query,
    }));

    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: query,
    }));

    // Some sites also listen for 'textInput' or 'text'
    const textEvent = new CustomEvent("textInput", {
      bubbles: true,
      cancelable: true,
      detail: { data: query }
    });
    el.dispatchEvent(textEvent);

    return true;
  } catch (err) {
    console.error("[PromptBlast] fillContentEditable failed:", err);
    return false;
  }
}


/**
 * Fills a ProseMirror-based editor (used by ChatGPT).
 * ProseMirror doesn't respond to simple value changes;
 * we simulate keyboard input via execCommand or DataTransfer.
 */
function fillProseMirror(el, query) {
  try {
    el.focus();

    // Clear existing content in a framework-friendly way
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      return fillTextarea(el, query);
    }

    // Focus and select all
    el.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);

    // Method 1: Use execCommand (best for ProseMirror/React/Claude)
    try {
      // Deleting existing selection ensures the framework "sees" the change
      document.execCommand("delete", false, null);
      document.execCommand("insertText", false, query);
    } catch (e) {
      console.warn("[PromptBlast] execCommand failed, falling back...");
      // Manual fallback if execCommand is blocked
      el.textContent = query;
    }

    // Method 2: Use DataTransfer (clipboard-like paste) if execCommand didn't fill it
    if (!el.textContent || el.textContent.trim() === "") {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("text/plain", query);

      const pasteEvent = new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertFromPaste",
        data: query,
        dataTransfer: dataTransfer,
      });

      el.dispatchEvent(pasteEvent);
    }

    // Method 3: Final fallback to setting text manually + events
    if (!el.textContent || el.textContent.trim() === "") {
      el.textContent = query;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: query,
      }));
    }

    return true;
  } catch (err) {
    console.error("[PromptBlast] fillProseMirror failed:", err);
    // Fall back to contenteditable method
    return fillContentEditable(el, query);
  }
}


// ── Submit Strategies ────────────────────────────────────────

/**
 * Submits the query using the configured strategy.
 */
function submit(inputEl, submitType, buttonSel) {
  switch (submitType) {
    case "button":
      clickSubmitButton(buttonSel) || pressEnter(inputEl);
      break;
    case "both":
      clickSubmitButton(buttonSel);
      pressEnter(inputEl);
      break;
    case "enter":
    default:
      pressEnter(inputEl);
      break;
  }
}


/**
 * Simulates pressing Enter on the given element.
 */
function pressEnter(el) {
  const keydownEvent = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(keydownEvent);

  const keypressEvent = new KeyboardEvent("keypress", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(keypressEvent);

  const keyupEvent = new KeyboardEvent("keyup", {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(keyupEvent);
}


/**
 * Finds and clicks the send/submit button.
 * Retries a few times because some sites enable the button
 * only after detecting input (with a short delay).
 */
function clickSubmitButton(buttonSel) {
  if (!buttonSel) return false;

  let attempts = 0;
  const maxAttempts = 5;

  function tryClick() {
    const btn = document.querySelector(buttonSel);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    if (attempts < maxAttempts) {
      attempts++;
      setTimeout(tryClick, 300);
    }
    return false;
  }

  return tryClick();
}


// ── Utilities ────────────────────────────────────────────────

/**
 * Waits for a DOM element matching `selector` to appear.
 *
 * @param {string} selector - CSS selector to wait for
 * @param {boolean} checkEnabled - If true, also ensures the element is not disabled
 * @returns {Promise<Element|null>}
 */
function waitForElement(selector, checkEnabled = false) {
  return new Promise((resolve) => {
    function getEl() {
      const el = document.querySelector(selector);
      if (el && (!checkEnabled || !el.disabled)) return el;
      return null;
    }

    // Check immediately
    const existing = getEl();
    if (existing) return resolve(existing);

    let retries = 0;

    // MutationObserver: fast, event-driven detection
    const observer = new MutationObserver(() => {
      const el = getEl();
      if (el) {
        observer.disconnect();
        clearInterval(fallback);
        resolve(el);
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: checkEnabled,
      attributeFilter: checkEnabled ? ["disabled"] : undefined
    });

    // Fallback interval in case observer misses it
    const fallback = setInterval(() => {
      retries++;
      const el = getEl();
      if (el) {
        observer.disconnect();
        clearInterval(fallback);
        resolve(el);
      } else if (retries >= MAX_RETRIES) {
        observer.disconnect();
        clearInterval(fallback);
        resolve(null);
      }
    }, RETRY_INTERVAL);
  });
}


/**
 * Simple sleep utility.
 * @param {number} ms - Milliseconds to wait
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
