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
// MAX_RETRIES and RETRY_INTERVAL are defined in scripts/constants.js
const SUBMIT_DELAY = 100;    // Reduced since we now wait for the button specifically

// Last-resort selectors tried when the service's own selector finds nothing.
// Ordered from most-specific to most-generic so we grab the right element.
const GENERIC_INPUT_FALLBACKS = {
  textarea:        'textarea:not([aria-hidden="true"])',
  contenteditable: '[contenteditable="true"][role="textbox"]:not([aria-hidden="true"]), [contenteditable="true"]:not([aria-hidden="true"])',
  prosemirror:     'div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]:not([aria-hidden="true"])',
};

const GENERIC_BUTTON_FALLBACKS =
  'button[aria-label*="send" i], button[aria-label*="submit" i], [data-testid*="send"], [data-testid*="submit"]';

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

    if (message.action === "testSelector") {
      (async () => {
        const { selector, buttonSel, inputType } = message;
        const inputEl = selector ? document.querySelector(selector) : null;
        if (!inputEl) {
          sendResponse({ ok: true, inputFound: false, buttonFound: null });
          return;
        }
        // Type a test string so button-activation logic fires
        try {
          if (inputType === "textarea") {
            fillTextarea(inputEl, "PromptBlast test");
          } else if (inputType === "prosemirror") {
            fillProseMirror(inputEl, "PromptBlast test");
          } else {
            fillContentEditable(inputEl, "PromptBlast test");
          }
        } catch {}
        // Give the page a moment to react (e.g. enable the send button)
        await new Promise((r) => setTimeout(r, 600));
        const buttonEl = buttonSel ? document.querySelector(buttonSel) : null;
        sendResponse({
          ok: true,
          inputFound: true,
          buttonFound: buttonSel ? !!buttonEl : null,
        });
      })();
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
    this.overlayPosition = "top";

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
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      z-index: 2147483647;
      display: none;
      align-items: flex-start;
      padding-top: 40px;
      justify-content: center;
      background: rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    `;

    // 2. Attach Shadow DOM
    this.shadow = this.container.attachShadow({ mode: "closed" });

    // 3. Inject CSS
    const fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap";
    this.shadow.appendChild(fontLink);

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
    this.enabledServiceIds = settings.enabledServices || ["chatgpt", "claude", "gemini"];

    // Apply saved theme to the shadow host
    applyTheme(this.container, settings.theme || "dark");

    // Load history (handle legacy plain-string format)
    const historyData = await chrome.storage.local.get("promptHistory");
    this.promptHistory = (historyData.promptHistory || []).map((h) =>
      typeof h === "string" ? { text: h, timestamp: Date.now() } : h
    );
    this.historyLimit = settings.historyLimit || MAX_HISTORY;
    this.showRecents = settings.showRecents !== false;
    this.overlayPosition = settings.overlayPosition || "center";
    this.chipDisplay = settings.chipDisplay || "logo-name";
    this.applyPosition();
  }

  applyPosition() {
    if (!this.container) return;
    switch (this.overlayPosition) {
      case "center":
        this.container.style.alignItems = "center";
        this.container.style.paddingTop = "0";
        this.container.style.paddingBottom = "0";
        break;
      case "bottom":
        this.container.style.alignItems = "flex-end";
        this.container.style.paddingTop = "0";
        this.container.style.paddingBottom = "40px";
        break;
      case "top":
      default:
        this.container.style.alignItems = "flex-start";
        this.container.style.paddingTop = "40px";
        this.container.style.paddingBottom = "0";
        break;
    }
  }

  setupListeners() {
    const promptInput = this.shadow.getElementById("promptInput");
    const sendBtn = this.shadow.getElementById("sendBtn");
    const settingsBtn = this.shadow.getElementById("settingsBtn");

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
    const mode = this.chipDisplay || "logo-name";
    serviceChipsEl.style.display = (mode === "none") ? "none" : "flex";
    serviceChipsEl.innerHTML = "";

    if (mode === "none") {
      this.updateSendButton();
      return;
    }

    this.allServices.forEach((service) => {
      const chip = document.createElement("button");
      chip.className = "chip";
      if (this.enabledServiceIds.includes(service.id)) {
        chip.classList.add("active");
      }
      const isDark = this.container.dataset.theme === "dark";
      const icon = (isDark && service.iconPathDark) ? service.iconPathDark : service.iconPath;
      const showLogo = mode === "logo-name" || mode === "logo";
      const showName = mode === "name" || mode === "logo-name";
      chip.innerHTML = [
        showLogo ? `<img src="${chrome.runtime.getURL(icon)}" class="service-icon" />` : "",
        showName ? service.name : ""
      ].join("");
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
    sendBtn.classList.add("sending");
    promptInput.disabled = true;

    const resetUI = () => {
      sendBtn.classList.remove("sending");
      promptInput.disabled = false;
      this.updateSendButton();
    };

    // Safety valve: re-enable the UI after 15 s if the callback never fires
    const abortTimer = setTimeout(() => {
      resetUI();
    }, 15000);

    await this.saveSettings();
    this.addToHistory(query);

    chrome.runtime.sendMessage(
      { action: "multicast", query: query },
      () => {
        clearTimeout(abortTimer);
        setTimeout(() => {
          this.hide();
          promptInput.value = "";
          resetUI();
        }, 300);
      }
    );
  }

  addToHistory(query) {
    this.promptHistory = this.promptHistory.filter((h) => h.text !== query);
    this.promptHistory.unshift({ text: query, timestamp: Date.now() });
    this.promptHistory = this.promptHistory.slice(0, this.historyLimit || MAX_HISTORY);
    chrome.storage.local.set({ promptHistory: this.promptHistory });
    this.renderHistory();
  }

  deleteFromHistory(prompt) {
    this.promptHistory = this.promptHistory.filter((h) => h.text !== prompt);
    chrome.storage.local.set({ promptHistory: this.promptHistory });
    this.renderHistory();
  }

  renderHistory() {
    const historySection = this.shadow.getElementById("historySection");
    const historyList = this.shadow.getElementById("historyList");
    if (!this.showRecents || this.promptHistory.length === 0) {
      historySection.classList.add("hidden");
      return;
    }
    historySection.classList.remove("hidden");
    historyList.innerHTML = "";
    this.promptHistory.forEach((entry) => {
      const prompt = entry.text;
      const li = document.createElement("li");
      li.className = "history-item";
      li.title = prompt;

      const textWrapper = document.createElement("div");
      textWrapper.className = "history-item-content";
      textWrapper.addEventListener("click", () => {
        const input = this.shadow.getElementById("promptInput");
        input.value = prompt;
        input.focus();
        this.updateSendButton();
      });

      const text = document.createElement("span");
      text.className = "history-item-text";
      text.textContent = prompt;

      const time = document.createElement("span");
      time.className = "history-item-time";
      time.textContent = formatRelativeTime(entry.timestamp);

      textWrapper.appendChild(text);
      textWrapper.appendChild(time);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "history-delete-btn";
      deleteBtn.title = "Remove from recents";
      deleteBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteFromHistory(prompt);
      });

      li.appendChild(textWrapper);
      li.appendChild(deleteBtn);
      historyList.appendChild(li);
    });
  }

  async saveSettings() {
    const stored = await chrome.storage.sync.get("settings");
    const settings = stored.settings || {};
    settings.enabledServices = this.enabledServiceIds;
    return chrome.storage.sync.set({ settings });
  }

  async updateShortcutHint() {
    const hint = this.shadow.getElementById("shortcutHint");
    const hintText = this.shadow.getElementById("shortcutText");
    if (!hint || !hintText) return;

    // Read the real shortcut from Chrome (via background script)
    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "getShortcut" }, resolve);
      });
      
      if (response?.shortcut) {
        hintText.textContent = response.shortcut.replace(/\+/g, " + ");
      } else {
        const isMac = navigator.platform.toUpperCase().includes("MAC");
        hintText.textContent = isMac ? "⌃ ⇧ A" : "Ctrl + Shift + A";
      }
    } catch {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      hintText.textContent = isMac ? "⌃ ⇧ A" : "Ctrl + Shift + A";
    }

    // Make it clickable: open options and scroll to keyboard shortcut section
    hint.style.cursor = "pointer";
    hint.title = "Click to change shortcut";
    // Avoid double listeners if show() is called multiple times
    if (!hint.dataset.listenerSet) {
      hint.addEventListener("click", async () => {
        await chrome.storage.local.set({ highlightShortcut: true });
        chrome.runtime.sendMessage({ action: "openOptions" });
        this.hide();
      });
      hint.dataset.listenerSet = "true";
    }
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
          <div class="input-footer" style="justify-content: flex-end;">
            <button id="sendBtn" class="send-btn" disabled title="Send Multicast">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
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
          <div class="shortcut-hint" id="shortcutHint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shortcut-icon">
              <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
              <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>
            </svg>
            <span class="shortcut-label">Shortcut:</span>
            <span id="shortcutText"></span>
          </div>
        </footer>
      </div>
    `;
  }

  getStyles() {
    return `
      :host {
        /* Ensure text-related properties don't inherit from the host site */
        all: initial;
        font-family: var(--font);

        /* Ensure smoothing and other text rendering basics */
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;

        /* Google light-mode palette */
        --bg-primary:   #ffffff;
        --bg-secondary: #f1f3f4;
        --bg-tertiary:  #e8eaed;
        --bg-hover:     #dadce0;
        --text-primary:   #202124;
        --text-secondary: #5f6368;
        --text-muted:     #80868b;
        --accent:       #fb923c;
        --accent-hover: #f97316;
        --accent-glow:  rgba(251, 146, 60, 0.15);
        --border:       #dadce0;
        --radius:       14px;
        --radius-sm:    8px;
        --transition:   200ms ease;
        --font: "Roboto", "Google Sans", system-ui, sans-serif;
      }

      :host([data-theme="dark"]) {
        /* Google dark-mode palette */
        --bg-primary:   #202124;
        --bg-secondary: #303134;
        --bg-tertiary:  #3c4043;
        --bg-hover:     #5f6368;
        --text-primary:   #e8eaed;
        --text-secondary: #bdc1c6;
        --text-muted:     #9aa0a6;
        --accent-glow:  rgba(249, 115, 22, 0.20);
        --border:       #3c4043;
      }

      * { 
        box-sizing: border-box; 
        margin: 0; 
        padding: 0; 
        font-family: var(--font);
      }

      .modal-container {
        width: 800px;
        max-width: 90vw;
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 32px;
        display: flex;
        flex-direction: column;
        gap: 20px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
        line-height: 1.5;
      }

      /* slideUp removed */

      .header { display: flex; align-items: center; justify-content: space-between; }
      .logo { display: flex; align-items: center; gap: 10px; }
      .logo h1 { font-size: 22px; font-weight: 700; }

      .icon-btn {
        background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
        color: var(--text-secondary); cursor: pointer; padding: 10px;
        display: flex; align-items: center; justify-content: center;
        transition: all var(--transition);
      }
      .icon-btn:hover { color: var(--text-primary); border-color: var(--text-muted); background: var(--bg-secondary); }

      .service-chips { display: flex; flex-wrap: wrap; gap: 10px; }
      .chip {
        display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px;
        min-width: 44px; border-radius: 999px; border: 2px solid var(--border);
        background: var(--bg-secondary); color: var(--text-secondary);
        font-size: 15px; font-weight: 400; cursor: pointer;
        transition: all var(--transition); user-select: none;
      }
      .chip:hover { border-color: var(--border); background: var(--bg-hover); }
      .chip.active { border-color: var(--accent); }
      .chip.active:hover { border-color: var(--accent-hover); background: var(--accent-glow); }
      .service-icon { width: 18px; height: 18px; object-fit: contain; filter: grayscale(1) opacity(0.6); transition: all var(--transition); }
      .chip.active .service-icon { filter: none; }

      textarea {
        flex: 1; min-width: 200px; padding: 10px 0; background: transparent; border: none; outline: none;
        color: var(--text-primary); font-family: var(--font); font-size: 18px;
        line-height: 1.6; resize: none; min-height: 30px;
      }
      textarea::placeholder { color: var(--text-muted); font-size: 16px; }

      .input-footer {
        display: flex; align-items: center; justify-content: flex-end;
        padding-bottom: 5px; background: transparent;
      }

      .input-area {
        display: flex; flex-direction: row; align-items: flex-end; background: var(--bg-secondary);
        border: 1px solid var(--border); border-radius: var(--radius);
        padding: 10px 10px 10px 20px; transition: border-color var(--transition);
        gap: 12px; flex-wrap: wrap;
      }

      .toggles { display: flex; align-items: center; gap: 20px; }

      .toggle-control { display: flex; align-items: center; gap: 8px; font-size: 15px; color: var(--text-secondary); cursor: pointer; }
      .toggle-control input { appearance: none; width: 18px; height: 18px; border: 2px solid var(--text-muted); border-radius: 4px; position: relative; cursor: pointer; transition: all var(--transition); }
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
        border-radius: var(--radius-sm); color: var(--text-secondary); font-size: 12px;
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
        display: flex; align-items: center; justify-content: center;
        width: 48px; height: 48px;
        border: none; border-radius: 50%;
        background: var(--accent); color: #fff; transition: all var(--transition);
        flex-shrink: 0;
      }
      .send-btn:hover:not(:disabled) { background: var(--accent-hover); }
      .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .history-section { display: flex; flex-direction: column; gap: 8px; }
      .hidden { display: none; }
      .history-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: var(--text-muted); }
      .history-list { list-style: none; display: flex; flex-direction: column; gap: 4px; }
      .history-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px 8px 16px; border-radius: var(--radius-sm);
        transition: background var(--transition);
      }
      .history-item:hover { background: var(--bg-hover); }
      .history-item:hover .history-delete-btn { opacity: 1; pointer-events: auto; }
      .history-item-content {
        flex: 1; display: flex; flex-direction: column; gap: 1px;
        cursor: pointer; overflow: hidden;
      }
      .history-item-text {
        font-size: 15px; color: var(--text-secondary);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        transition: color var(--transition);
      }
      .history-item:hover .history-item-text { color: var(--text-primary); }
      .history-item-time {
        font-size: 11px; color: var(--text-muted);
      }
      .history-delete-btn {
        flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        width: 24px; height: 24px; padding: 0; border: none; border-radius: 4px;
        background: none; color: var(--text-muted); cursor: pointer;
        opacity: 0; pointer-events: none;
        transition: all var(--transition);
      }
      .history-delete-btn:hover { background: var(--bg-tertiary); color: var(--text-primary); }

      .footer { display: flex; align-items: center; justify-content: center; padding-top: 8px; }
      .shortcut-hint { 
        display: flex; 
        align-items: center; 
        gap: 6px; 
        font-size: 12px; 
        color: var(--text-muted); 
        background: transparent; 
        padding: 5px 12px; 
        border-radius: var(--radius-sm);
        border: 1px solid transparent; 
        transition: all var(--transition);
      }
      .shortcut-hint:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-color: var(--text-muted);
      }
      .shortcut-icon { 
        stroke: var(--text-muted); 
        transition: stroke var(--transition);
      }
      .shortcut-hint:hover .shortcut-icon {
        stroke: var(--text-primary);
      }
      .shortcut-label { font-weight: 500; margin-right: -2px; }
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
  waitMs = 0,
}) {
  // Step 1: Wait for the page to settle before interacting
  if (waitMs > 0) await sleep(waitMs);

  // Step 2: Wait for the input element to appear in the DOM.
  // If the primary selector misses (site redesign), fall back to generic patterns.
  let element = await waitForElement(selector);
  if (!element) {
    const fallbackSel = GENERIC_INPUT_FALLBACKS[inputType] || GENERIC_INPUT_FALLBACKS.contenteditable;
    console.warn(`[PromptBlast] Primary selector failed ("${selector}"), trying generic fallback: ${fallbackSel}`);
    element = await waitForElement(fallbackSel);
  }
  if (!element) {
    return { ok: false, error: `Input not found: ${selector}` };
  }

  // Step 3: Focus the element (some sites need this to initialize)
  element.focus();
  await sleep(200);

  // Step 4: Fill the query based on the input type
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

  // Step 5: Submit if auto-submit is enabled
  if (autoSubmit) {
    // If we have a button selector, wait for it to be visible/enabled
    if (buttonSel && submitType !== "enter") {
      let btn = await waitForElement(buttonSel, true);
      let resolvedButtonSel = buttonSel;
      if (!btn) {
        console.warn(`[PromptBlast] Button selector failed ("${buttonSel}"), trying generic fallback`);
        btn = await waitForElement(GENERIC_BUTTON_FALLBACKS, true);
        resolvedButtonSel = GENERIC_BUTTON_FALLBACKS;
      }
      if (btn) {
        await sleep(SUBMIT_DELAY);
        submit(element, submitType, resolvedButtonSel);
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
 * Returns a human-readable relative time string (e.g. "2h ago").
 * @param {number} timestamp - Unix timestamp in ms
 */
function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}


/**
 * Simple sleep utility.
 * @param {number} ms - Milliseconds to wait
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Login Detection & Overlay ────────────────────────────────

class LoginNoticeOverlay {
  constructor(service) {
    this.service = service;
    this.container = document.createElement("div");
    this.container.id = "prompt-blast-login-notice";
    this.shadow = this.container.attachShadow({ mode: "open" });
    this.initPromise = this.init();
  }

  async init() {
    const stored = await chrome.storage.sync.get("settings");
    const theme = (stored.settings || {}).theme || "light";
    this.container.dataset.theme = theme;

    const style = document.createElement("style");
    style.textContent = this.getStyles();
    this.shadow.appendChild(style);

    this.shadow.innerHTML += this.getHTML();
    this.setupListeners();
    document.body.appendChild(this.container);
  }

  setupListeners() {
    this.shadow.getElementById("closeNotice")?.addEventListener("click", () => this.hide());
    this.shadow.getElementById("loginAction")?.addEventListener("click", () => this.hide());
    
    // Close on backdrop click
    this.shadow.querySelector(".overlay-backdrop")?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.hide();
    });
  }

  show() {
    this.container.style.display = "block";
    document.body.style.overflow = "hidden"; // Prevent scrolling behind modal
  }

  hide() {
    this.container.style.display = "none";
    document.body.style.overflow = "";
    setTimeout(() => this.container.remove(), 500);
  }

  getHTML() {
    return `
      <div class="overlay-backdrop">
        <div class="notice-card">
          <header class="header">
            <div class="logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="#fb923c" stroke-width="2"/>
                <path d="M8 12l3 3 5-6" stroke="#fb923c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <h1>PromptBlast</h1>
            </div>
            <button id="closeNotice" class="close-btn" title="Dismiss">&times;</button>
          </header>
          
          <div class="notice-content">
            <div class="service-info">
              <img src="${chrome.runtime.getURL(this.service.iconPath)}" class="service-icon" />
              <span class="service-name">${this.service.name}</span>
            </div>
            <p>Login required to use PromptBlast on this tool. Please sign in to enable multi-service prompting next time.</p>
          </div>

          <div class="notice-footer">
            <button id="loginAction" class="action-btn">Got it</button>
          </div>
        </div>
      </div>
    `;
  }

  getStyles() {
    return `
      :host {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 2147483647;
        font-family: "Roboto", "Google Sans", system-ui, sans-serif;
        display: none;
      }
      .overlay-backdrop {
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
      }
      .notice-card {
        width: 420px;
        max-width: 95vw;
        background: #ffffff;
        color: #202124;
        border: 1px solid #dadce0;
        border-radius: 20px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.4);
        padding: 32px;
        display: flex;
        flex-direction: column;
        gap: 24px;
        animation: pb-modal-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: auto;
      }
      @keyframes pb-modal-in {
        from { transform: scale(0.95) translateY(20px); opacity: 0; }
        to { transform: scale(1) translateY(0); opacity: 1; }
      }
      :host([data-theme="dark"]) .notice-card {
        background: #202124;
        color: #e8eaed;
        border-color: #3c4043;
      }
      .header { display: flex; align-items: center; justify-content: space-between; }
      .logo { display: flex; align-items: center; gap: 10px; }
      .logo h1 { font-size: 22px; font-weight: 700; margin: 0; color: inherit; }
      
      .notice-content { display: flex; flex-direction: column; gap: 12px; }
      .service-info { display: flex; align-items: center; gap: 10px; opacity: 0.8; }
      .service-icon { width: 20px; height: 20px; object-fit: contain; }
      .service-name { font-weight: 600; font-size: 15px; }
      
      .close-btn { 
        background: none; border: none; font-size: 28px; color: #80868b; 
        cursor: pointer; padding: 4px; line-height: 0.5; transition: all 0.2s;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%;
      }
      .close-btn:hover { color: #202124; background: rgba(0,0,0,0.05); }
      :host([data-theme="dark"]) .close-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }

      .notice-content p { margin: 0; font-size: 16px; line-height: 1.6; color: #3c4043; }
      :host([data-theme="dark"]) .notice-content p { color: #bdc1c6; }

      .action-btn {
        background: #fb923c;
        color: white;
        border: none;
        border-radius: 12px;
        padding: 14px 28px;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        width: 100%;
        transition: all 0.2s;
      }
      .action-btn:hover { 
        background: #f97316; 
      }
      .action-btn:active { transform: scale(0.98); }
    `;
  }
}

async function initLoginCheck() {
  // 1. Identify current service
  try {
    const response = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2000);
      chrome.runtime.sendMessage({ action: "getServices" }, (res) => {
        clearTimeout(timeout);
        resolve(res);
      });
    });
    if (!response?.services) return;

    const currentHostname = window.location.hostname;
    const service = response.services.find((s) => {
      try {
        return currentHostname.includes(new URL(s.url).hostname);
      } catch {
        return false;
      }
    });

    if (!service) return;

    // 2. Wait to see if the input appears (user might be logged in)
    // We check multiple times over 5 seconds
    let loggedIn = false;
    for (let i = 0; i < 5; i++) {
      if (document.querySelector(service.selector)) {
        loggedIn = true;
        break;
      }
      await sleep(1000);
    }
    if (loggedIn) return;

    // 3. Check for login markers
    const loginMarkers = service.loginSelector ? service.loginSelector.split(',') : [];
    let loginMarkerFound = false;
    for (const sel of loginMarkers) {
      if (sel.trim() && document.querySelector(sel.trim())) {
        loginMarkerFound = true;
        break;
      }
    }

    // Secondary heuristic: look for "Log in" or "Sign in" buttons if input is missing
    if (!loginMarkerFound) {
      const loginTerms = ["log in", "sign in", "get started", "sign up"];
      const buttons = Array.from(document.querySelectorAll("button, a"));
      loginMarkerFound = buttons.some((btn) => {
        const text = btn.textContent.toLowerCase();
        return loginTerms.some((term) => text.includes(term)) && btn.offsetParent !== null; // element is visible
      });
    }

    if (loginMarkerFound) {
      const notice = new LoginNoticeOverlay(service);
      await notice.initPromise;
      notice.show();
    }
  } catch (err) {
    console.warn("[PromptBlast] Login check skip:", err);
  }
}

// Initialize login check on load
if (document.readyState === "complete") {
  initLoginCheck();
} else {
  window.addEventListener("load", initLoginCheck);
}
