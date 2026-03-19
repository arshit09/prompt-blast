/**
 * ============================================================
 *  PromptBlast — Popup Script
 * ============================================================
 *
 *  Handles:
 *   - Loading the service list from background.js
 *   - Toggling individual services on/off (with persistence)
 *   - Sending the "multicast" command to background.js
 *   - Prompt history (last 5, stored locally)
 *   - Auto-submit toggle
 *   - Keyboard shortcut: Enter to send (Shift+Enter for newline)
 * ============================================================
 */

// ── DOM References ───────────────────────────────────────────
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const serviceChipsEl = document.getElementById("serviceChips");
const autoSubmitToggle = document.getElementById("autoSubmitToggle");
const historySection = document.getElementById("historySection");
const historyList = document.getElementById("historyList");
const settingsBtn = document.getElementById("settingsBtn");
const shortcutHint = document.getElementById("shortcutHint");
const themeToggleBtn = document.getElementById("themeToggleBtn");
const iconMoon = document.getElementById("iconMoon");
const iconSun = document.getElementById("iconSun");

// ── State ────────────────────────────────────────────────────
let allServices = [];        // Full list from background.js
let enabledServiceIds = [];  // Which ones are currently active
let promptHistory = [];      // Last N prompts
let showToolNames = true;    // UI preference

// ── Initialization ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // 1. Fetch the service registry from background
  allServices = await getServices();

  // 2. Load saved settings
  const stored = await chrome.storage.sync.get("settings");
  const settings = stored.settings || {};
  enabledServiceIds = settings.enabledServices || ["chatgpt", "claude", "gemini"];
  showToolNames = settings.showToolNames !== false;
  autoSubmitToggle.checked = settings.autoSubmit !== false; // default: true

  // 2b. Apply theme
  applyThemeToPage(settings.theme || "dark");
  themeToggleBtn.addEventListener("click", toggleTheme);

  // 3. Load prompt history
  const historyData = await chrome.storage.local.get("promptHistory");
  promptHistory = historyData.promptHistory || [];

  // 4. Render everything
  renderServiceChips();
  renderHistory();
  updateShortcutHint();

  // 5. Focus the input
  promptInput.focus();
  document.body.classList.add("ready");
});


// ── Service Chips ────────────────────────────────────────────

/**
 * Renders clickable chips for each AI service.
 * Active chips are highlighted; clicking toggles them.
 */
function renderServiceChips() {
  serviceChipsEl.innerHTML = "";

  allServices.forEach((service) => {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.dataset.id = service.id;

    if (enabledServiceIds.includes(service.id)) {
      chip.classList.add("active");
    }

    const isDark = document.documentElement.dataset.theme === "dark";
    const icon = (isDark && service.iconPathDark) ? service.iconPathDark : service.iconPath;
    const nameText = showToolNames ? service.name : "";
    chip.innerHTML = `<img src="../${icon}" class="service-icon" />${nameText}`;
    chip.addEventListener("click", () => toggleService(service.id));

    serviceChipsEl.appendChild(chip);
  });

  updateSendButton();
}


/**
 * Toggles a service on or off, updates the UI, and persists.
 */
function toggleService(id) {
  const index = enabledServiceIds.indexOf(id);
  if (index >= 0) {
    enabledServiceIds.splice(index, 1);
  } else {
    enabledServiceIds.push(id);
  }

  renderServiceChips();
  saveSettings();
}


// ── Prompt Submission ────────────────────────────────────────

/**
 * Sends the user's prompt to all enabled AI services.
 */
async function handleSend() {
  const query = promptInput.value.trim();
  if (!query || enabledServiceIds.length === 0) return;

  // Disable UI to prevent double-sends
  sendBtn.disabled = true;
  promptInput.disabled = true;

  // Save auto-submit preference
  await saveSettings();

  // Save to prompt history
  addToHistory(query);

  // Send the multicast command to the background worker
  chrome.runtime.sendMessage(
    {
      action: "multicast",
      query: query,
    },
    () => {
      // Close the popup after a beat (feels snappier)
      setTimeout(() => window.close(), 300);
    }
  );
}


// ── Event Listeners ──────────────────────────────────────────

// Send button click
sendBtn.addEventListener("click", handleSend);

