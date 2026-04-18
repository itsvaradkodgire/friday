// Live-filtered flow list with play buttons. Shows the active flow with a border
// highlight while it is running. Used in the Present tab's right panel.

const React = require('react');
const { useMemo, useState } = React;

function FlowLibrary({ flows, activeFlowId, onPlay }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flows;
    return flows.filter((f) => {
      const hay = `${f.name} ${f.description || ''} ${f.id}`.toLowerCase();
      return hay.includes(q);
    });
  }, [flows, query]);

  return (
    <div className="flow-library">
      <input
        className="flow-search"
        type="text"
        placeholder="Search flows..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {flows.length === 0 && (
        <div className="empty-state">
          No flows loaded. Import flows in the Flows tab.
        </div>
      )}

      {flows.length > 0 && filtered.length === 0 && (
        <div className="empty-state">No flows match "{query}".</div>
      )}

      <ul className="flow-list">
        {filtered.map((flow) => {
          const active = flow.id === activeFlowId;
          return (
            <li
              key={flow.id}
              className={`flow-card${active ? ' active' : ''}`}
            >
              <div className="flow-card-main">
                <div className="flow-card-title">{flow.name}</div>
                {flow.description && (
                  <div className="flow-card-desc">{flow.description}</div>
                )}
                <div className="flow-card-meta">
                  {flow.steps.length} steps
                  {flow.created_at && (
                    <span> &middot; {new Date(flow.created_at).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <button
                className="btn-play"
                onClick={() => onPlay && onPlay(flow)}
                disabled={active}
                title={active ? 'Running' : 'Play this flow'}
              >
                {active ? '...' : 'Play'}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

module.exports = { FlowLibrary };
