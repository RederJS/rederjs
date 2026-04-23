/* global React */
// Status indicator — renders differently based on variant

function Status({ status, variant = 'ringed', size = 'md' }) {
  // shared pill
  const pill = (
    <span className="spill" data-s={status}>
      <span className="d" />
      {status}
    </span>
  );

  if (variant === 'pill') return pill;

  if (variant === 'bar') {
    return (
      <div className="status-bar" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="spill" data-s={status}>
          <span className="d" />
          {status}
        </span>
        {status === 'busy' && <div className="scanbar" style={{ flex: 1 }} />}
        {status === 'waiting' && (
          <div className="waveform">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    );
  }

  // ringed (default) returns null here — ring is applied on avatar wrapper via data-status
  return pill;
}

function Avatar({ session, status, variant = 'ringed', size = 36 }) {
  const s = size;
  const st = status || session.status;
  return (
    <div className="avatar-wrap" data-status={st}>
      <div
        className="avatar"
        style={{
          width: s,
          height: s,
          background: session.color,
          fontSize: s <= 28 ? 10 : s <= 36 ? 13 : 15,
        }}
      >
        {session.initials}
      </div>
      {variant === 'ringed' && <div className="status-ring" />}
      {variant === 'corner' && (
        <div
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: `var(--st-${st})`,
            boxShadow: `0 0 0 2px var(--bg-1), 0 0 6px var(--st-${st})`,
            animation:
              st === 'waiting'
                ? 'dot-blink 1.2s infinite'
                : st === 'busy'
                  ? 'dot-blink .6s infinite'
                  : 'none',
          }}
        />
      )}
    </div>
  );
}

window.Status = Status;
window.Avatar = Avatar;