// Enter to send, Shift+Enter for newline
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

// Enable/disable send button based on input
promptInput.addEventListener("input", updateSendButton);

// Settings button opens the options page
settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});


// ── Send Button State ────────────────────────────────────────

function updateSendButton() {
  const hasQuery = promptInput.value.trim().length > 0;
  const hasServices = enabledServiceIds.length > 0;
  sendBtn.disabled = !(hasQuery && hasServices);
}


// ── Prompt History ───────────────────────────────────────────

/**
 * Adds a prompt to history (deduplicates, caps at MAX_HISTORY).
 */
function addToHistory(query) {
  // Remove duplicate if exists
  promptHistory = promptHistory.filter((h) => h !== query);
  // Add to front
  promptHistory.unshift(query);
  // Cap length
  promptHistory = promptHistory.slice(0, MAX_HISTORY);
  // Persist (don't re-render now — history updates on next popup open)
  chrome.storage.local.set({ promptHistory });
}


/**
 * Renders the recent prompts list. Clicking one re-fills the input.
 */
function renderHistory() {
  if (promptHistory.length === 0) {
    historySection.classList.add("hidden");
    return;
  }

  historySection.classList.remove("hidden");
  historyList.innerHTML = "";

  promptHistory.forEach((prompt) => {
    const li = document.createElement("li");
    li.textContent = prompt;
    li.title = prompt;
    li.addEventListener("click", () => {
      promptInput.value = prompt;
      promptInput.focus();
      updateSendButton();
    });
    historyList.appendChild(li);
  });
}


// ── Persistence ──────────────────────────────────────────────

/**
 * Saves current settings to chrome.storage.sync.
 */
function saveSettings() {
  return chrome.storage.sync.set({
    settings: {
      enabledServices: enabledServiceIds,
      autoSubmit: autoSubmitToggle.checked,
      theme: document.documentElement.dataset.theme || "light",
    },
  });
}


// ── Helpers ──────────────────────────────────────────────────

/**
 * Fetches the AI service registry from the background worker.
 */
function getServices() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getServices" }, (response) => {
      resolve(response?.services || []);
    });
  });
}


/**
 * Reads the actual shortcut set by the user via chrome.commands
 * and updates the hint badge. Falls back to a readable default.
 */
async function updateShortcutHint() {
  try {
    const commands = await chrome.commands.getAll();
    // The _execute_action command controls the extension icon click / shortcut
    const cmd = commands.find((c) => c.name === "_execute_action");
    const shortcut = cmd?.shortcut || "";

    if (shortcut) {
      // Format: turn "Ctrl+Shift+A" into a nice display
      shortcutHint.textContent = shortcut.replace(/\+/g, " + ");
    } else {
      shortcutHint.textContent = "No shortcut set";
    }
  } catch {
    // commands API not available (shouldn't happen in MV3 popup)
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    shortcutHint.textContent = isMac ? "⌃ ⇧ A" : "Ctrl + Shift + A";
  }

  // Make the badge clickable — open options and highlight the shortcut section
  shortcutHint.style.cursor = "pointer";
  shortcutHint.title = "Click to change shortcut";
  shortcutHint.addEventListener("click", async () => {
    // Signal the options page to highlight the shortcut section on load
    await chrome.storage.local.set({ highlightShortcut: true });
    chrome.runtime.openOptionsPage();
  });
}


// ── Theme ─────────────────────────────────────────────────────

/**
 * Applies a theme ("light" | "dark") to the popup document and
 * swaps the toggle button icon accordingly.
 */
function applyThemeToPage(theme) {
  applyTheme(document.documentElement, theme);
  if (theme === "dark") {
    iconMoon.style.display = "none";
    iconSun.style.display = "";
  } else {
    iconMoon.style.display = "";
    iconSun.style.display = "none";
  }
  renderServiceChips();
}

/**
 * Flips the current theme and persists it.
 */
async function toggleTheme() {
  const current = document.documentElement.dataset.theme || "light";
  const next = current === "dark" ? "light" : "dark";
  applyThemeToPage(next);
  // Persist alongside other settings
  const stored = await chrome.storage.sync.get("settings");
  const settings = stored.settings || {};
  await chrome.storage.sync.set({ settings: { ...settings, theme: next } });
}
