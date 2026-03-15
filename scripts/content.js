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
const MAX_RETRIES = 15;      // How many times to look for the input
const RETRY_INTERVAL = 800;  // ms between retries
const SUBMIT_DELAY = 500;    // ms to wait after filling before submitting

// ── Message Listener ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "fillQuery") {
    fillAndSubmit(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for async response
  }
});


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
    await sleep(SUBMIT_DELAY);
    submit(element, submitType, buttonSel);
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

    // Notify the framework
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: query,
    }));

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

    // Clear existing content
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      return fillTextarea(el, query);
    }

    el.textContent = "";

    // Method 1: Use DataTransfer (clipboard-like paste)
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

    // If the paste didn't work, fall back to setting text manually
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
 * Uses MutationObserver for efficiency (no busy-polling).
 * Falls back to interval-based polling if observer misses it.
 *
 * @param {string} selector - CSS selector to wait for
 * @returns {Promise<Element|null>}
 */
function waitForElement(selector) {
  return new Promise((resolve) => {
    // Check immediately
    const existing = document.querySelector(selector);
    if (existing) return resolve(existing);

    let retries = 0;

    // MutationObserver: fast, event-driven detection
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearInterval(fallback);
        resolve(el);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Fallback interval in case observer misses it
    const fallback = setInterval(() => {
      retries++;
      const el = document.querySelector(selector);
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
