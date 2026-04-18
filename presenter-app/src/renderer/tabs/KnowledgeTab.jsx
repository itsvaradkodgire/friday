// Knowledge Base tab. Table of KB sections with add/edit/delete + raw JSON viewer.

const React = require('react');
const { useState } = React;
const { SectionEditor } = require('../components/SectionEditor');

function KnowledgeTab({ sections, flows, saveSection, deleteSection }) {
  const [expandedId, setExpandedId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [editorSection, setEditorSection] = useState(undefined); // undefined=closed, null=new, object=edit
  const [showRawJson, setShowRawJson] = useState(false);

  function flowNamesForSection(sec) {
    if (!sec.flowIds || sec.flowIds.length === 0) return '-';
    return sec.flowIds
      .map((fid) => {
        const flow = (flows || []).find((f) => f.id === fid);
        return flow ? flow.name : fid;
      })
      .join(', ');
  }

  return (
    <div className="kb-tab">
      <div className="kb-header">
        <h3>Knowledge Base</h3>
        <button className="btn-primary" onClick={() => setEditorSection(null)}>
          + New Section
        </button>
      </div>

      <table className="kb-table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Tags</th>
            <th>Linked Flows</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sections.length === 0 && (
            <tr>
              <td colSpan={4} className="empty-state">
                No knowledge sections yet. Add one to give Basanti product knowledge.
              </td>
            </tr>
          )}
          {sections.map((sec) => (
            <React.Fragment key={sec.id}>
              <tr>
                <td>
                  <span className="section-title">{sec.title}</span>
                  {sec.summary && (
                    <div className="section-summary">{sec.summary}</div>
                  )}
                </td>
                <td>
                  <div className="tag-chips">
                    {(sec.tags || []).map((tag, i) => (
                      <span key={i} className="tag-chip">{tag}</span>
                    ))}
                  </div>
                </td>
                <td className="linked-flows-cell">{flowNamesForSection(sec)}</td>
                <td className="row-actions">
                  <button onClick={() => setExpandedId(expandedId === sec.id ? null : sec.id)}>
                    {expandedId === sec.id ? 'Collapse' : 'Expand'}
                  </button>
                  <button onClick={() => setEditorSection(sec)}>Edit</button>
                  <button className="btn-danger" onClick={() => setConfirmDeleteId(sec.id)}>
                    Delete
                  </button>
                </td>
              </tr>
              {expandedId === sec.id && (
                <tr className="section-detail-row">
                  <td colSpan={4}>
                    <pre className="section-content">{sec.content || '(no content)'}</pre>
                  </td>
                </tr>
              )}
              {confirmDeleteId === sec.id && (
                <tr className="confirm-delete-row">
                  <td colSpan={4}>
                    Delete <strong>{sec.title}</strong>?
                    <button
                      className="btn-danger"
                      onClick={() => { deleteSection(sec.id); setConfirmDeleteId(null); }}
                    >
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

      <footer className="kb-tab-footer">
        <button onClick={() => setShowRawJson(true)}>View sections.json</button>
      </footer>

      {showRawJson && (
        <div className="modal-backdrop" onClick={() => setShowRawJson(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <h3>sections.json</h3>
              <button onClick={() => setShowRawJson(false)}>Close</button>
            </header>
            <pre className="raw-json">{JSON.stringify(sections, null, 2)}</pre>
          </div>
        </div>
      )}

      {editorSection !== undefined && (
        <SectionEditor
          section={editorSection}
          flows={flows}
          onSave={(sec) => {
            saveSection(sec);
            setEditorSection(undefined);
          }}
          onCancel={() => setEditorSection(undefined)}
        />
      )}
    </div>
  );
}

module.exports = { KnowledgeTab };
