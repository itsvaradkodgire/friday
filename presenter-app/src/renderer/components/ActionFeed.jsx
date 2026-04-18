// Scrolling action log. 20 entries max, newest at bottom. Color coded:
// green for success, red for failure, blue for system events.

const React = require('react');
const { useEffect, useRef } = React;

function fmtTime(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function classifyEntry(entry) {
  if (entry.event) return 'system';
  if (entry.status === 'failed') return 'failed';
  if (entry.status === 'ok') return 'ok';
  return 'system';
}

function renderEntry(entry) {
  if (entry.event === 'flow_started') return `FLOW STARTED: ${entry.flowId}`;
  if (entry.event === 'flow_completed') return `FLOW COMPLETED: ${entry.flowId}`;
  if (entry.event === 'flow_failed') return `FLOW FAILED: ${entry.flowId}${entry.error ? ' - ' + entry.error : ''}`;
  if (entry.event === 'flow_cancelled') return `FLOW CANCELLED: ${entry.flowId}`;
  if (entry.event === 'mode_change') {
    return entry.from ? `MODE: ${entry.from} -> ${entry.mode}` : `MODE: ${entry.mode}`;
  }
  if (entry.event === 'session_reconnecting') {
    return `SESSION RECONNECTING${entry.reason ? ' (' + entry.reason + ' changed)' : ''}`;
  }
  if (entry.event === 'session_reconnected') return 'SESSION RECONNECTED';
  if (entry.event === 'transcript') {
    return `${entry.who === 'gemini' ? 'AI' : 'YOU'}: ${entry.text}`;
  }
  if (entry.tool) {
    const p = entry.params || {};
    const param = p.url
      || (Array.isArray(p.selectors) && p.selectors[0])
      || p.selector
      || p.key
      || '';
    const sym = entry.status === 'ok' ? 'OK' : entry.status === 'failed' ? 'FAILED' : '';
    return `${entry.tool}  ${param ? '-> ' + param + '  ' : ''}${sym}`;
  }
  return JSON.stringify(entry);
}

function ActionFeed({ entries }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries]);

  const last20 = entries.slice(-20);

  return (
    <div className="action-feed" ref={ref}>
      {last20.length === 0 && (
        <div className="action-feed-empty">No activity yet.</div>
      )}
      {last20.map((entry, i) => {
        const kind = classifyEntry(entry);
        return (
          <div key={i} className={`action-row action-${kind}`}>
            <span className="action-time">{fmtTime(entry.t || Date.now())}</span>
            <span className="action-text">{renderEntry(entry)}</span>
          </div>
        );
      })}
    </div>
  );
}

module.exports = { ActionFeed };
