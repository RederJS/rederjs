/* global React, Avatar, Icons, Markdown, Composer */
const { useState, useEffect, useMemo, useRef } = React;

function QuickReplies({ buttons, answered, onPick }) {
  if (!buttons || !buttons.length) return null;

  if (answered) {
    return (
      <div className="quick-replies answered">
        <span className="mono">↳ replied · </span>
        <b>{answered.label}</b>
      </div>
    );
  }

  return (
    <div className="quick-replies">
      {buttons.map((b, i) => (
        <button key={i} className={`qbtn ${b.kind || 'default'}`} onClick={() => onPick(b)}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

function Panel({ session, onClose, bubbleVariant, composerVariant, panelVariant }) {
  const { buildStream, formatUptime, formatTokens } = window.__reder;
  const [stream, setStream] = useState(() => buildStream(session));
  const [answered, setAnswered] = useState({}); // { [messageId]: button }
  const streamRef = useRef();

  useEffect(() => {
    setStream(buildStream(session));
    setAnswered({});
  }, [session.id]);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [stream.length, session.id]);

  const sendMsg = ({ text, attach }) => {
    const now = window.__reder.fmtTime(0);
    const newMsg = {
      id: `m-${Date.now()}`,
      who: 'me',
      t: 0,
      md: attach.length ? `${text}\n\n${attach.map((a) => `📎 \`${a}\``).join('\n')}` : text,
      time: now,
    };
    setStream((s) => [...s, newMsg]);
    setTimeout(() => {
      setStream((s) => [
        ...s,
        {
          id: `m-${Date.now()}-r`,
          who: 'them',
          t: 0,
          md: 'Acknowledged. Working on it now…',
          time: window.__reder.fmtTime(0),
        },
      ]);
    }, 900);
  };

  const pickReply = (msg, btn) => {
    setAnswered((a) => ({ ...a, [msg.id]: btn }));
    sendMsg({ text: btn.value, attach: [] });
  };

  const streamItems = useMemo(() => {
    const items = [];
    items.push({ kind: 'day-sep', label: 'Today' });
    stream.forEach((m) => items.push({ kind: 'msg', m }));
    return items;
  }, [stream]);

  // Find the latest unanswered buttoned message — only it stays active.
  const latestActiveId = useMemo(() => {
    for (let i = stream.length - 1; i >= 0; i--) {
      const m = stream[i];
      if (m.buttons && !answered[m.id]) return m.id;
    }
    return null;
  }, [stream, answered]);

  return (
    <div className="panel">
      <div className="panel-head">
        <Avatar session={session} variant="ringed" size={40} />
        <div className="meta">
          <div className="n">{session.name}</div>
          <div className="sub">
            <span>
              id <b>{session.id}</b>
            </span>
            <span>•</span>
            <span>
              <Icons.folder size={11} /> <b>{session.dir}</b>
            </span>
          </div>
        </div>
        <div className="actions">
          <button className="icon-btn" title="Pin">
            <Icons.pin size={15} />
          </button>
          <button className="icon-btn" title="Settings">
            <Icons.settings size={15} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <Icons.close size={15} />
          </button>
        </div>
      </div>

      <div ref={streamRef} className={`stream b-${bubbleVariant}`}>
        {streamItems.map((it, i) => {
          if (it.kind === 'day-sep')
            return (
              <div key={i} className="day-sep">
                {it.label}
              </div>
            );
          const m = it.m;
          const isActive = m.id === latestActiveId;
          const ans = answered[m.id];
          return (
            <div key={m.id} className={`msg ${m.who === 'me' ? 'me' : 'them'}`}>
              <div className="who">
                <b>{m.who === 'me' ? 'you' : session.name}</b>
                <span>{m.time}</span>
              </div>
              <div className="bubble">
                <Markdown src={m.md} />
              </div>
              {m.buttons && (
                <QuickReplies
                  buttons={isActive ? m.buttons : null}
                  answered={!isActive ? ans || { label: 'superseded' } : null}
                  onPick={(b) => pickReply(m, b)}
                />
              )}
            </div>
          );
        })}

        {session.status === 'busy' && (
          <div className="activity-line mono">
            session is currently running — messages queue until the next checkpoint
          </div>
        )}
      </div>

      <Composer variant={composerVariant} onSend={sendMsg} />
    </div>
  );
}

window.Panel = Panel;
