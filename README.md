# Friday — AI Demo Presenter

> An AI co-presenter that listens to you speak and navigates your product live — in a real browser, in front of your audience.

**Status:** Active development · MIT License

---

## The Intent

Most product demos are fragile. You're juggling talking, clicking, and keeping the audience engaged — and one wrong click breaks the flow.

Friday flips this. You speak naturally. The AI hears your intent, triggers a pre-recorded browser flow, and narrates to the audience — while you stay focused on the story.

The bigger vision: build a system where AI-driven browser automation becomes *replayable and token-efficient*. Right now, every AI interaction burns tokens. The future version of Friday records what the AI decided — the exact MCP tool calls and reasoning — so next time the same intent appears, it replays the recorded trace directly without calling the model. Common paths become near-free. The AI is only invoked for genuinely new or unknown situations.

Think of it as a DVR for LLM reasoning: **record once, replay many times, only go live when needed.**

---

## How It Works

You hold a mic button and speak. The AI matches your words to a pre-recorded navigation flow and executes it in a visible Chrome browser while narrating to the audience.

The browser is controlled by a local Playwright MCP server. The AI never generates browser actions dynamically — it only triggers pre-recorded flows by name, keeping demos predictable and reliable.

```
[You speak]
     │
[Electron App — Gemini Live API]
     │   hears intent → matches flow → dispatches
     │
[Orchestrator]
     │   executes steps synchronously
     │
[Playwright MCP Server — localhost:8931]
     │
[Chrome Browser — visible to audience]
     │
[Your Demo Website]
```

### Four Modes

| Mode | State |
|---|---|
| `IDLE` | Session open, waiting |
| `LISTENING` | Mic held, audio streaming to AI |
| `PRESENTING` | AI speaking or flow executing |
| `MANUAL` | You have browser control, AI paused |

---

## Getting Started

**Prerequisites:** Node.js 18+, Chrome, [Gemini API key](https://aistudio.google.com/app/apikey)

```bash
# Install Playwright MCP
npm install -g @playwright/mcp

# Install dependencies
cd presenter-app
npm install

# Configure
cp .env.example .env
# Add your GEMINI_API_KEY to .env

# Build
npm run build:renderer
```

**Run on Mac/Linux:**
```bash
./start-all.sh
```

**Run on Windows:**
```
start-all.bat
```

Or manually in two terminals:
```bash
# Terminal 1
npx @playwright/mcp@latest --port 8931 --browser=chrome --config=playwright-mcp.config.json

# Terminal 2
cd presenter-app && npm start
```

---

## Recording Flows

Flows are recorded once in Chrome DevTools Recorder, imported, and triggered by voice during demos.

1. Open your demo site in Chrome → `F12` → **Recorder** panel
2. Click **Start new recording** and name it
3. Click through your demo naturally
4. **End recording** → **Export** → JSON
5. In the app → **Flows tab** → **Import Flow**
6. Set a clear name and description — this is what the AI matches against your speech

> The importer auto-inserts `wait_for body` after every navigation so each page is verified loaded before continuing.

---

## Presenting

1. Open the **Present** tab
2. Hold the mic button (or `Spacebar`) and speak
3. AI matches your words to a flow, executes it, and narrates
4. Click **Take Control** to drive the browser yourself at any time
5. Click **Return Control** — AI gets a page snapshot and picks up naturally

---

## Project Structure

```
friday/
├── presenter-app/
│   ├── src/
│   │   ├── main.js                      # Electron main process
│   │   ├── preload.js                   # contextBridge (fs, path, env)
│   │   └── renderer/
│   │       ├── App.jsx                  # root: mode state, tab routing
│   │       ├── tabs/
│   │       │   ├── PresentTab.jsx       # live UI: mic, feed, flow library
│   │       │   ├── FlowsTab.jsx         # import, edit, test flows
│   │       │   └── KnowledgeTab.jsx     # knowledge base editor
│   │       ├── hooks/
│   │       │   ├── useGeminiSession.js  # Gemini Live audio I/O
│   │       │   ├── useMCPClient.js      # Playwright MCP JSON-RPC client
│   │       │   └── useFlows.js          # flow loader + search index
│   │       ├── orchestrator/
│   │       │   └── Orchestrator.js      # core dispatcher + flow runner
│   │       └── utils/
│   │           ├── convertDevToolsFlow.js
│   │           ├── buildSearchIndex.js
│   │           └── flowRepairer.js
│   ├── flows/flows.json                 # your flow library (git-ignored)
│   └── .env.example
├── playwright-mcp.config.json
├── start-all.sh / start-all.bat
└── LICENSE
```

---

## Roadmap

- [x] Core presenter loop (voice → flow → browser → narration)
- [x] Mac + Windows support
- [x] Chrome DevTools Recorder flow import
- [ ] LLM decision trace recording — replay MCP tool calls without re-invoking the model
- [ ] Intent cache — zero-token replay for known demo paths
- [ ] Flow auto-repair when selectors break on page changes
- [ ] Multi-browser support

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Your Google Gemini API key |
| `TARGET_URL` | `http://localhost:3000` | Demo website URL |
| `MCP_SERVER_URL` | `http://localhost:8931` | Playwright MCP server |

---

## License

MIT — see [LICENSE](LICENSE)
