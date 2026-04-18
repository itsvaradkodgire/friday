// Loads knowledge.md, watches for changes via fs.watch, exposes its contents
// plus a monotonically increasing version counter so consumers (the system
// prompt builder, the reconnect banner) can detect changes.
//
// Path is `../../knowledge/knowledge.md` relative to the renderer directory.
// Mirrors the path convention used by useFlows.js for flows.json.

const { useEffect, useRef, useState, useCallback } = require('react');

function getNodeApi() {
  if (typeof window !== 'undefined' && window.nodeApi) return window.nodeApi;
  return {
    fs: require('fs'),
    path: require('path'),
    dirname: __dirname
  };
}

function useKnowledge() {
  const [knowledge, setKnowledge] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState(null);
  const knowledgePathRef = useRef(null);

  const resolveKnowledgePath = useCallback(() => {
    const api = getNodeApi();
    if (!knowledgePathRef.current) {
      knowledgePathRef.current = api.path.resolve(api.dirname, '../../knowledge/knowledge.md');
    }
    return knowledgePathRef.current;
  }, []);

  const loadKnowledge = useCallback(() => {
    const api = getNodeApi();
    const knowledgePath = resolveKnowledgePath();
    try {
      const raw = api.fs.readFileSync(knowledgePath, 'utf8');
      setKnowledge(raw);
      setVersion((v) => v + 1);
      setError(null);
    } catch (err) {
      console.error('Failed to load knowledge.md:', err.message);
      setKnowledge('');
      setError(err.message);
      setVersion((v) => v + 1);
    }
  }, [resolveKnowledgePath]);

  useEffect(() => {
    const api = getNodeApi();
    const knowledgePath = resolveKnowledgePath();

    loadKnowledge();

    let watcher = null;
    try {
      watcher = api.fs.watch(knowledgePath, () => loadKnowledge());
    } catch (err) {
      console.warn('fs.watch failed for knowledge.md:', err.message);
    }

    return () => {
      if (watcher) {
        try { watcher.close(); } catch {}
      }
    };
  }, [loadKnowledge, resolveKnowledgePath]);

  return { knowledge, version, error, reload: loadKnowledge };
}

module.exports = { useKnowledge };