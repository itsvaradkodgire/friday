// Present tab. Three panels: controls (left), live feed (center), flow library (right).
// Dark themed - the audience may see this. Mode badge, session timer, manual toggle,
// MCP status, Gemini status, active flow name, progress bar, ActionFeed, FlowLibrary.

const React = require('react');
const { useEffect, useState } = React;
const { MicButton } = require('../components/MicButton');
const { ActionFeed } = require('../components/ActionFeed');
const { FlowLibrary } = require('../components/FlowLibrary');

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

const MODE_LABELS = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PRESENTING: 'PRESENTING',
  MANUAL: 'MANUAL CONTROL'
};

function PresentTab({
  appMode,
  flows,
  activeExecution,
  actionLog,
  mcp,
  gemini,
  sessionStartedAt,
  needsReconnect,
  reconnectReason,
  onReconnect,
  onStartListening,
  onStopListening,
  onToggleManual,
  onPlayFlow
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsed = sessionStartedAt ? now - sessionStartedAt : 0;

  const activeFlow = activeExecution?.flow || null;
  const progress = activeExecution?.progress || null;

  return (
    <div className="present-tab">
      {appMode === 'MANUAL' && (
        <div className="manual-banner">
          MANUAL CONTROL - Gemini is paused. Press &quot;Return Control&quot; when done.
        </div>
      )}

      {needsReconnect && appMode !== 'MANUAL' && (
        <div className="reconnect-banner">
          <span>
            {reconnectReason ? `Your ${reconnectReason} changed.` : 'Your session needs a refresh.'}{' '}
            Reconnect Gemini to apply the new context.
          </span>
          <button className="btn-primary" onClick={onReconnect}>
            Reconnect
          </button>
        </div>
      )}

      <div className="present-grid">
        {/* ----- LEFT: controls ----- */}
        <aside className="panel panel-left">
          <div className={`mode-badge mode-${appMode.toLowerCase()}`}>
            {MODE_LABELS[appMode] || appMode}
          </div>

          <MicButton
            appMode={appMode}
            onStart={onStartListening}
            onStop={onStopListening}
            disabled={gemini.status !== 'connected'}
          />

          <div className="session-timer">
            <span className="timer-label">Session</span>
            <span className="timer-value">{fmtElapsed(elapsed)}</span>
          </div>

          <button
            className={`btn-manual ${appMode === 'MANUAL' ? 'btn-resume' : ''}`}
            onClick={onToggleManual}
          >
            {appMode === 'MANUAL' ? 'Return Control' : 'Take Control'}
          </button>

          <div className="status-block">
            <div className="status-row">
              <span className={`status-dot ${mcp.connected ? 'green' : 'red'}`} />
              <span>MCP {mcp.connected ? 'connected' : 'disconnected'}</span>
            </div>
            <div className="status-url">{mcp.serverUrl}</div>
          </div>

          <div className="status-block">
            <div className="gemini-status">
              Gemini: <strong>{geminiLabel(gemini)}</strong>
            </div>
          </div>
        </aside>

        {/* ----- CENTER: live feed ----- */}
        <section className="panel panel-center">
          {activeFlow && (
            <div className="active-flow">
              <div className="active-flow-name">{activeFlow.name}</div>
              {progress && (
                <div className="progress-bar-wrap">
                  <div className="progress-bar-track">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${(progress.current / progress.total) * 100}%` }}
                    />
                  </div>
                  <div className="progress-bar-label">
                    Step {progress.current} of {progress.total}
                  </div>
                </div>
              )}
            </div>
          )}

          {!activeFlow && (
            <div className="active-flow placeholder">No flow running</div>
          )}

          <ActionFeed entries={actionLog} />
        </section>

        {/* ----- RIGHT: flow library ----- */}
        <aside className="panel panel-right">
          <h3>Flow Library</h3>
          <FlowLibrary
            flows={flows}
            activeFlowId={activeFlow?.id || null}
            onPlay={onPlayFlow}
          />
        </aside>
      </div>
    </div>
  );
}

function geminiLabel(g) {
  if (g.status === 'connecting') return 'Connecting';
  if (g.status === 'error') return 'Error';
  if (g.status !== 'connected') return 'Disconnected';
  if (g.geminiStatus === 'speaking') return 'Speaking';
  if (g.geminiStatus === 'listening') return 'Listening';
  if (g.geminiStatus === 'processing') return 'Processing';
  return 'Ready';
}

module.exports = { PresentTab };
