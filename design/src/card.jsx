/* global React, Avatar, Status, Icons */
const { useMemo } = React;

function Card({ session, selected, onClick, variant, statusVariant }) {
  const { formatUptime, formatLast, formatTokens } = window.__reder;

  const top = (
    <div className="card-top">
      <Avatar session={session} variant={statusVariant} size={variant === 'compact' ? 32 : 36} />
      <div className="card-name">
        <span className="n">{session.name}</span>
        <span className="id">{session.id}</span>
      </div>
      <Status status={session.status} variant="pill" />
    </div>
  );

  if (variant === 'compact') {
    return (
      <div className={`card ${selected ? 'selected' : ''}`} onClick={onClick}>
        {top}
      </div>
    );
  }

  return (
    <div className={`card ${selected ? 'selected' : ''}`} onClick={onClick}>
      {top}
      <div className="card-preview">
        <span className="pfx">
          {session.status === 'offline' ? '✕' : session.status === 'me' ? '›' : '›'}
        </span>
        {session.task}
      </div>

      {session.status === 'busy' && <div className="scanbar" />}

      <div className="card-meta">
        <div>
          <span className="k">Uptime</span>
          <span className="v">
            {session.status === 'offline' ? '—' : formatUptime(session.uptime)}
          </span>
        </div>
        <div>
          <span className="k">Last</span>
          <span className="v">
            {session.status === 'busy' ? 'now' : formatLast(session.lastMin)}
          </span>
        </div>
        <div>
          <span className="k">Tokens</span>
          <span className="v">{formatTokens(session.tokens)}</span>
        </div>
        {variant === 'panel' && (
          <div>
            <span className="k">Cost</span>
            <span className="v">${session.cost.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

window.Card = Card;
