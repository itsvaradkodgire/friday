// Flows tab. Shows the conversational FlowChat builder at top and a table of
// all saved flows below. Per-row actions: expand, rename, delete, test & optimize.
// Bottom: "View flows.json" button opens a read-only modal.

const React = require('react');
const { useState } = React;
const { FlowChat } = require('../components/FlowChat');

function FlowsTab({ flows, saveFlow, deleteFlow, callMCPTool }) {
  const [expandedId, setExpandedId] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showRawJson, setShowRawJson] = useState(false);
  const [editingFlow, setEditingFlow] = useState(null);

  function startRename(flow) {
    setRenamingId(flow.id);
    setRenameValue(flow.name);
  }

  function commitRename(flow) {
    const updated = { ...flow, name: renameValue };
    saveFlow(updated);
    setRenamingId(null);
    setRenameValue('');
  }

  return (
    <div className="flows-tab">
      <FlowChat onSave={saveFlow} callMCPTool={callMCPTool} flows={flows} initialFlow={editingFlow} />

      <table className="flows-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Steps</th>
            <th>Imported</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {flows.length === 0 && (
            <tr><td colSpan={4} className="empty-state">No flows yet. Use the chat above to build one.</td></tr>
          )}
          {flows.map((flow) => (
            <React.Fragment key={flow.id}>
              <tr>
                <td>
                  {renamingId === flow.id ? (
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(flow)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(flow);
                        if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                      }}
                      autoFocus
                    />
                  ) : (
                    <span>{flow.name}</span>
                  )}
                  {flow.description && (
                    <div className="flow-row-desc">{flow.description}</div>
                  )}
                  {flow.source?.includes('tested') && (
                    <div className="flow-row-desc test-badge">tested</div>
                  )}
                </td>
                <td>{flow.steps.length}</td>
                <td>{flow.created_at ? new Date(flow.created_at).toLocaleString() : '-'}</td>
                <td className="row-actions">
                  <button onClick={() => setExpandedId(expandedId === flow.id ? null : flow.id)}>
                    {expandedId === flow.id ? 'Collapse' : 'Expand'}
                  </button>
                  <button onClick={() => { setEditingFlow(flow); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Edit</button>
                  <button onClick={() => startRename(flow)}>Rename</button>
                  <button className="btn-danger" onClick={() => setConfirmDeleteId(flow.id)}>Delete</button>
                </td>
              </tr>
              {expandedId === flow.id && (
                <tr className="step-detail-row">
                  <td colSpan={4}>
                    <ol className="step-detail">
                      {flow.steps.map((s, i) => (
                        <li key={i}>
                          <code>{s.tool}</code>
                          {' '}
                          <span className="step-param">
                            {s.params.url
                              || (Array.isArray(s.params.selectors) && s.params.selectors[0])
                              || s.params.selector
                              || s.params.key
                              || s.params.text
                              || ''}
                          </span>
                          {s.narration && (
                            <div className="chat-narration">{s.narration}</div>
                          )}
                        </li>
                      ))}
                    </ol>
                  </td>
                </tr>
              )}
              {confirmDeleteId === flow.id && (
                <tr className="confirm-delete-row">
                  <td colSpan={4}>
                    Delete <strong>{flow.name}</strong>?
                    <button className="btn-danger" onClick={() => { deleteFlow(flow.id); setConfirmDeleteId(null); }}>
                      Yes, delete
                    </button>
                    <button onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>

      <footer className="flows-tab-footer">
        <button onClick={() => setShowRawJson(true)}>View flows.json</button>
      </footer>

      {showRawJson && (
        <div className="modal-backdrop" onClick={() => setShowRawJson(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>flows.json</h3>
              <button onClick={() => setShowRawJson(false)}>Close</button>
            </header>
            <pre className="raw-json">{JSON.stringify(flows, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

module.exports = { FlowsTab };
