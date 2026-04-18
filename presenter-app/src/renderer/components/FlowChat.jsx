// Conversational flow builder with multi-conversation support.
// Chat state persists across tab switches (tabs are CSS-hidden, not unmounted).
// Conversations are saved to disk so they survive app restarts.

const React = require('react');
const { useState, useRef, useEffect, useCallback } = React;
const { GoogleGenAI } = require('@google/genai');
const { improveFlow, preProcessRawSteps } = require('../utils/flowImprover');
const { testFlow, buildFixedFlow } = require('../utils/flowTester');

const CHAT_MODEL = 'gemini-2.5-flash';
const MAX_RAW_MESSAGES = 8;
const MAX_FIX_ATTEMPTS = 3;

// Maps our internal tool names back to Chrome DevTools Recorder step types so
// improveFlow (which expects recorder-shaped input) can process saved flows.
function toolToRecorderType(tool) {
  switch (tool) {
    case 'browser_navigate': return 'navigate';
    case 'browser_click': return 'click';
    case 'browser_type': return 'change';
    case 'browser_press_key': return 'keyDown';
    case 'browser_scroll': return 'scroll';
    case 'browser_hover': return 'hover';
    case 'browser_wait_for': return 'waitForElement';
    default: return tool;
  }
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------
function getNodeApi() {
  if (typeof window !== 'undefined' && window.nodeApi) return window.nodeApi;
  return null;
}

function getConversationsPath() {
  const api = getNodeApi();
  if (!api) return null;
  return api.path.resolve(api.dirname, '../../conversations.json');
}

function loadConversations() {
  const api = getNodeApi();
  const p = getConversationsPath();
  if (!api || !p) return [];
  try {
    const raw = api.fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function saveConversations(conversations) {
  const api = getNodeApi();
  const p = getConversationsPath();
  if (!api || !p) return;
  try {
    api.fs.writeFileSync(p, JSON.stringify(conversations, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to save conversations:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Chat memory management
// ---------------------------------------------------------------------------
function summarizeOldMessages(messages) {
  const points = [];
  for (const m of messages) {
    if (m.role === 'user') {
      points.push('User: ' + m.content.slice(0, 200));
    } else if (m.role === 'assistant') {
      const flowInfo = m.flow ? ` (updated flow to ${m.flow.steps.length} steps)` : '';
      points.push('AI: ' + m.content.slice(0, 150) + flowInfo);
    } else if (m.role === 'system' && m.testReport) {
      points.push(`Test: ${m.testReport.passed}/${m.testReport.totalSteps} passed`);
    } else if (m.role === 'system') {
      points.push('System: ' + m.content.slice(0, 100));
    }
  }
  return points.join('\n');
}

function buildChatPrompt(messages, currentFlow, latestTestReport, verbosity) {
  let summary = null;
  let recent = messages;
  if (messages.length > MAX_RAW_MESSAGES) {
    summary = summarizeOldMessages(messages.slice(0, -MAX_RAW_MESSAGES));
    recent = messages.slice(-MAX_RAW_MESSAGES);
  }

  const systemText = `You are a flow builder assistant called Basanti for the AI Demo Presenter app.
You help the user create, improve, and test browser automation flows for live demos.

VERBOSITY: ${verbosity}

When the user uploads a Chrome DevTools Recorder JSON or describes a flow:
1. Clean it up (merge consecutive keypresses into browser_type, drop viewport/keyUp)
2. Generate narrations for each step (match the verbosity level)
3. If test results are available, fix failed steps using the live page snapshots

When the user gives instructions (e.g. "skip step 3", "change URL to X", "add a click on Y"):
- Modify the current flow accordingly and output the updated version

ALLOWED TOOLS: browser_navigate, browser_click, browser_type, browser_press_key,
browser_scroll, browser_wait_for, browser_hover

SELECTOR FORMAT: flat array of strings. Use "aria/<accessible name>" from page snapshots when available.

NARRATION RULES:
- Natural, confident speech as a co-presenter. Do NOT say "click", "type", "press".
- Narrations should describe the INTENT and what the audience will SEE, adapting to the
  actual page content. Avoid referencing specific article names or dynamic content that
  changes between visits — describe the TYPE of content instead (e.g. "today's featured
  article" not "the article about Interstate 205").
- Match verbosity: ${verbosity}

RESPONSE FORMAT:
- Include a conversational message explaining what you did.
- If you produced or modified a flow, include a JSON block at the END:
  \`\`\`json
  {"flow":{"id":"...","name":"...","description":"...","steps":[{"tool":"...","params":{...},"narration":"..."},...]}}
  \`\`\`
- If no flow change needed, just respond with text.

${summary ? `CONVERSATION SUMMARY (older messages):\n${summary}\n` : ''}
${currentFlow ? `CURRENT FLOW:\n${JSON.stringify({ name: currentFlow.name, description: currentFlow.description, steps: currentFlow.steps.map(s => ({ tool: s.tool, params: s.params, narration: s.narration })) }, null, 2)}\n` : ''}
${latestTestReport ? `LATEST TEST RESULTS:\n${formatTestReport(latestTestReport)}\n` : ''}`;

  const contents = [{ role: 'user', parts: [{ text: systemText }] }];
  for (const m of recent) {
    if (m.role === 'system') {
      contents.push({ role: 'user', parts: [{ text: `[SYSTEM] ${m.content}` }] });
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }
  }
  return contents;
}

function formatTestReport(report) {
  if (!report || !report.stepResults) return '(no test data)';
  return report.stepResults.map((r, i) => {
    const lines = [`Step ${i + 1}: ${r.tool} — ${r.status.toUpperCase()}`];
    if (r.error) lines.push(`  Error: ${r.error}`);
    if (r.resolvedSelector) lines.push(`  Working selector: ${r.resolvedSelector}`);
    if (r.snapshot) lines.push(`  Page state:\n${r.snapshot.slice(0, 2000)}`);
    return lines.join('\n');
  }).join('\n\n');
}

function extractFlowFromResponse(text) {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?"flow"\s*:[\s\S]*?\})\s*```/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]);
      if (parsed.flow && Array.isArray(parsed.flow.steps)) return parsed.flow;
    } catch {}
  }
  const bareMatch = text.match(/\{[\s\S]*"flow"\s*:\s*\{[\s\S]*"steps"\s*:\s*\[[\s\S]*\]\s*\}\s*\}\s*$/);
  if (bareMatch) {
    try {
      const parsed = JSON.parse(bareMatch[0]);
      if (parsed.flow && Array.isArray(parsed.flow.steps)) return parsed.flow;
    } catch {}
  }
  return null;
}

function stripJsonBlock(text) {
  return text
    .replace(/```(?:json)?\s*\{[\s\S]*?"flow"\s*:[\s\S]*?\}\s*```/g, '')
    .replace(/\{[\s\S]*"flow"\s*:\s*\{[\s\S]*"steps"\s*:\s*\[[\s\S]*\]\s*\}\s*\}\s*$/g, '')
    .trim();
}

function newConversation(title) {
  return {
    id: 'conv_' + Date.now(),
    title: title || 'New conversation',
    createdAt: new Date().toISOString(),
    messages: [
      { role: 'system', content: 'Drop a recorder JSON, pick a saved flow to edit, or describe what you want to build.' }
    ],
    currentFlow: null,
    verbosity: 'normal'
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function FlowChat({ onSave, callMCPTool, flows, initialFlow }) {
  const [conversations, setConversations] = useState(() => {
    const saved = loadConversations();
    return saved.length > 0 ? saved : [newConversation()];
  });
  const [activeConvId, setActiveConvId] = useState(() => {
    const saved = loadConversations();
    return saved.length > 0 ? saved[0].id : conversations[0]?.id;
  });
  const [latestTestReport, setLatestTestReport] = useState(null);
  const [inputText, setInputText] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingProgress, setTestingProgress] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const initialFlowLoadedRef = useRef(false);

  const activeConv = conversations.find(c => c.id === activeConvId) || conversations[0];
  const messages = activeConv?.messages || [];
  const currentFlow = activeConv?.currentFlow || null;
  const verbosity = activeConv?.verbosity || 'normal';

  // Persist conversations to disk whenever they change
  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  function updateActiveConv(updater) {
    setConversations(prev => prev.map(c =>
      c.id === activeConvId ? (typeof updater === 'function' ? updater(c) : { ...c, ...updater }) : c
    ));
  }

  function addMessage(msg) {
    updateActiveConv(c => ({ ...c, messages: [...c.messages, msg] }));
  }

  function setCurrentFlowOnConv(flow) {
    updateActiveConv({ currentFlow: flow });
  }

  function setVerbosityOnConv(v) {
    updateActiveConv({ verbosity: v });
  }

  // Load initialFlow from Edit button
  useEffect(() => {
    if (!initialFlow) return;
    if (initialFlowLoadedRef.current === initialFlow.id) return;
    initialFlowLoadedRef.current = initialFlow.id;

    const conv = newConversation(`Editing: ${initialFlow.name}`);
    conv.currentFlow = initialFlow;
    conv.verbosity = initialFlow.verbosity || 'normal';
    conv.messages = [
      { role: 'system', content: 'Drop a recorder JSON, pick a saved flow to edit, or describe what you want to build.' },
      { role: 'system', content: `Loaded: "${initialFlow.name}" (${initialFlow.steps.length} steps)` },
      { role: 'assistant', content: `I've loaded "${initialFlow.name}" with ${initialFlow.steps.length} steps. What would you like me to do? I can test it, update narrations, fix broken steps, or make any changes you describe.`, flow: initialFlow }
    ];
    setConversations(prev => [conv, ...prev]);
    setActiveConvId(conv.id);
  }, [initialFlow]);

  function getApiKey() {
    return (typeof window !== 'undefined' && window.appEnv && window.appEnv.GEMINI_API_KEY) || '';
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, testingProgress]);

  function handleNewChat() {
    const conv = newConversation();
    setConversations(prev => [conv, ...prev]);
    setActiveConvId(conv.id);
    setLatestTestReport(null);
  }

  function handleDeleteConv(convId) {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== convId);
      if (next.length === 0) next.push(newConversation());
      if (activeConvId === convId) setActiveConvId(next[0].id);
      return next;
    });
  }

  const sendToAI = useCallback(async (userContent, extraContext) => {
    const apiKey = getApiKey();
    if (!apiKey) throw new Error('No GEMINI_API_KEY set');

    const allMessages = [...messages, { role: 'user', content: userContent }];
    if (extraContext) allMessages.push({ role: 'system', content: extraContext });

    const contents = buildChatPrompt(allMessages, currentFlow, latestTestReport, verbosity);
    contents.push({ role: 'user', parts: [{ text: userContent + (extraContext ? '\n\n[CONTEXT] ' + extraContext : '') }] });

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: CHAT_MODEL,
      contents,
      config: { temperature: 0.3 }
    });
    return response?.text || '';
  }, [messages, currentFlow, latestTestReport, verbosity]);

  const runTest = useCallback(async (flow) => {
    if (!callMCPTool || !flow?.steps?.length) return null;
    setTestingProgress({ current: 0, total: flow.steps.length, passed: 0, failed: 0 });
    try {
      return await testFlow(flow, callMCPTool, (idx, result, partial) => {
        setTestingProgress({ current: idx + 1, total: flow.steps.length, passed: partial.passed, failed: partial.failed });
      });
    } catch (err) {
      console.warn('Flow test failed:', err.message);
      return null;
    } finally {
      setTestingProgress(null);
    }
  }, [callMCPTool]);

  const handleSend = useCallback(async (text, recorderJson) => {
    if (busy) return;
    if (!text.trim() && !recorderJson) return;
    setBusy(true);

    const userMsg = text.trim() || (recorderJson ? `Uploaded: ${recorderJson.title || 'flow'}` : '');
    addMessage({ role: 'user', content: userMsg });
    setInputText('');

    // Update conversation title from first real user message
    if (messages.length <= 2) {
      updateActiveConv({ title: userMsg.slice(0, 50) });
    }

    try {
      let extraContext = '';
      if (recorderJson) {
        const cleaned = preProcessRawSteps(recorderJson.steps || []);
        extraContext = `UPLOADED RECORDER JSON (title: "${recorderJson.title}", ${cleaned.length} steps):\n` +
          JSON.stringify(cleaned.map(s => {
            const out = { type: s.type };
            if (s.url) out.url = s.url;
            if (s.selectors) out.selectors = s.selectors;
            if (s.value) out.value = s.value;
            if (s.key) out.key = s.key;
            return out;
          }), null, 2);
      }

      const responseText = await sendToAI(userMsg, extraContext);
      const flowData = extractFlowFromResponse(responseText);
      const chatText = stripJsonBlock(responseText) || responseText;
      const assistantMsg = { role: 'assistant', content: chatText };

      if (flowData) {
        const name = flowData.name || currentFlow?.name || recorderJson?.title || 'flow';
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const flow = {
          id, name,
          description: flowData.description || currentFlow?.description || '',
          source: 'devtools-recorder+ai',
          verbosity,
          created_at: new Date().toISOString(),
          steps: flowData.steps || []
        };
        assistantMsg.flow = flow;
        setCurrentFlowOnConv(flow);
        addMessage(assistantMsg);

        // ---- Probing test + iterative AI fix loop ----
        // Phase 1: The tester actively PROBES the live page. When a step fails,
        // it takes a snapshot, extracts candidate selectors from the accessibility
        // tree, and actually TRIES each one until one works. This fixes most
        // selector-mismatch issues without any AI call.
        //
        // Phase 2: If steps STILL fail after probing (e.g. the element genuinely
        // doesn't exist, or the page is in the wrong state), we send the full
        // test report to the AI improver for a rewrite, then re-test. Up to
        // MAX_FIX_ATTEMPTS rounds.
        if (callMCPTool && flow.steps.length > 0) {
          const apiKey = getApiKey();
          let currentTestFlow = flow;

          for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
            addMessage({ role: 'system', content: attempt === 1
              ? 'Testing flow against live browser (probing for working selectors)...'
              : `Re-testing with AI fixes (attempt ${attempt}/${MAX_FIX_ATTEMPTS})...`
            });
            const report = await runTest(currentTestFlow);
            if (!report) break;

            setLatestTestReport(report);

            // Build the fixed flow from probing results (replaces broken
            // selectors with ones that actually worked on the live page)
            const probeFixed = buildFixedFlow(currentTestFlow, report);

            // All passed (some may have been fixed by probing)
            if (report.failed === 0) {
              const fixedCount = report.fixed || 0;
              const msg = fixedCount > 0
                ? `All ${report.totalSteps} steps passed ✓ (${fixedCount} fixed by probing the live page)`
                : `All ${report.totalSteps} steps passed ✓`;
              addMessage({ role: 'system', content: msg });
              setCurrentFlowOnConv(probeFixed);
              if (fixedCount > 0) {
                addMessage({ role: 'assistant', content: `I found working selectors for ${fixedCount} broken steps by testing them against the live page. The flow is now ready.`, flow: probeFixed });
              }
              break;
            }

            // Some still failed even after probing
            const fixedCount = report.fixed || 0;
            const summary = `Attempt ${attempt}: ${report.passed}/${report.totalSteps} passed` +
              (fixedCount > 0 ? ` (${fixedCount} fixed by probing)` : '') +
              ` — ${report.failed} still failing`;
            addMessage({ role: 'system', content: summary, testReport: report });

            // Save the probe-fixed version as the current flow
            currentTestFlow = probeFixed;
            setCurrentFlowOnConv(probeFixed);

            // Last attempt — let the user intervene
            if (attempt === MAX_FIX_ATTEMPTS) {
              addMessage({ role: 'system', content:
                `After ${MAX_FIX_ATTEMPTS} attempts, ${report.passed}/${report.totalSteps} steps pass. ` +
                'You can save as-is, tell me which steps to fix, or try a different approach.'
              });
              break;
            }

            // Send to AI for a deeper rewrite of the remaining failures
            if (!apiKey) {
              addMessage({ role: 'system', content: 'No API key — cannot ask AI to fix remaining failures. You can save as-is or give instructions.' });
              break;
            }
            addMessage({ role: 'system', content: 'Asking AI to fix the remaining failures...' });
            try {
              const syntheticRecorder = {
                title: currentTestFlow.name || 'flow',
                steps: currentTestFlow.steps.map(s => ({
                  type: toolToRecorderType(s.tool),
                  url: s.params?.url,
                  selectors: s.params?.selectors ? [s.params.selectors] : undefined,
                  value: s.params?.text,
                  key: s.params?.key,
                  x: s.params?.x,
                  y: s.params?.y
                }))
              };
              const aiFixed = await improveFlow(syntheticRecorder, verbosity, apiKey, {
                name: currentTestFlow.name,
                description: currentTestFlow.description
              }, report);
              currentTestFlow = aiFixed;
              addMessage({ role: 'assistant', content: `AI rewrote the flow to ${aiFixed.steps.length} steps. Re-testing with probing...`, flow: aiFixed });
              setCurrentFlowOnConv(aiFixed);
            } catch (fixErr) {
              addMessage({ role: 'system', content: `AI fix failed: ${fixErr.message}. You can save as-is or give instructions.` });
              break;
            }
          }
        }
      } else {
        addMessage(assistantMsg);
      }
    } catch (err) {
      addMessage({ role: 'system', content: `Error: ${err.message}` });
    } finally {
      setBusy(false);
    }
  }, [busy, sendToAI, runTest, callMCPTool, currentFlow, verbosity, messages]);

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target.result);
        if (!json.title || !Array.isArray(json.steps)) {
          addMessage({ role: 'system', content: 'Invalid file: missing title or steps.' });
          return;
        }
        handleSend(inputText || `Here's my recorded flow: "${json.title}"`, json);
      } catch (err) {
        addMessage({ role: 'system', content: `Failed to parse: ${err.message}` });
      }
    };
    reader.readAsText(file);
  }

  function handleSave() {
    if (!currentFlow || !onSave) return;
    try {
      onSave(currentFlow);
      addMessage({ role: 'system', content: `Flow "${currentFlow.name}" saved!` });
    } catch (err) {
      addMessage({ role: 'system', content: `Save failed: ${err.message}` });
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(inputText, null);
    }
  }

  return (
    <div className="flow-chat">
      {/* Sidebar */}
      <div className={`chat-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <button className="btn-primary sidebar-new" onClick={handleNewChat}>+ New</button>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)}>
            {sidebarOpen ? '\u2039' : '\u203A'}
          </button>
        </div>
        {sidebarOpen && (
          <ul className="sidebar-list">
            {conversations.map(c => (
              <li
                key={c.id}
                className={`sidebar-item ${c.id === activeConvId ? 'active' : ''}`}
                onClick={() => { setActiveConvId(c.id); setLatestTestReport(null); }}
              >
                <span className="sidebar-title">{c.title}</span>
                <span className="sidebar-meta">
                  {c.currentFlow ? `${c.currentFlow.steps?.length || 0} steps` : 'empty'}
                </span>
                {conversations.length > 1 && (
                  <button
                    className="sidebar-delete"
                    onClick={(e) => { e.stopPropagation(); handleDeleteConv(c.id); }}
                    title="Delete conversation"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Main chat area */}
      <div className="chat-main">
        <div className="chat-header">
          <h3>{activeConv?.title || 'Flow Builder'}</h3>
          <label className="verbosity-select">
            <select value={verbosity} onChange={(e) => setVerbosityOnConv(e.target.value)} disabled={busy}>
              <option value="brief">Brief</option>
              <option value="normal">Normal</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>
        </div>

        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={i} className={`chat-message chat-${m.role}`}>
              {m.role === 'user' && <span className="chat-role">You</span>}
              {m.role === 'assistant' && <span className="chat-role">Basanti</span>}
              <div className="chat-content">{m.content}</div>
              {m.flow && (
                <div className="chat-flow-preview">
                  <strong>{m.flow.steps.length} steps</strong>
                  {m.flow._testReport && (
                    <span className="test-badge">
                      {' '}— tested ({m.flow._testReport.passed}/{m.flow._testReport.total} passed)
                    </span>
                  )}
                  <ol>
                    {m.flow.steps.slice(0, 10).map((s, j) => (
                      <li key={j}>
                        <code>{s.tool}</code>{' '}
                        <span className="step-param">
                          {s.params?.url || s.params?.selectors?.[0] || s.params?.key || s.params?.text || ''}
                        </span>
                        {s.narration && <div className="chat-narration">{s.narration}</div>}
                      </li>
                    ))}
                    {m.flow.steps.length > 10 && <li className="step-param">... and {m.flow.steps.length - 10} more</li>}
                  </ol>
                </div>
              )}
            </div>
          ))}

          {testingProgress && (
            <div className="chat-message chat-system">
              <span className="spinner" /> Testing: step {testingProgress.current}/{testingProgress.total}
              {testingProgress.passed > 0 && <span className="test-pass"> ({testingProgress.passed}✓)</span>}
              {testingProgress.failed > 0 && <span className="test-fail"> ({testingProgress.failed}✗)</span>}
            </div>
          )}
          {busy && !testingProgress && (
            <div className="chat-message chat-system"><span className="spinner" /> Thinking...</div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-row">
          <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileChange} />
          <button className="chat-attach" onClick={() => fileInputRef.current?.click()} disabled={busy} title="Attach recorder JSON">+</button>
          <input
            className="chat-input"
            type="text"
            placeholder="Type a message or attach a recorder JSON..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
          />
          <button className="btn-primary chat-send" onClick={() => handleSend(inputText, null)} disabled={busy || !inputText.trim()}>Send</button>
          {currentFlow && (
            <button className="btn-primary chat-save" onClick={handleSave} disabled={busy}>Save Flow</button>
          )}
        </div>
      </div>
    </div>
  );
}

module.exports = { FlowChat };
