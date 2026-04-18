// Top-level app. Owns:
//   - the action log (capped, fed to ActionFeed)
//   - tab routing (Present / Flows / Knowledge)
//   - composition of useFlows, useKnowledgeSections, useMCPClient, useOrchestrator, useGeminiSession
//
// appMode and execution state are owned by the Orchestrator (via useOrchestrator).
// The Gemini session is a pure I/O layer bound to the orchestrator at connect time.

const React = require('react');
const { useEffect, useMemo, useRef, useState, useCallback } = React;

const { useFlows } = require('./hooks/useFlows');
const { useKnowledge } = require('./hooks/useKnowledge');
const { useKnowledgeSections } = require('./hooks/useKnowledgeSections');
const { useMCPClient } = require('./hooks/useMCPClient');
const { useOrchestrator } = require('./hooks/useOrchestrator');
const { useGeminiSession } = require('./hooks/useGeminiSession');

const { PresentTab } = require('./tabs/PresentTab');
const { FlowsTab } = require('./tabs/FlowsTab');
const { KnowledgeTab } = require('./tabs/KnowledgeTab');

const MAX_LOG = 200;

function App() {
  const [tab, setTab] = useState('present');
  const [actionLog, setActionLog] = useState([]);
  const [needsReconnect, setNeedsReconnect] = useState(false);
  const [reconnectReason, setReconnectReason] = useState(null);
  const sessionStartedAtRef = useRef(Date.now());
  const prevAppModeRef = useRef('IDLE');

  const emitLog = useCallback((entry) => {
    setActionLog((prev) => {
      const next = [...prev, { ...entry, t: entry.t || Date.now() }];
      if (next.length > MAX_LOG) return next.slice(-MAX_LOG);
      return next;
    });
  }, []);

  const { flows, searchIndex, saveFlow, deleteFlow } = useFlows();
  const { knowledge, version: knowledgeVersion } = useKnowledge();
  const kb = useKnowledgeSections();

  const sessionSnapshotRef = useRef({ flowsLen: -1, knowledgeVersion: -1, kbVersion: -1 });

  const mcp = useMCPClient();

  const apiKey = useMemo(
    () =>
      (typeof process !== 'undefined' && process.env && process.env.GEMINI_API_KEY) ||
      (window.appEnv && window.appEnv.GEMINI_API_KEY),
    []
  );

  // --- orchestrator (owns appMode + execution state) ---
  const orch = useOrchestrator({ callMCPTool: mcp.callMCPTool, emitLog });

  // --- Gemini session (pure I/O, forwards messages to orchestrator) ---
  const gemini = useGeminiSession({
    apiKey,
    knowledge,
    flows,
    sections: kb.sections,
    onMessage: orch.handleMessage
  });

  // Bind/unbind the session to the orchestrator when connection status changes.
  useEffect(() => {
    if (gemini.status === 'connected') {
      orch.orchestrator.bindSession({
        sendText: gemini.sendText,
        sendToolResponse: gemini.sendToolResponse
      });
    } else {
      orch.orchestrator.unbindSession();
    }
  }, [gemini.status, gemini.sendText, gemini.sendToolResponse, orch.orchestrator]);

  // Sync flows/searchIndex/sections/callMCPTool into orchestrator when they change.
  useEffect(() => {
    orch.orchestrator.setFlows(flows);
    orch.orchestrator.setSearchIndex(searchIndex);
  }, [flows, searchIndex, orch.orchestrator]);

  useEffect(() => {
    orch.orchestrator.setCallMCPTool(mcp.callMCPTool);
  }, [mcp.callMCPTool, orch.orchestrator]);

  useEffect(() => {
    orch.orchestrator.setSections(kb.sections);
  }, [kb.sections, orch.orchestrator]);

  // Connect Gemini once MCP is up.
  useEffect(() => {
    if (gemini.status === 'disconnected' && mcp.connected && apiKey) {
      gemini.connectSession();
      sessionSnapshotRef.current = {
        flowsLen: flows.length,
        knowledgeVersion: knowledgeVersion,
        kbVersion: kb.version
      };
      setNeedsReconnect(false);
      setReconnectReason(null);
    }
  }, [gemini, mcp.connected, apiKey, flows.length, knowledgeVersion, kb.version]);

  // Detect changes to flows/knowledge/sections while session is open.
  useEffect(() => {
    if (gemini.status !== 'connected') return;
    const snap = sessionSnapshotRef.current;
    const flowsChanged = flows.length !== snap.flowsLen;
    const knowledgeChanged = knowledgeVersion !== snap.knowledgeVersion;
    const kbChanged = kb.version !== snap.kbVersion;
    if (flowsChanged || knowledgeChanged || kbChanged) {
      setNeedsReconnect(true);
      const parts = [];
      if (flowsChanged) parts.push('flows');
      if (knowledgeChanged) parts.push('knowledge');
      if (kbChanged) parts.push('knowledge sections');
      setReconnectReason(parts.join(' and '));
    }
  }, [flows.length, knowledgeVersion, kb.version, gemini.status]);

  const handleReconnectGemini = useCallback(async () => {
    emitLog({ event: 'session_reconnecting', reason: reconnectReason });
    await gemini.reconnectSession();
    sessionSnapshotRef.current = {
      flowsLen: flows.length,
      knowledgeVersion: knowledgeVersion,
      kbVersion: kb.version
    };
    setNeedsReconnect(false);
    setReconnectReason(null);
  }, [emitLog, gemini, flows.length, knowledgeVersion, kb.version, reconnectReason]);

  // Log appMode transitions.
  useEffect(() => {
    const prev = prevAppModeRef.current;
    if (prev !== orch.appMode) {
      emitLog({ event: 'mode_change', mode: orch.appMode, from: prev });
      prevAppModeRef.current = orch.appMode;
    }
  }, [orch.appMode, emitLog]);

  // First user interaction unlocks audio output context.
  useEffect(() => {
    const unlockOnce = () => {
      if (gemini.unlockAudio) gemini.unlockAudio();
    };
    window.addEventListener('pointerdown', unlockOnce, { once: true });
    window.addEventListener('keydown', unlockOnce, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
  }, [gemini]);

  // --- push-to-talk (gates on appMode from orchestrator) ---
  const startListening = useCallback(() => {
    gemini.unlockAudio();
    if (orch.appMode !== 'IDLE') return;
    orch.setAppMode('LISTENING');
    gemini.startMicStream();
  }, [gemini, orch]);

  const stopListening = useCallback(() => {
    if (orch.appMode !== 'LISTENING') return;
    gemini.stopMicStream();
    orch.setAppMode('IDLE');
  }, [gemini, orch]);

  // Spacebar shortcut.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === 'Space' && !e.repeat && orch.appMode === 'IDLE') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        startListening();
      }
    };
    const onKeyUp = (e) => {
      if (e.code === 'Space') {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        stopListening();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [startListening, stopListening, orch.appMode]);

  // Play flow from library.
  const handlePlayFlow = useCallback(
    (flow) => orch.playFlow(flow),
    [orch]
  );

  return (
    <div className="app">
      <nav className="tab-nav">
        <button
          className={tab === 'present' ? 'tab active' : 'tab'}
          onClick={() => setTab('present')}
        >
          Present
        </button>
        <button
          className={tab === 'flows' ? 'tab active' : 'tab'}
          onClick={() => setTab('flows')}
        >
          Flows
        </button>
        <button
          className={tab === 'knowledge' ? 'tab active' : 'tab'}
          onClick={() => setTab('knowledge')}
        >
          Knowledge
        </button>
        <span className="tab-spacer" />
        <span className="tab-flow-count">{flows.length} flows &middot; {kb.sections.length} sections</span>
      </nav>

      <main className="tab-content">
        <div style={{ display: tab === 'present' ? 'contents' : 'none' }}>
          <PresentTab
            appMode={orch.appMode}
            flows={flows}
            activeExecution={orch.activeExecution}
            actionLog={actionLog}
            mcp={mcp}
            gemini={gemini}
            sessionStartedAt={sessionStartedAtRef.current}
            needsReconnect={needsReconnect}
            reconnectReason={reconnectReason}
            onReconnect={handleReconnectGemini}
            onStartListening={startListening}
            onStopListening={stopListening}
            onToggleManual={orch.toggleManualControl}
            onPlayFlow={handlePlayFlow}
          />
        </div>
        <div style={{ display: tab === 'flows' ? 'contents' : 'none' }}>
          <FlowsTab flows={flows} saveFlow={saveFlow} deleteFlow={deleteFlow} callMCPTool={mcp.callMCPTool} />
        </div>
        <div style={{ display: tab === 'knowledge' ? 'contents' : 'none' }}>
          <KnowledgeTab
            sections={kb.sections}
            flows={flows}
            saveSection={kb.saveSection}
            deleteSection={kb.deleteSection}
          />
        </div>
      </main>
    </div>
  );
}

module.exports = { App };
