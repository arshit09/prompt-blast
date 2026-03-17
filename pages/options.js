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
const historyLimitEl = document.getElementById("historyLimit");
const clearHistoryBtn = document.getElementById("clearHistory");
const resetAllBtn = document.getElementById("resetAll");
const openShortcutsBtn = document.getElementById("openShortcuts");
const toastEl = document.getElementById("toast");
const darkModeEl = document.getElementById("darkMode");
const showRecentsEl = document.getElementById("showRecents");
const currentShortcutBadge = document.getElementById("currentShortcutBadge");
const overlayPositionEl = document.getElementById("overlayPosition");
const overlayPositionContainer = document.getElementById("overlayPositionContainer");
const overlayPositionTrigger = document.getElementById("overlayPositionTrigger");
const overlayPositionLabel = document.getElementById("overlayPositionLabel");
const overlayPositionOptions = document.getElementById("overlayPositionOptions");
const showToolNamesEl = document.getElementById("chipDisplay");
const chipDisplayContainer = document.getElementById("chipDisplayContainer");
const chipDisplayTrigger = document.getElementById("chipDisplayTrigger");
const chipDisplayLabel = document.getElementById("chipDisplayLabel");
const chipDisplayOptions = document.getElementById("chipDisplayOptions");
const mainContainer = document.querySelector(".container");
const confirmModal = document.getElementById("confirmModal");
const cancelResetBtn = document.getElementById("cancelReset");
const confirmResetBtn = document.getElementById("confirmReset");

// Preview References
const mockOverlay = document.getElementById("mockOverlay");
const mockHistory = document.getElementById("mockHistory");

// ── State ────────────────────────────────────────────────────
let allServices = [];
let enabledServiceIds = [];

// ── Default Settings ─────────────────────────────────────────
const DEFAULTS = {
  enabledServices: ["chatgpt", "claude", "gemini"],
  autoSubmit: true,
  groupTabs: true,
  delayMs: 2000,
  historyLimit: 20,
  showRecents: true,
  overlayPosition: "top",
  chipDisplay: "logo-name",
  theme: "dark",
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
  historyLimitEl.value = settings.historyLimit || 20;
  showRecentsEl.checked = settings.showRecents !== false;

  // Init chipDisplay
  const savedChipDisplay = settings.chipDisplay || "logo-name";
  showToolNamesEl.value = savedChipDisplay;
  updateChipDisplayLabel(savedChipDisplay);
  // Restore overlay position separately
  overlayPositionEl.value = settings.overlayPosition || "top";
  overlayPositionLabel.textContent = settings.overlayPosition ? settings.overlayPosition.charAt(0).toUpperCase() + settings.overlayPosition.slice(1) : "Top";
  updateSelectedOption(settings.overlayPosition || "top");
  updateSelectedOption(settings.overlayPosition || "top");

  // Apply saved theme
  const savedTheme = settings.theme || "dark";
  applyTheme(document.documentElement, savedTheme);
  darkModeEl.checked = savedTheme === "dark";
  darkModeEl.addEventListener("change", () => {
    const theme = darkModeEl.checked ? "dark" : "light";
    applyTheme(document.documentElement, theme);
    renderServices();
    save();
    updatePreview();
  });

  showRecentsEl.addEventListener("change", () => {
    save();
    updatePreview();
  });

  // Render the service list
  renderServices();

  // Attach event listeners
  autoSubmitEl.addEventListener("change", save);
  groupTabsEl.addEventListener("change", save);
  delayMsEl.addEventListener("change", save);
  historyLimitEl.addEventListener("change", save);

  clearHistoryBtn.addEventListener("click", clearHistory);
  resetAllBtn.addEventListener("click", () => showModal(true));
  cancelResetBtn.addEventListener("click", () => showModal(false));
  confirmResetBtn.addEventListener("click", performReset);
  openShortcutsBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });

  // Init custom selects
  initCustomSelect();
  initChipDisplaySelect();

  // Init custom number spinners
  initNumSpinners();

  // Make setting rows clickable
  initClickableRows();

  // Initial preview update
  updatePreview();

  // Close modal on backdrop click
  confirmModal.addEventListener("click", (e) => {
    if (e.target === confirmModal) {
      showModal(false);
    }
  });

  // Load live shortcut & check if we need to scroll+blink
  loadCurrentShortcut();
  checkShortcutHighlight();

  // Listen for re-triggering while page is already open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.highlightShortcut?.newValue === true) {
      checkShortcutHighlight();
    }
  });
});

