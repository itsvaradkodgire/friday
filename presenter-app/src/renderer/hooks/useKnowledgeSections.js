// Loads knowledge/sections.json, watches for changes, exposes CRUD + search index.
// Same pattern as useFlows.js. Each section has:
//   { id, title, tags[], flowIds[], summary, content, createdAt, updatedAt }

const { useEffect, useRef, useState, useCallback } = require('react');
const { buildSearchIndex } = require('../utils/buildSearchIndex');

function getNodeApi() {
  if (typeof window !== 'undefined' && window.nodeApi) return window.nodeApi;
  return { fs: require('fs'), path: require('path'), dirname: __dirname };
}

function useKnowledgeSections() {
  const [sections, setSections] = useState([]);
  const [searchIndex, setSearchIndex] = useState(new Map());
  const [version, setVersion] = useState(0);
  const [error, setError] = useState(null);
  const pathRef = useRef(null);

  const resolvePath = useCallback(() => {
    if (!pathRef.current) {
      const api = getNodeApi();
      pathRef.current = api.path.resolve(api.dirname, '../../knowledge/sections.json');
    }
    return pathRef.current;
  }, []);

  const load = useCallback(() => {
    const api = getNodeApi();
    const p = resolvePath();
    try {
      const raw = api.fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [];
      setSections(arr);
      // Build search index over title + tags + summary for keyword matching.
      const indexable = arr.map((s) => ({
        id: s.id,
        name: s.title || '',
        description: [s.summary || '', ...(s.tags || [])].join(' ')
      }));
      setSearchIndex(buildSearchIndex(indexable));
      setVersion((v) => v + 1);
      setError(null);
    } catch (err) {
      console.error('Failed to load sections.json:', err.message);
      setSections([]);
      setError(err.message);
      setVersion((v) => v + 1);
    }
  }, [resolvePath]);

  useEffect(() => {
    load();
    let watcher = null;
    try {
      const api = getNodeApi();
      watcher = api.fs.watch(resolvePath(), () => load());
    } catch (err) {
      console.warn('fs.watch failed for sections.json:', err.message);
    }
    return () => { if (watcher) try { watcher.close(); } catch {} };
  }, [load, resolvePath]);

  const _write = useCallback((updated) => {
    const api = getNodeApi();
    api.fs.writeFileSync(resolvePath(), JSON.stringify(updated, null, 2), 'utf8');
  }, [resolvePath]);

  const saveSection = useCallback((section) => {
    const now = new Date().toISOString();
    const existing = sections.find((s) => s.id === section.id);
    const entry = existing
      ? { ...existing, ...section, updatedAt: now }
      : { ...section, id: section.id || `kb_${Date.now()}`, createdAt: now, updatedAt: now };
    const updated = [...sections.filter((s) => s.id !== entry.id), entry];
    _write(updated);
  }, [sections, _write]);

  const deleteSection = useCallback((id) => {
    _write(sections.filter((s) => s.id !== id));
  }, [sections, _write]);

  return { sections, searchIndex, version, saveSection, deleteSection, error, reload: load };
}

module.exports = { useKnowledgeSections };
