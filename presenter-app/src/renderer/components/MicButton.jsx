// Hold-to-speak microphone button. Mode-aware: only active when appMode === 'IDLE'.
// Spacebar shortcut is handled globally inside useGeminiSession.

const React = require('react');

function MicButton({ appMode, onStart, onStop, disabled }) {
  const handleDown = (e) => {
    e.preventDefault();
    if (disabled) return;
    if (appMode !== 'IDLE') return;
    onStart && onStart();
  };

  const handleUp = (e) => {
    e.preventDefault();
    if (appMode !== 'LISTENING') return;
    onStop && onStop();
  };

  let label;
  if (disabled) label = 'Connecting...';
  else if (appMode === 'LISTENING') label = 'Listening';
  else if (appMode === 'PRESENTING') label = 'Presenting';
  else if (appMode === 'MANUAL') label = 'Manual';
  else label = 'Hold to speak';

  const className = [
    'mic-button',
    `mic-${appMode.toLowerCase()}`,
    disabled ? 'mic-disabled' : ''
  ].join(' ');

  return (
    <div className="mic-button-wrap">
      <button
        type="button"
        className={className}
        disabled={disabled || appMode === 'PRESENTING' || appMode === 'MANUAL'}
        onMouseDown={handleDown}
        onMouseUp={handleUp}
        onMouseLeave={handleUp}
        onTouchStart={handleDown}
        onTouchEnd={handleUp}
        aria-label="Push to talk"
      >
        <span className="mic-icon">{appMode === 'LISTENING' ? 'M' : 'm'}</span>
      </button>
      <div className="mic-label">{label}</div>
      <div className="mic-hint">Hold or press Space</div>
    </div>
  );
}

module.exports = { MicButton };