function initCustomSelect() {
  overlayPositionTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    overlayPositionContainer.classList.toggle("open");
  });

  overlayPositionOptions.querySelectorAll(".option").forEach(option => {
    option.addEventListener("click", () => {
      const val = option.getAttribute("data-value");
      overlayPositionEl.value = val;
      overlayPositionLabel.textContent = option.textContent;
      updateSelectedOption(val);
      overlayPositionContainer.classList.remove("open");
      save();
      updatePreview();
    });
  });

  window.addEventListener("click", () => {
    overlayPositionContainer.classList.remove("open");
  });
}

function updateSelectedOption(val) {
  overlayPositionOptions.querySelectorAll(".option").forEach(opt => {
    if (opt.getAttribute("data-value") === val) {
      opt.classList.add("selected");
    } else {
      opt.classList.remove("selected");
    }
  });
}

function initChipDisplaySelect() {
  chipDisplayTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close position dropdown first
    overlayPositionContainer.classList.remove("open");
    chipDisplayContainer.classList.toggle("open");
  });

  chipDisplayOptions.querySelectorAll(".option").forEach(option => {
    option.addEventListener("click", () => {
      const val = option.getAttribute("data-value");
      showToolNamesEl.value = val;
      updateChipDisplayLabel(val);
      updateChipDisplaySelected(val);
      chipDisplayContainer.classList.remove("open");
      save();
      updatePreview();
    });
  });

  window.addEventListener("click", () => {
    chipDisplayContainer.classList.remove("open");
  });

  // Mark initial selected option
  updateChipDisplaySelected(showToolNamesEl.value || "logo-name");
}

function updateChipDisplayLabel(val) {
  const labels = { "none": "None", "logo": "Logo only", "name": "Name only", "logo-name": "Name with Logo" };
  chipDisplayLabel.textContent = labels[val] || "Name with Logo";
}

function updateChipDisplaySelected(val) {
  chipDisplayOptions.querySelectorAll(".option").forEach(opt => {
    opt.classList.toggle("selected", opt.getAttribute("data-value") === val);
  });
}

function initNumSpinners() {
  document.querySelectorAll(".num-spin").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const baseStep = parseFloat(input.step) || 1;
      const step = e.altKey ? Math.max(1, baseStep / 10)
                 : e.shiftKey ? baseStep * 10
                 : baseStep;
      const min = parseFloat(input.min);
      const max = parseFloat(input.max);
      let val = parseFloat(input.value) || 0;
      val = btn.classList.contains("up") ? val + step : val - step;
      if (!isNaN(min)) val = Math.max(min, val);
      if (!isNaN(max)) val = Math.min(max, val);
      input.value = val;
      input.dispatchEvent(new Event("change"));
    });
  });
}

function initClickableRows() {
  // Handle setting rows (Dark mode, Show recents, Auto-submit, Group tabs)
  document.querySelectorAll(".setting-row").forEach(row => {
    row.addEventListener("click", (e) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      
      // If we clicked the checkbox itself or the slider, let the browser handle it
      if (e.target.closest("input") || e.target.closest(".slider") || e.target.closest("button") || e.target.closest(".custom-select") || e.target.closest(".input-group")) {
        return;
      }

      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    });
  });
}


// ── Service List Rendering ───────────────────────────────────

