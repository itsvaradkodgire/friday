// Imports a Chrome DevTools Recorder JSON file and runs it through the AI flow
// improver, which both CLEANS the recorder artifacts (merges keypresses,
// drops setViewport, etc.) AND generates a narration for each step. Falls back
// to the mechanical convertDevToolsFlow if the improver fails for any reason.

const React = require('react');
const { useState, useRef } = React;
const { improveFlow, mechanicalFallback } = require('../utils/flowImprover');

const VERBOSITY_OPTIONS = [
  { value: 'brief', label: 'Brief - one short sentence per step' },
  { value: 'normal', label: 'Normal - 1-2 sentences per step' },
  { value: 'detailed', label: 'Detailed - 2-3 sentences with context' }
];

function FlowImporter({ onSave }) {
  const fileInputRef = useRef(null);
  const [previewFlow, setPreviewFlow] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editNarrations, setEditNarrations] = useState([]);
  const [verbosity, setVerbosity] = useState('normal');
  const [improving, setImproving] = useState(false);
  const [improverWarning, setImproverWarning] = useState(null);
  const [error, setError] = useState(null);

  function getApiKey() {
    return (
      (typeof window !== 'undefined' && window.appEnv && window.appEnv.GEMINI_API_KEY) || ''
    );
  }

  function openPicker() {
    setError(null);
    setImproverWarning(null);
    fileInputRef.current?.click();
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      let json;
      try {
        json = JSON.parse(ev.target.result);
      } catch (err) {
        setError(`Failed to parse file: ${err.message}`);
        return;
      }
      if (!json.title || !Array.isArray(json.steps)) {
        setError('Invalid Recorder export: missing title or steps');
        return;
      }

      setError(null);
      setImproverWarning(null);
      setImproving(true);

      const apiKey = getApiKey();
      let flow = null;

      // Phase 1: try the AI improver. Clean steps + narrations + verbosity baked in.
      try {
        flow = await improveFlow(json, verbosity, apiKey);
      } catch (improverErr) {
        console.warn('AI improver failed, falling back to mechanical:', improverErr.message);
        // Phase 2: mechanical fallback. Same pre-pass cleanup but no narrations.
        try {
          flow = mechanicalFallback(json, verbosity);
          setImproverWarning(
            `AI improver failed (${improverErr.message}). Saved without narrations - the flow will play silently.`
          );
        } catch (mechErr) {
          setError(`Failed to import flow: ${mechErr.message}`);
          setImproving(false);
          return;
        }
      }

      setPreviewFlow(flow);
      setEditName(flow.name);
      setEditDescription(flow.description || '');
      setEditNarrations(flow.steps.map((s) => s.narration || ''));
      setImproving(false);
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setImproving(false);
    };
    reader.readAsText(file);
  }

  function handleSave() {
    if (!previewFlow) return;
    const finalId = editName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Re-attach edited narrations to their steps. Length is guaranteed equal
    // since editNarrations was initialized from previewFlow.steps.
    const stepsWithEdits = previewFlow.steps.map((s, i) => ({
      ...s,
      narration: editNarrations[i] || s.narration || ''
    }));
    const final = {
      ...previewFlow,
      id: finalId || previewFlow.id,
      name: editName,
      description: editDescription,
      verbosity,
      steps: stepsWithEdits
    };
    try {
      onSave(final);
    } catch (err) {
      setError(`Failed to save flow: ${err.message}`);
      return;
    }
    setError(null);
    setImproverWarning(null);
    setPreviewFlow(null);
    setEditName('');
    setEditDescription('');
    setEditNarrations([]);
  }

  function handleCancel() {
    setPreviewFlow(null);
    setEditName('');
    setEditDescription('');
    setEditNarrations([]);
    setError(null);
    setImproverWarning(null);
  }

  function updateNarration(index, value) {
    setEditNarrations((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  return (
    <div className="flow-importer">
      <div className="importer-controls">
        <label className="verbosity-select">
          <span>Detail level</span>
          <select
            value={verbosity}
            onChange={(e) => setVerbosity(e.target.value)}
            disabled={improving || !!previewFlow}
          >
            {VERBOSITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button
          className="btn-primary"
          onClick={openPicker}
          disabled={improving || !!previewFlow}
        >
          Import Flow
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {improving && (
        <div className="import-progress">
          <span className="spinner" /> Cleaning up and narrating the flow with AI... this can take 10-20 seconds.
        </div>
      )}

      {error && <div className="import-error">{error}</div>}
      {improverWarning && <div className="import-warning">{improverWarning}</div>}

      {previewFlow && (
        <div className="import-preview">
          <h3>Preview Imported Flow</h3>

          <label>
            <span>Name</span>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </label>

          <label>
            <span>Description</span>
            <textarea
              rows={2}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="What does this flow show? Used by the AI to find the right flow."
            />
          </label>

          <div className="step-summary">
            <strong>{previewFlow.steps.length} steps</strong>
            {previewFlow.source === 'devtools-recorder+ai' && (
              <span className="step-summary-source"> &middot; AI improved &middot; {verbosity}</span>
            )}
            <ol>
              {previewFlow.steps.map((s, i) => (
                <li key={i}>
                  <div className="step-line">
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
                  </div>
                  <textarea
                    className="step-narration-edit"
                    rows={2}
                    placeholder="(no narration - flow will play silently)"
                    value={editNarrations[i] || ''}
                    onChange={(e) => updateNarration(i, e.target.value)}
                  />
                </li>
              ))}
            </ol>
          </div>

          <div className="preview-actions">
            <button className="btn-primary" onClick={handleSave}>Save Flow</button>
            <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

module.exports = { FlowImporter };
