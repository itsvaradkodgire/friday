// Modal for creating / editing a KB section.
// Props: section (null = new), flows (for linking), onSave, onCancel

const React = require('react');
const { useState, useEffect } = React;

function SectionEditor({ section, flows, onSave, onCancel }) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [content, setContent] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [linkedFlowIds, setLinkedFlowIds] = useState([]);

  useEffect(() => {
    if (section) {
      setTitle(section.title || '');
      setSummary(section.summary || '');
      setContent(section.content || '');
      setTagsInput((section.tags || []).join(', '));
      setLinkedFlowIds(section.flowIds || []);
    } else {
      setTitle('');
      setSummary('');
      setContent('');
      setTagsInput('');
      setLinkedFlowIds([]);
    }
  }, [section]);

  function handleSave() {
    if (!title.trim()) return;
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const id = section?.id || title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    onSave({
      id,
      title: title.trim(),
      summary: summary.trim(),
      content: content.trim(),
      tags,
      flowIds: linkedFlowIds
    });
  }

  function toggleFlow(flowId) {
    setLinkedFlowIds((prev) =>
      prev.includes(flowId) ? prev.filter((id) => id !== flowId) : [...prev, flowId]
    );
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal section-editor" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{section ? 'Edit Section' : 'New Section'}</h3>
          <button onClick={onCancel}>Close</button>
        </header>

        <div className="editor-body">
          <label>
            Title
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. WhatsApp Workflow"
              autoFocus
            />
          </label>

          <label>
            Summary <span className="hint">(one-liner for Basanti's topic index)</span>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. Employees submit expenses via WhatsApp photo"
            />
          </label>

          <label>
            Content <span className="hint">(full knowledge Basanti will use when relevant)</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              placeholder="Write product knowledge here. Basanti will use this naturally during narration — not read it verbatim."
            />
          </label>

          <label>
            Tags <span className="hint">(comma-separated keywords for matching)</span>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. whatsapp, receipt, mobile, ocr"
            />
          </label>

          {tagsInput.trim() && (
            <div className="tag-chips">
              {tagsInput.split(',').map((t) => t.trim()).filter(Boolean).map((tag, i) => (
                <span key={i} className="tag-chip">{tag}</span>
              ))}
            </div>
          )}

          <div className="flow-linker">
            <span className="flow-linker-label">Link to flows</span>
            <span className="hint">When these flows run, Basanti gets this section as context</span>
            {(!flows || flows.length === 0) && (
              <div className="empty-state">No flows available</div>
            )}
            {(flows || []).map((flow) => (
              <label key={flow.id} className="flow-check">
                <input
                  type="checkbox"
                  checked={linkedFlowIds.includes(flow.id)}
                  onChange={() => toggleFlow(flow.id)}
                />
                {flow.name}
              </label>
            ))}
          </div>
        </div>

        <footer className="editor-footer">
          <button className="btn-primary" onClick={handleSave} disabled={!title.trim()}>
            Save
          </button>
          <button onClick={onCancel}>Cancel</button>
        </footer>
      </div>
    </div>
  );
}

module.exports = { SectionEditor };
