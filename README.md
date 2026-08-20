# AI Comment — LinkedIn Comment Generator

A production-ready **Manifest V3** Chrome Extension that generates professional, context-aware LinkedIn comments using AI — then inserts them as **drafts** for you to review. It never posts anything automatically.

![Status](https://img.shields.io/badge/Manifest-V3-blue) ![License](https://img.shields.io/badge/license-MIT-green)

---

## Features

- 🤖 **One-click generation** — an `AI Comment` button appears in every post's action bar (Like/Comment/Repost), plus an in-composer toolbar. Clicking the action-bar button opens the comment box if needed
- 🔄 **Refresh** — generates a brand-new comment, avoiding the previous wording
- 🎭 **5 personas** — Professional, Technical, Networking, Job Seeker, General
- 📏 **Character control** — 100–500 characters (default 200), enforced in the prompt *and* post-processed
- 👤 **Mention author** toggle — naturally includes the author's name or omits it
- 🧩 **Multi-provider** abstraction — OpenRouter, Azure OpenAI, Gemini, Groq, Grok (xAI)
- 🔐 **Secure by default** — API keys live only in `chrome.storage.local`, never in the page, never synced
- 🛡️ **Draft-only** — comments are inserted into the text box; **you** review and click Post

## Architecture

```
linkedin-comment-extension/
├── manifest.json              # MV3 manifest
├── background/
│   └── service-worker.js      # Message router + AI orchestration (ES module)
├── content/
│   ├── linkedin.js            # LinkedIn selectors & post extraction
│   └── content.js             # DOM injection, toolbar, observer
├── popup/
│   ├── popup.html             # Settings UI
│   ├── popup.css              # Modern, responsive styling
│   └── popup.js               # Settings logic + validation
├── providers/
│   ├── index.js               # Provider registry (add new providers here)
│   ├── common.js              # Timeout / error mapping / response parsing
│   ├── openrouter.js
│   ├── azure.js               # Deployment name + endpoint
│   ├── gemini.js
│   ├── groq.js
│   └── grok.js                # xAI
├── utils/
│   ├── storage.js             # Settings defaults + Chrome Storage helpers
│   ├── prompt.js              # Prompt builder + output normalizer
│   └── dom.js                 # Generic DOM helpers (content scripts)
└── icons/                     # Generated PNG icons (16/32/48/128)
```

### Data flow

```
LinkedIn post  →  content script extracts post/author/hashtags
       ↓  (message: GENERATE_COMMENT)
background service worker  →  builds prompt  →  calls provider API
       ↓  (normalize + fit-to-length + retry)
content script  →  inserts draft into LinkedIn's comment box
       (never submits!)
```

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `linkedin-comment-extension` folder.
5. Pin the extension for easy access to settings.

## Configure

1. Click the 🤖 icon in the toolbar → the settings popup opens.
2. Choose a **Provider**.
3. Paste your **API key** (see per-provider setup below).
4. Set a **Model name** (suggestions auto-fill; editable).
5. If you use **Azure**, also add your endpoint URL.
6. Set **Length**, **Persona**, and **Mention Author**.
7. Click **Save Settings**. Settings restore automatically next time.

## Provider setup

| Provider | API key from | Model examples | Extra |
| --- | --- | --- | --- |
| OpenRouter | https://openrouter.ai/keys | `deepseek/deepseek-chat`, `anthropic/claude-sonnet-5`, `openai/gpt-5.5` | — |
| Azure OpenAI | Azure Portal (your OpenAI resource) | Your **deployment name** | Endpoint like `https://your-resource.openai.azure.com` |
| Gemini | https://aistudio.google.com/apikey | `gemini-2.5-pro`, `gemini-2.5-flash` | — |
| Groq | https://console.groq.com/keys | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` | — |
| Grok (xAI) | https://console.x.ai/ | `grok-3`, `grok-3-mini-fast` | — |

> **Note:** the provider list includes both **Groq** (fast, OpenAI-compatible, `gsk_…` keys) and **Grok** (xAI). Pick whichever you have a key for.

## Using it on LinkedIn

1. Open `linkedin.com` and find a post.
2. Click **🤖 AI Comment** in the post's action bar (or open the comment box and use **🤖 AI Comment** inside it).
3. If the comment box wasn't open, the extension opens it for you automatically.
4. A spinner appears → "Generating…".
5. The draft lands in the text box — **review it, then click Post yourself**.
6. Want another angle? Click **🔄 Refresh** for a new, different comment.

## Error handling

| Situation | What you see |
| --- | --- |
| Missing API key | "Add your API key in the extension settings…" |
| Invalid key / 401 / 403 | "Invalid API key or insufficient permissions…" |
| Rate limit / 429 | "Rate limit reached. Wait a moment and try again." |
| Timeout | "The request timed out. Try again." |
| Network failure | "Network error. Check your connection…" |
| Unsupported page / no post | "Could not locate the LinkedIn post." |
| LinkedIn DOM change | The observer re-injects action buttons and toolbars automatically |

Transient failures (timeout, rate limit, network, 5xx, too-short output) are retried automatically (up to 3 attempts).

## Security

- **No secrets in code.** API keys are never hardcoded or logged.
- Keys are stored in `chrome.storage.local` — not synced to your Google account.
- All provider calls use **HTTPS** only.
- API calls run in the background service worker; keys never reach the page context.
- The extension **never publishes** comments. It only drafts text you approve.
- Not affiliated with LinkedIn or any AI provider.

## Adding a new AI provider

1. Create `providers/my-provider.js` exporting `id` and `generate({ apiKey, model, endpoint, prompt, temperature })`.
2. Register it in `providers/index.js`.
3. Add its metadata to `PROVIDER_META` in `utils/storage.js` (label, key URL, model suggestions).
4. Optionally add a host to `host_permissions` in `manifest.json`.

## Roadmap-ready

The architecture makes these easy to add: comment history, favorite comments, tone selection, emoji toggle, reply generation, scheduled commenting, analytics, custom prompt templates, keyboard shortcuts, dark mode, multi-language support.

## Development

```bash
# Validate JS syntax (all files)
node --check background/service-worker.js
# Validate the manifest
python -m json.tool manifest.json
```

## License

MIT