function renderServices() {
  serviceListEl.innerHTML = "";

  allServices.forEach((service) => {
    const item = document.createElement("div");
    item.className = "service-item";

    const info = document.createElement("div");
    info.className = "service-info";
    const isDark = document.documentElement.dataset.theme === "dark";
    const icon = (isDark && service.iconPathDark) ? service.iconPathDark : service.iconPath;
    info.innerHTML = `
      <img src="../${icon}" class="service-icon" />
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

    // Entire row click toggles the service
    item.addEventListener("click", (e) => {
      // Don't toggle if clicking the toggle switch itself
      if (e.target.closest(".toggle")) return;
      checkbox.checked = !checkbox.checked;
      toggleService(service.id, checkbox.checked);
    });

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
    historyLimit: parseInt(historyLimitEl.value, 10) || DEFAULTS.historyLimit,
    theme: darkModeEl.checked ? "dark" : "light",
    showRecents: showRecentsEl.checked,
    overlayPosition: overlayPositionEl.value,
    chipDisplay: showToolNamesEl.value,
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
 * Shows or hides the reset confirmation modal.
 */
function showModal(show) {
  if (show) {
    confirmModal.classList.add("show");
  } else {
    confirmModal.classList.remove("show");
  }
}

/**
 * Resets all settings to defaults and refreshes the page.
 */
async function performReset() {
  showModal(false);
  
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
    currentShortcutBadge.textContent = shortcut ? shortcut.replace(/\+/g, " + ") : "Not set";
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
    section.classList.remove("highlight-blink"); // Force reset
    void section.offsetWidth; // Trigger reflow
    section.classList.add("highlight-blink");
    
    // Remove the class after animation so it can replay if triggered again
    section.addEventListener("animationend", () => {
      section.classList.remove("highlight-blink");
    }, { once: true });
  }, 400);
}

function updatePreview() {
  if (!mockOverlay) return;

  const isDark = darkModeEl.checked;

  // Position — always use `top` + `translateY` so CSS can animate between
  // numeric values. Setting `top: auto` or `bottom` breaks transitions because
  // browsers cannot interpolate `auto`.
  const pos = overlayPositionEl.value || "top";
  const previewBox = mockOverlay.parentElement;
  const boxH = previewBox ? previewBox.clientHeight : 240;
  const overlayH = mockOverlay.offsetHeight;

  switch (pos) {
    case "top":
      mockOverlay.style.top = "20px";
      mockOverlay.style.transform = "translateY(0)";
      break;
    case "center":
      mockOverlay.style.top = "50%";
      mockOverlay.style.transform = "translateY(-50%)";
      break;
    case "bottom":
      mockOverlay.style.top = (boxH - overlayH - 20) + "px";
      mockOverlay.style.transform = "translateY(0)";
      break;
  }

  // History
  mockHistory.style.display = showRecentsEl.checked ? "flex" : "none";

  // Chip Display
  const chipMode = showToolNamesEl.value || "logo-name";
  const mockChipsContainer = mockOverlay.querySelector(".mock-chips");
  const mockChips = mockOverlay.querySelectorAll(".mock-chip");
  
  if (mockChipsContainer) {
    mockChipsContainer.style.display = chipMode === "none" ? "none" : "flex";
  }

  mockChips.forEach(chip => {
    const chipText = chip.querySelector(".chip-text");
    const icon = chip.querySelector(".mock-service-icon");
    if (chipMode === "logo") {
      if (chipText) chipText.style.display = "none";
      if (icon) icon.style.display = "block";
      chip.style.width = "";
      chip.style.height = "";
      chip.style.padding = "";
      chip.style.borderRadius = "";
    } else if (chipMode === "name") {
      if (chipText) chipText.style.display = "inline";
      if (icon) icon.style.display = "none";
      chip.style.width = "";
      chip.style.height = "";
      chip.style.padding = "";
      chip.style.borderRadius = "";
    } else if (chipMode === "logo-name") {
      if (chipText) chipText.style.display = "inline";
      if (icon) icon.style.display = "block";
      chip.style.width = "";
      chip.style.height = "";
      chip.style.padding = "";
      chip.style.borderRadius = "";
    }
  });

  // Dynamic ChatGPT icon for theme consistency
  const chatgptMockIcon = mockOverlay.querySelector("img[src*='chatgpt']");
  if (chatgptMockIcon) {
    chatgptMockIcon.src = isDark ? "../icons/chatgpt_light.png" : "../icons/chatgpt_dark.png";
  }

  // Theme
  mockOverlay.style.background = isDark ? "#202124" : "#ffffff";
  mockOverlay.style.color = isDark ? "#e8eaed" : "#202124";
  mockOverlay.style.borderColor = isDark ? "#3c4043" : "#dadce0";
}
