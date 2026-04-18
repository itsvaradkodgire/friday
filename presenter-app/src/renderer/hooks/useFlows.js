// Loads flows.json, watches for changes via fs.watch, exposes saveFlow + deleteFlow.
// Rebuilds the search index on every load. Path is always ../../flows/flows.json
// relative to the renderer directory (i.e. presenter-app/flows/flows.json from src/renderer).

const { useEffect, useRef, useState, useCallback } = require('react');
const { buildSearchIndex } = require('../utils/buildSearchIndex');

// Resolve fs/path lazily through the preload bridge so this hook stays renderer-safe.
function getNodeApi() {
  if (typeof window !== 'undefined' && window.nodeApi) return window.nodeApi;
  // Fallback for non-Electron test contexts.
  return {
    fs: require('fs'),
    path: require('path'),
    dirname: __dirname
  };
}

function useFlows() {
  const [flows, setFlows] = useState([]);
  const [searchIndex, setSearchIndex] = useState(new Map());
  const [error, setError] = useState(null);
  const flowsPathRef = useRef(null);

  const resolveFlowsPath = useCallback(() => {
    const api = getNodeApi();
    if (!flowsPathRef.current) {
      // Path is always ../../flows/flows.json relative to the renderer directory.
      flowsPathRef.current = api.path.resolve(api.dirname, '../../flows/flows.json');
    }
    return flowsPathRef.current;
  }, []);

  const loadFlows = useCallback(() => {
    const api = getNodeApi();
    const flowsPath = resolveFlowsPath();
    try {
      const raw = api.fs.readFileSync(flowsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      // Filter out browser_resize steps from every flow at load time. Recorded
      // viewports shrink the audience-facing browser to whatever the presenter
      // had at recording time (often unwatchably small) - we don't want them.
      // Defense in depth: convertDevToolsFlow no longer emits these for new
      // imports, but old flows on disk still have them.
      const cleaned = arr.map((flow) => ({
        ...flow,
        steps: Array.isArray(flow.steps)
          ? flow.steps.filter((s) => s && s.tool !== 'browser_resize')
          : []
      }));
      setFlows(cleaned);
      setSearchIndex(buildSearchIndex(cleaned));
      setError(null);
    } catch (err) {
      console.error('Failed to load flows.json:', err.message);
      setError(err.message);
    }
  }, [resolveFlowsPath]);

  useEffect(() => {
    const api = getNodeApi();
    const flowsPath = resolveFlowsPath();

    loadFlows();

    let watcher = null;
    try {
      watcher = api.fs.watch(flowsPath, () => loadFlows());
    } catch (err) {
      console.warn('fs.watch failed for flows.json:', err.message);
    }

    return () => {
      if (watcher) {
        try { watcher.close(); } catch {}
      }
    };
  }, [loadFlows, resolveFlowsPath]);

  const saveFlow = useCallback(
    (newFlow) => {
      const api = getNodeApi();
      const flowsPath = resolveFlowsPath();
      const updated = [...flows.filter((f) => f.id !== newFlow.id), newFlow];
      api.fs.writeFileSync(flowsPath, JSON.stringify(updated, null, 2), 'utf8');
      // fs.watch will pick up the change and reload automatically.
    },
    [flows, resolveFlowsPath]
  );

  const deleteFlow = useCallback(
    (flowId) => {
      const api = getNodeApi();
      const flowsPath = resolveFlowsPath();
      const updated = flows.filter((f) => f.id !== flowId);
      api.fs.writeFileSync(flowsPath, JSON.stringify(updated, null, 2), 'utf8');
    },
    [flows, resolveFlowsPath]
  );

  return { flows, searchIndex, saveFlow, deleteFlow, error, reload: loadFlows };
}

module.exports = { useFlows };
