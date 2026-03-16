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
    buttonSel: '#composer-submit-button, [data-testid="send-button"]',
    waitMs: 2500,
  },
  {
    id: "claude",
    name: "Claude",
    url: "https://claude.ai/new",
    inputType: "prosemirror",
    selector: 'div[contenteditable="true"].ProseMirror, [contenteditable="true"]',
    submitType: "button",
    buttonSel: 'button[aria-label="Send message"], [aria-label="Send Message"], button:has(path[d^="M208.49"])',
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
    inputType: "contenteditable",
    selector: "#ask-input",
    submitType: "button",
    buttonSel: 'button[aria-label="Submit"]',
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
    enabledServices: ["chatgpt", "claude", "gemini", "copilot", "deepseek", "perplexity", "poe"],
    autoSubmit: true,
    groupTabs: true,
    cycleTabs: false,
    delayMs: 2000,
  };

  const stored = await chrome.storage.sync.get("settings");
  return { ...defaults, ...(stored.settings || {}) };
}


// ── Message Listener ─────────────────────────────────────────
// The popup sends { action: "multicast", query: "..." }
// We also handle { action: "getServices" } for the popup/options

// ── Action Click Listener ────────────────────────────────────
// When the extension icon is clicked, tell the content script to
// toggle the UI overlay. If the content script isn't found (e.g.
// on an already-open tab after install), we try to inject it.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  // Skip internal browser pages
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("edge://") || tab.url?.startsWith("about:")) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
  } catch (err) {
    // If connection fails, the script might not be injected yet
    if (err.message.includes("Could not establish connection")) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["scripts/content.js"]
        });
        // Try again after injection
        await chrome.tabs.sendMessage(tab.id, { action: "toggleOverlay" });
      } catch (injectErr) {
        console.warn("[PromptBlast] Manual injection failed:", injectErr);
      }
    } else {
      console.error("[PromptBlast] Toggle overlay failed:", err);
    }
  }
});


chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "getServices") {
    // Return the full service registry so popup/options can render it
    sendResponse({ services: AI_SERVICES });
    return true;
  }

  if (message.action === "multicast") {
    console.log("[PromptBlast] Starting multicast for query:", message.query);
    // We await this so the service worker stays alive and we can report completion
    handleMulticast(message.query).then((results) => {
      console.log("[PromptBlast] Multicast completed.");
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.action === "openOptions") {
    chrome.runtime.openOptionsPage();
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

  // Handle tab activation & injection
  if (tabs.length > 0) {
    console.log(`[PromptBlast] Target services: ${targets.map(t => t.name).join(", ")}`);
    console.log(`[PromptBlast] Cycle Tabs setting: ${settings.cycleTabs}`);

    // 1. Activate the first tab immediately so the user knows work has started
    chrome.tabs.update(tabs[0].id, { active: true });

    // 2. If Cycle Tabs is enabled, tour through all tabs FIRST to wake them up
    if (settings.cycleTabs) {
      console.log(`[PromptBlast] Starting initial tab tour for ${tabs.length} tabs to wake them up...`);
      for (const tab of tabs) {
        try {
          await chrome.tabs.update(tab.id, { active: true, highlighted: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          // Brief pause to allow the tab to wake up and Chrome to prioritize it
          await new Promise((r) => setTimeout(r, 800));
        } catch (err) {
          console.error(`[PromptBlast] Failed to activate tab ${tab.id}:`, err);
        }
      }
      console.log("[PromptBlast] Initial tour complete, returning focus to first tab.");
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      console.log("[PromptBlast] Cycling disabled, skipping tour.");
    }

    // 3. Fire all injections in parallel and track their completion.
    const injectionPromises = tabs.map((tab, index) => {
      const service = targets[index];
      return waitForTabLoad(tab.id)
        .then(() => ensureContentScript(tab.id))
        .then(() => {
          console.log(`[PromptBlast] Injecting into ${service.name}...`);
          return injectQuery(tab.id, service, query, settings.autoSubmit);
        })
        .catch((err) => {
          console.warn(`[PromptBlast] Pipeline failed for ${service.name}:`, err);
        });
    });

    // 4. Wait until every tab has finished its work (keeps the service worker alive).
    console.log("[PromptBlast] Waiting for all tabs to process query and submit...");
    await Promise.allSettled(injectionPromises);
    console.log("[PromptBlast] All background processing complete.");
  }
}


/**
 * Returns a promise that resolves once a tab reaches "complete"
 * loading status. Times out after 30s to avoid hanging forever.
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const TIMEOUT = 10_000; // Reduced to 10s to prevent tour from hanging
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        console.warn(`[PromptBlast] Tab ${tabId} load timed out after 10s`);
        resolved = true;
        resolve();
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
 * Ensures the content script is injected into a tab before messaging.
 * Silently succeeds if already injected.
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["scripts/content.js"],
    });
  } catch (err) {
    // Script already injected or tab is restricted — both are fine
    console.log(`[PromptBlast] ensureContentScript (tab ${tabId}):`, err.message);
  }
}


/**
 * Sends a message to the content script in `tabId` with a timeout.
 * If the content script never responds (e.g., page throttled), we
 * resolve after INJECT_TIMEOUT_MS so Promise.allSettled doesn't hang.
 */
function injectQuery(tabId, service, query, autoSubmit) {
  const INJECT_TIMEOUT_MS = 15_000; // 15 s safety net per tab

  return new Promise((resolve) => {
    // Safety timeout: resolve even if the tab never responds
    const timer = setTimeout(() => {
      console.warn(`[PromptBlast] ${service.name} timed out after ${INJECT_TIMEOUT_MS}ms`);
      resolve({ ok: false, error: "timeout" });
    }, INJECT_TIMEOUT_MS);

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
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          console.warn(
            `[PromptBlast] Could not reach ${service.name}:`,
            chrome.runtime.lastError.message
          );
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          console.log(`[PromptBlast] ${service.name}:`, response);
          resolve(response);
        }
      }
    );
  });
}
