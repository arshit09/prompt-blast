/**
 * ============================================================
 *  PromptBlast — Background Service Worker
 * ============================================================
 *
 *  This is the "brain" of the extension. It:
 *   1. Listens for the "multicast" message from the popup
 *   2. Opens a new tab for each enabled AI service
 *   3. Waits for each tab to finish loading
 *   4. Injects the query into each tab via content scripts
 *
 *  All AI service definitions (URLs, selectors, etc.) live in
 *  the AI_SERVICES registry below. To add a new AI, just add
 *  an entry — no other changes needed.
 * ============================================================
 */

// ── AI Service Registry ──────────────────────────────────────
// Each service defines:
//   id          — Unique key (used in storage for enable/disable)
//   name        — Human-readable label
//   url         — The page to open
//   inputType   — "textarea" | "contenteditable" | "prosemirror"
//   selector    — CSS selector for the input element
//   submitType  — How to submit: "enter" (simulate Enter key),
//                 "button" (click a send button), or "both"
//   buttonSel   — (optional) CSS selector for the send button
//   waitMs      — Extra ms to wait after page load before typing
//
// NOTE: AI sites update their DOM frequently. If a service stops
// working, updating the `selector` / `buttonSel` here usually
// fixes it. Contributions welcome!
// ──────────────────────────────────────────────────────────────

const AI_SERVICES = [
  {
    id: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    inputType: "prosemirror",
    selector: "#prompt-textarea",
    submitType: "button",
    buttonSel: '[data-testid="send-button"]',
    waitMs: 2500,
  },
  {
    id: "claude",
    name: "Claude",
    url: "https://claude.ai/new",
    inputType: "contenteditable",
    selector: '[contenteditable="true"]',
    submitType: "button",
    buttonSel: 'button[aria-label="Send Message"]',
    waitMs: 2500,
  },
  {
    id: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    inputType: "contenteditable",
    selector: '.ql-editor[contenteditable="true"]',
    submitType: "button",
    buttonSel: 'button[aria-label="Send message"]',
    waitMs: 2500,
  },
  {
    id: "copilot",
    name: "Copilot",
    url: "https://copilot.microsoft.com/",
    inputType: "textarea",
    selector: "#userInput",
    submitType: "enter",
    waitMs: 2500,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    inputType: "textarea",
    selector: "textarea",
    submitType: "enter",
    waitMs: 2500,
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai/",
    inputType: "textarea",
    selector: 'textarea[placeholder*="Ask"]',
    submitType: "enter",
    waitMs: 2500,
  },
  {
    id: "poe",
    name: "Poe",
    url: "https://poe.com/",
    inputType: "textarea",
    selector: "textarea",
    submitType: "enter",
    waitMs: 2500,
  },
];

// Export the registry so other parts of the extension can import it
// (popup reads it via message passing)
// ──────────────────────────────────────────────────────────────


/**
 * Returns the user's settings merged with sane defaults.
 * Defaults: all original 5 services enabled, auto-submit ON,
 * group tabs ON, delay = 2000ms.
 */
async function getSettings() {
  const defaults = {
    enabledServices: ["chatgpt", "claude", "gemini", "copilot", "deepseek"],
    autoSubmit: true,
    groupTabs: true,
    delayMs: 2000,
  };

  const stored = await chrome.storage.sync.get("settings");
  return { ...defaults, ...(stored.settings || {}) };
}


// ── Message Listener ─────────────────────────────────────────
// The popup sends { action: "multicast", query: "..." }
// We also handle { action: "getServices" } for the popup/options

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "getServices") {
    // Return the full service registry so popup/options can render it
    sendResponse({ services: AI_SERVICES });
    return true;
  }

  if (message.action === "multicast") {
    handleMulticast(message.query);
    sendResponse({ ok: true });
    return true;
  }
});


/**
 * Core function: opens tabs and dispatches the query to each
 * enabled AI service, respecting user settings.
 */
async function handleMulticast(query) {
  const settings = await getSettings();
  const enabledIds = new Set(settings.enabledServices);

  // Filter to only the services the user has turned on
  const targets = AI_SERVICES.filter((s) => enabledIds.has(s.id));

  if (targets.length === 0) {
    console.warn("[PromptBlast] No services enabled — nothing to do.");
    return;
  }

  // Optionally group all new tabs together (Chrome 89+)
  let groupId = null;
  if (settings.groupTabs && chrome.tabs.group) {
    // We'll collect tab IDs and group them after creation
  }

  const tabIds = [];

  // Open all tabs in parallel for speed
  const tabPromises = targets.map((service) =>
    chrome.tabs.create({ url: service.url, active: false })
  );
  const tabs = await Promise.all(tabPromises);

  // Group the tabs if the setting is enabled
  if (settings.groupTabs && chrome.tabs.group) {
    try {
      const ids = tabs.map((t) => t.id);
      groupId = await chrome.tabs.group({ tabIds: ids });
      await chrome.tabGroups.update(groupId, {
        title: "PromptBlast",
        color: "blue",
        collapsed: false,
      });
    } catch (err) {
      console.warn("[PromptBlast] Tab grouping failed:", err);
    }
  }

  // For each tab, wait for it to load, then inject the query
  tabs.forEach((tab, index) => {
    const service = targets[index];
    waitForTabLoad(tab.id).then(() => {
      // Add configurable delay to let SPA frameworks hydrate
      const delay = settings.delayMs ?? service.waitMs ?? 2000;
      setTimeout(() => {
        injectQuery(tab.id, service, query, settings.autoSubmit);
      }, delay);
    });
  });

  // Activate the first tab so the user sees something happening
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
  }
}


/**
 * Returns a promise that resolves once a tab reaches "complete"
 * loading status. Times out after 30s to avoid hanging forever.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const TIMEOUT = 30_000;
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(); // proceed anyway after timeout
      }
    }, TIMEOUT);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    // In case the tab is already complete (cached page)
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete" && !resolved) {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolved = true;
        resolve();
      }
    });
  });
}


/**
 * Sends a message to the content script running in `tabId`,
 * telling it to fill in and (optionally) submit the query.
 */
function injectQuery(tabId, service, query, autoSubmit) {
  chrome.tabs.sendMessage(
    tabId,
    {
      action: "fillQuery",
      query,
      autoSubmit,
      inputType: service.inputType,
      selector: service.selector,
      submitType: service.submitType,
      buttonSel: service.buttonSel,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.warn(
          `[PromptBlast] Could not reach ${service.name}:`,
          chrome.runtime.lastError.message
        );
      } else {
        console.log(`[PromptBlast] ${service.name}:`, response);
      }
    }
  );
}
