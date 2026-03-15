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

// ── State ────────────────────────────────────────────────────
let allServices = [];        // Full list from background.js
let enabledServiceIds = [];  // Which ones are currently active
let promptHistory = [];      // Last N prompts

const MAX_HISTORY = 5;

// ── Initialization ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // 1. Fetch the service registry from background
  allServices = await getServices();

  // 2. Load saved settings
  const stored = await chrome.storage.sync.get("settings");
  const settings = stored.settings || {};
  enabledServiceIds = settings.enabledServices || allServices.map((s) => s.id);
  autoSubmitToggle.checked = settings.autoSubmit !== false; // default: true

  // 3. Load prompt history
  const historyData = await chrome.storage.local.get("promptHistory");
  promptHistory = historyData.promptHistory || [];

  // 4. Render everything
  renderServiceChips();
  renderHistory();
  updateShortcutHint();

  // 5. Focus the input
  promptInput.focus();
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

    chip.innerHTML = `<span class="dot"></span>${service.name}`;
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
  // Persist
  chrome.storage.local.set({ promptHistory });
  renderHistory();
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
 * Shows the correct keyboard shortcut for the user's OS.
 */
function updateShortcutHint() {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  shortcutHint.textContent = isMac ? "⌃⇧A" : "Ctrl+Shift+A";
}
