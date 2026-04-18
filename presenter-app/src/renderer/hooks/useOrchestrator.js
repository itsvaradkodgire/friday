// Thin React bridge for the Orchestrator class.
// Creates the instance once, subscribes to state changes, and syncs
// React state (flows, searchIndex) into the orchestrator.

const { useEffect, useRef, useState, useCallback } = require('react');
const { Orchestrator } = require('../orchestrator/Orchestrator');

function useOrchestrator({ callMCPTool, emitLog }) {
  const orchRef = useRef(null);
  if (!orchRef.current) {
    orchRef.current = new Orchestrator({ callMCPTool, emitLog });
  }
  const orch = orchRef.current;

  // React state driven by orchestrator notifications.
  const [appMode, setAppModeState] = useState('IDLE');
  const [activeExecution, setActiveExecution] = useState(null);

  // Subscribe to orchestrator callbacks (once).
  useEffect(() => {
    orch.onAppModeChange((mode) => {
      setAppModeState(mode);
    });
    orch.onExecutionChange(() => {
      const exec = orch.getActiveExecution();
      setActiveExecution(exec ? {
        flow: exec.flow,
        progress: { ...exec.progress },
        startedAt: exec.startedAt
      } : null);
    });
  }, [orch]);

  // Setter that syncs both orchestrator and React.
  const setAppMode = useCallback((mode) => {
    orch.setAppMode(mode);
    setAppModeState(mode);
  }, [orch]);

  // Stable bound methods.
  const handleMessage = useCallback((msg) => orch.handleMessage(msg), [orch]);
  const toggleManualControl = useCallback(() => orch.toggleManualControl(), [orch]);
  const playFlow = useCallback((flow) => orch.playFlow(flow), [orch]);

  return {
    orchestrator: orch,
    appMode,
    activeExecution,
    setAppMode,
    handleMessage,
    toggleManualControl,
    playFlow
  };
}

module.exports = { useOrchestrator };
