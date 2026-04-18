# Friday — AI Demo Presenter

An Electron + React desktop app that gives you an AI co-presenter for live product demos. You speak, the AI hears your intent, and it navigates a live Chrome browser automatically — showing your product to the audience in real time.

> **Status:** Active development. Core presenter loop is working. See [Roadmap](#roadmap) for what's next.

---

## What it does

You hold a mic button and speak naturally during your demo. The AI listens, matches your intent to a pre-recorded navigation flow, executes it in a visible Chrome browser, and narrates to the audience — all without you touching the keyboard.

The browser is controlled by a locally running Playwright MCP server. The AI never generates browser actions dynamically — it only triggers pre-recorded flows by name, making demos predictable and reliable.

---

## Architecture

```
[Presenter speaks]
        |
[Electron + React App]
  useGeminiSession     → Gemini Live API (voice I/O)
  Orchestrator         → intent dispatch + flow execution
  useMCPClient         → JSON-RPC to Playwright MCP
  useFlows             → flows.json loader + search index
        |
[Playwright MCP Server — localhost:8931]
        |
[Chrome Browser — visible to audience]
        |
[Your Demo Website — localhost:3000]
```

### Four modes

| Mode | What's happening |
|---|---|
| `IDLE` | Session open, mic off, waiting |
| `LISTENING` | Mic held, audio streaming to AI |
| `PRESENTING` | AI speaking or flow executing |
| `MANUAL` | Presenter has browser control, AI paused |

---

## Setup

**Prerequisites:** Node.js 18+, Chrome installed, a [Gemini API key](https://aistudio.google.com/app/apikey)

```bash
# 1. Install Playwright MCP globally
npm install -g @playwright/mcp

# 2. Install app dependencies
cd presenter-app
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and set your GEMINI_API_KEY

# 4. Build renderer
npm run build:renderer
```

---

## Running

**Mac/Linux:**
```bash
./start-all.sh
```

**Windows:**
```
start-all.bat
```

Or manually in two terminals:
```bash
# Terminal 1 — MCP server
npx @playwright/mcp@latest --port 8931 --browser=chrome --config=playwright-mcp.config.json

# Terminal 2 — Presenter app
cd presenter-app && npm start
```

---

## Recording flows

Flows are recorded once in Chrome DevTools Recorder, then triggered by voice during demos.

1. Open your demo site in Chrome → F12 → Recorder panel
2. Click **Start new recording**, name it
3. Click through the demo flow naturally
4. Click **End recording** → **Export** → JSON
5. In the presenter app → **Flows** tab → **Import Flow**
6. Set name and description (these are what the AI matches against your speech)

The importer automatically inserts `wait_for body` after every navigation so each page is verified loaded before the next step runs.

---

## Presenting

1. Open the **Present** tab
2. Hold the mic button (or Spacebar) and speak
3. AI matches your words to a flow and executes it while narrating
4. Click **Take Control** any time to drive the browser yourself
5. Click **Return Control** — the AI receives a page snapshot and picks up naturally

---

## Project structure

```
friday/
├── presenter-app/
│   ├── src/
│   │   ├── main.js                     # Electron main process
│   │   ├── preload.js                  # contextBridge (fs, path, env)
│   │   └── renderer/
│   │       ├── App.jsx                 # root: mode state, tab routing
│   │       ├── tabs/
│   │       │   ├── PresentTab.jsx      # live UI: mic, action feed, flows
│   │       │   ├── FlowsTab.jsx        # import, edit, test flows
│   │       │   └── KnowledgeTab.jsx    # knowledge base editor
│   │       ├── components/
│   │       ├── hooks/
│   │       │   ├── useGeminiSession.js # Gemini Live audio I/O
│   │       │   ├── useMCPClient.js     # Playwright MCP JSON-RPC client
│   │       │   └── useFlows.js         # flow loader + search index
│   │       ├── orchestrator/
│   │       │   └── Orchestrator.js     # core dispatcher + flow runner
│   │       └── utils/
│   │           ├── convertDevToolsFlow.js
│   │           ├── buildSearchIndex.js
│   │           └── flowRepairer.js
│   ├── flows/
│   │   └── flows.json                  # your flow library (git-ignored)
│   └── .env.example
├── playwright-mcp.config.json
├── start-all.sh / start-all.bat
└── LICENSE
```

---

## Roadmap

### Current focus
- Robust presenter loop: reliable flow execution, voice matching, manual override
- Cross-platform (Mac + Windows)
- Flow import from Chrome DevTools Recorder

### Next: Token-efficient instruction recording

The current approach sends full conversation context to the AI on every turn. The next major direction reduces this drastically.

**The idea:** Instead of the AI figuring out browser actions from scratch each time, record the *LLM decision trace* — the sequence of tool calls and reasoning steps the model took — as a replayable instruction set. When the same intent appears again, replay the recorded trace directly through MCP without invoking the model at all.

This means:
- Common demo paths cost near-zero tokens after the first run
- The AI is only invoked for genuinely new or ambiguous intents
- Recorded traces are inspectable, editable, and version-controllable
- The system gets faster and cheaper the more it's used

Think of it as a DVR for LLM reasoning: record once, replay many times, only go live when needed.

This builds toward a general pattern where MCP-connected agents can pre-compute and cache their decision paths, making AI-driven automation practical at scale without burning API budget.

---

## Environment variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Your Google Gemini API key |
| `TARGET_URL` | The demo website URL (default: `http://localhost:3000`) |
| `MCP_SERVER_URL` | Playwright MCP server (default: `http://localhost:8931`) |

---

## License

MIT — see [LICENSE](LICENSE)
