/**
 * ============================================================
 *  PromptBlast — Options Page Script
 * ============================================================
 *
 *  Manages the full settings page:
 *   - Enable/disable individual AI services
 *   - Toggle auto-submit & tab grouping
 *   - Configure page load delay
 *   - Clear history & reset defaults
 *   - Open Chrome's keyboard shortcut settings
 *
 *  All settings auto-save on change (no "Save" button needed).
 * ============================================================
 */

// ── DOM References ───────────────────────────────────────────
const serviceListEl = document.getElementById("serviceList");
const autoSubmitEl = document.getElementById("autoSubmit");
const groupTabsEl = document.getElementById("groupTabs");
const delayMsEl = document.getElementById("delayMs");
const clearHistoryBtn = document.getElementById("clearHistory");
const resetAllBtn = document.getElementById("resetAll");
const openShortcutsBtn = document.getElementById("openShortcuts");
const toastEl = document.getElementById("toast");
const darkModeEl = document.getElementById("darkMode");
const showRecentsEl = document.getElementById("showRecents");
const currentShortcutBadge = document.getElementById("currentShortcutBadge");

// ── State ────────────────────────────────────────────────────
let allServices = [];
let enabledServiceIds = [];

// ── Default Settings ─────────────────────────────────────────
const DEFAULTS = {
  enabledServices: ["chatgpt", "claude", "gemini"],
  autoSubmit: true,
  groupTabs: true,
  delayMs: 2000,
  showRecents: true,
};

// ── Initialization ───────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Fetch service registry from the background worker
  allServices = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "getServices" }, (res) => {
      resolve(res?.services || []);
    });
  });

  // Load saved settings
  const stored = await chrome.storage.sync.get("settings");
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };

  enabledServiceIds = settings.enabledServices;
  autoSubmitEl.checked = settings.autoSubmit;
  groupTabsEl.checked = settings.groupTabs;
  delayMsEl.value = settings.delayMs;
  showRecentsEl.checked = settings.showRecents !== false;

  // Apply saved theme
  const savedTheme = settings.theme || "light";
  document.documentElement.dataset.theme = savedTheme;
  darkModeEl.checked = savedTheme === "dark";
  darkModeEl.addEventListener("change", () => {
    const theme = darkModeEl.checked ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    save();
  });

  showRecentsEl.addEventListener("change", save);

  // Render the service list
  renderServices();

  // Attach event listeners
  autoSubmitEl.addEventListener("change", save);
  groupTabsEl.addEventListener("change", save);
  delayMsEl.addEventListener("change", save);

  clearHistoryBtn.addEventListener("click", clearHistory);
  resetAllBtn.addEventListener("click", resetAll);
  openShortcutsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  // Load live shortcut & check if we need to scroll+blink
  loadCurrentShortcut();
  checkShortcutHighlight();
});


// ── Service List Rendering ───────────────────────────────────

function renderServices() {
  serviceListEl.innerHTML = "";

  allServices.forEach((service) => {
    const item = document.createElement("div");
    item.className = "service-item";

    const info = document.createElement("div");
    info.className = "service-info";
    info.innerHTML = `
      <img src="../${service.iconPath}" class="service-icon" />
      <div>
        <p class="name">${service.name}</p>
        <p class="url">${service.url}</p>
      </div>
    `;

    const toggle = document.createElement("label");
    toggle.className = "toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabledServiceIds.includes(service.id);
    checkbox.addEventListener("change", () => {
      toggleService(service.id, checkbox.checked);
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    toggle.appendChild(checkbox);
    toggle.appendChild(slider);

    item.appendChild(info);
    item.appendChild(toggle);
    serviceListEl.appendChild(item);
  });
}


/**
 * Toggle a service and save immediately.
 */
function toggleService(id, enabled) {
  if (enabled && !enabledServiceIds.includes(id)) {
    enabledServiceIds.push(id);
  } else if (!enabled) {
    enabledServiceIds = enabledServiceIds.filter((s) => s !== id);
  }
  save();
}


// ── Persistence ──────────────────────────────────────────────

/**
 * Saves all current settings to chrome.storage.sync
 * and shows a confirmation toast.
 */
async function save() {
  const settings = {
    enabledServices: enabledServiceIds,
    autoSubmit: autoSubmitEl.checked,
    groupTabs: groupTabsEl.checked,
    delayMs: parseInt(delayMsEl.value, 10) || DEFAULTS.delayMs,
    theme: darkModeEl.checked ? "dark" : "light",
    showRecents: showRecentsEl.checked,
  };

  await chrome.storage.sync.set({ settings });
  showToast("Settings saved");
}


/**
 * Clears the prompt history from local storage.
 */
async function clearHistory() {
  await chrome.storage.local.remove("promptHistory");
  showToast("History cleared");
}


/**
 * Resets all settings to defaults and refreshes the page.
 */
async function resetAll() {
  const confirmed = confirm(
    "Reset all settings to defaults? This cannot be undone."
  );
  if (!confirmed) return;

  await chrome.storage.sync.set({ settings: DEFAULTS });
  await chrome.storage.local.remove("promptHistory");
  showToast("All settings reset");
  setTimeout(() => location.reload(), 800);
}


// ── Toast ────────────────────────────────────────────────────

let toastTimer;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 2000);
}


// ── Shortcut Helpers ─────────────────────────────────────────

/**
 * Reads the actual shortcut registered in Chrome and populates
 * the badge in the Keyboard Shortcut section.
 */
async function loadCurrentShortcut() {
  if (!currentShortcutBadge) return;
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "_execute_action");
    const shortcut = cmd?.shortcut;
    currentShortcutBadge.textContent = shortcut || "Not set";
  } catch {
    currentShortcutBadge.textContent = "Unavailable";
  }
}


/**
 * Checks whether the popup asked us to highlight the shortcut section.
 * If it did, scroll to it, animate a 1-second blink, then clear the flag.
 */
async function checkShortcutHighlight() {
  const data = await chrome.storage.local.get("highlightShortcut");
  if (!data.highlightShortcut) return;

  // Clear the flag immediately so it doesn't re-trigger on refresh
  await chrome.storage.local.remove("highlightShortcut");

  const section = document.getElementById("shortcut-section");
  if (!section) return;

  // Scroll the section into view, centered
  section.scrollIntoView({ behavior: "smooth", block: "center" });

  // Wait for scroll to settle, then blink
  setTimeout(() => {
    section.classList.add("highlight-blink");
    // Remove the class after animation so it can replay if triggered again
    section.addEventListener("animationend", () => {
      section.classList.remove("highlight-blink");
    }, { once: true });
  }, 400);
}

