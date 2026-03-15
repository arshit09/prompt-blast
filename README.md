# ⚡ PromptBlast — Search Every AI at Once

> One prompt. Every AI. Simultaneously.

PromptBlast is a Chrome extension that lets you send a single prompt to **ChatGPT, Claude, Gemini, Copilot, DeepSeek, Perplexity, and Poe** — all at once. Compare answers side by side without copy-pasting between tabs.

---

## ✨ Features

- **One-click multicast** — Type your prompt once, get answers from every AI
- **Customizable shortcut** — Default: `Ctrl+Shift+A` (Windows/Linux) / `Ctrl+Shift+A` (Mac). Fully customizable via Chrome settings
- **Pick your AIs** — Toggle individual services on/off. Only use the ones you want
- **Auto-submit** — Automatically sends the prompt (or just fills it in — your choice)
- **Tab grouping** — All AI tabs are neatly grouped together
- **Prompt history** — Quick access to your last 5 prompts
- **Configurable delay** — Adjust page load wait time for slower connections
- **Clean, dark UI** — Minimal and fast, like a command palette
- **Open source** — MIT licensed, contributions welcome

## 🖥️ Supported AI Services

| Service     | URL                          | Status |
| ----------- | ---------------------------- | ------ |
| ChatGPT     | chatgpt.com                  | ✅      |
| Claude      | claude.ai                    | ✅      |
| Gemini      | gemini.google.com            | ✅      |
| Copilot     | copilot.microsoft.com        | ✅      |
| DeepSeek    | chat.deepseek.com            | ✅      |
| Perplexity  | perplexity.ai                | ✅      |
| Poe         | poe.com                      | ✅      |

> **Note:** You must be logged into each AI service for the extension to work. The extension does not handle authentication.

---

## 📦 Installation

### From Source (Developer Mode)

1. **Clone or download** this repository:
   ```bash
   git clone https://github.com/your-username/prompt-blast.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable **Developer mode** (toggle in the top-right corner)

4. Click **Load unpacked** and select the `prompt-blast` folder

5. The extension icon will appear in your toolbar. Pin it for easy access!

### Customizing the Keyboard Shortcut

1. Go to `chrome://extensions/shortcuts`
2. Find **PromptBlast** in the list
3. Click the pencil icon next to "Open PromptBlast popup"
4. Press your desired key combination

---

## 🏗️ Project Structure

```
prompt-blast/
├── manifest.json              # Extension configuration (Manifest V3)
├── README.md                  # You are here
├── LICENSE                    # MIT License
│
├── scripts/
│   ├── background.js          # Service worker: orchestrates tab creation
│   └── content.js             # Injected into AI sites: fills & submits prompts
│
├── pages/
│   ├── popup.html             # Main popup UI
│   ├── popup.js               # Popup logic (service chips, history, send)
│   ├── options.html           # Full settings page
│   └── options.js             # Settings logic (toggles, persistence)
│
├── styles/
│   ├── popup.css              # Popup styles (dark theme)
│   └── options.css            # Options page styles
│
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## 🔧 How It Works

1. **User presses the shortcut** → Chrome opens the popup
2. **User types a prompt** and clicks "Multicast" (or presses Enter)
3. **`popup.js`** sends a message to the **background service worker**
4. **`background.js`** opens a new tab for each enabled AI service
5. Once each tab loads, it sends a message to the **content script**
6. **`content.js`** finds the input field, fills in the prompt, and submits

### Why is filling inputs complicated?

Modern AI chat UIs (ChatGPT, Claude, etc.) use React/Vue with synthetic event systems. Simply setting `.value` on an input doesn't trigger their internal state updates. The content script uses different strategies:

- **Textarea:** Uses the native `HTMLTextAreaElement.prototype.value` setter to bypass React, then dispatches `input` and `change` events
- **ContentEditable:** Creates a text node, appends it, positions the cursor, and fires `InputEvent` with `inputType: "insertText"`
- **ProseMirror:** Simulates a paste via `DataTransfer` and `InputEvent` with `inputType: "insertFromPaste"`

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

### Adding a New AI Service

1. Open `scripts/background.js`
2. Add a new entry to the `AI_SERVICES` array:
   ```javascript
   {
     id: "your-ai",
     name: "Your AI",
     url: "https://your-ai.com/",
     inputType: "textarea",        // or "contenteditable" or "prosemirror"
     selector: "textarea.chat",    // CSS selector for the input
     submitType: "enter",          // or "button" or "both"
     buttonSel: null,              // CSS selector for send button (if submitType is "button")
     waitMs: 2500,                 // Extra wait time in ms
   }
   ```
3. Add the URL pattern to `manifest.json` → `host_permissions` and `content_scripts.matches`
4. Test it and submit a PR!

### Fixing a Broken Selector

AI websites update their DOM frequently. If a service stops working:

1. Open the AI website in Chrome
2. Right-click the input field → Inspect
3. Find a stable CSS selector for the input element
4. Update the `selector` field in `AI_SERVICES` in `background.js`
5. Submit a PR!

### Development Tips

- After making changes, go to `chrome://extensions/` and click the refresh icon on the extension card
- Use the **Service Worker** link on the extension card to open devtools for `background.js`
- Right-click the popup → Inspect to debug `popup.js`
- Check the AI site's console for content script logs (prefixed with `[PromptBlast]`)

---

## ⚠️ Known Limitations

- **Login required:** You must be logged into each AI service. The extension cannot authenticate for you.
- **DOM changes:** AI sites frequently update their HTML structure, which can break selectors. Open an issue if something stops working.
- **Rate limiting:** Some AI services may rate-limit rapid requests. The configurable delay helps mitigate this.
- **Captchas:** If an AI service shows a captcha, the extension cannot bypass it.
- **Firefox:** Currently Chrome-only (Manifest V3). Firefox support via WebExtension API is planned.

---

## 📄 License

MIT License — see [LICENSE](./LICENSE) for details.

---

## 🌟 Star This Repo

If you find PromptBlast useful, consider giving it a ⭐ on GitHub. It helps others discover it!
