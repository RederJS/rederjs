/* global React, Icons */
const { useState, useRef, useEffect, useCallback } = React;

// mock transcription phrases for the speaking-mode demo
const MOCK_PHRASES = [
  'run the full test suite against the staging database',
  'merge the auth refactor branch once the checks pass',
  'take a snapshot of production before you start the migration',
  'pull the latest from main and rebuild the search index',
  'show me the last ten commits that touched the billing module',
  "can you summarize what you've changed so far",
  "stop what you're doing and wait for me",
];

// Live waveform in the send slot while speaking
function LiveWave({ active }) {
  return (
    <span className="live-wave" aria-hidden={!active}>
      {Array.from({ length: 7 }).map((_, i) => (
        <span key={i} style={{ animationDelay: `${i * 80}ms` }} />
      ))}
    </span>
  );
}

function Composer({ variant = 'rail', onSend }) {
  const [text, setText] = useState('');
  const [attach, setAttach] = useState([]);
  const [speaking, setSpeaking] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const taRef = useRef();

  // speaking-session internals
  const typingRef = useRef(null); // interval typing words
  const silenceRef = useRef(null); // timeout for auto-submit after silence
  const phraseIdxRef = useRef(0);

  // autosize
  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = 'auto';
    taRef.current.style.height = Math.min(taRef.current.scrollHeight, 160) + 'px';
  }, [text]);

  const clearTimers = () => {
    if (typingRef.current) {
      clearInterval(typingRef.current);
      typingRef.current = null;
    }
    if (silenceRef.current) {
      clearTimeout(silenceRef.current);
      silenceRef.current = null;
    }
  };

  const send = useCallback(
    (override) => {
      const payload = override ?? text;
      if (!payload.trim() && !attach.length) return;
      onSend({ text: payload.trim(), attach });
      setText('');
      setAttach([]);
    },
    [text, attach, onSend],
  );

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (speaking && e.key === 'Escape') {
      e.preventDefault();
      stopSpeaking();
    }
  };

  const fakeAttach = () => {
    const samples = ['screenshot.png', 'trace.log', 'patch.diff', 'queries.sql', 'notes.md'];
    setAttach((a) => [...a, samples[Math.floor(Math.random() * samples.length)]]);
  };

  // ---- speaking mode ----
  const speakOne = useCallback(() => {
    // type one mock phrase into the textarea, appending to whatever's there.
    const phrase = MOCK_PHRASES[phraseIdxRef.current % MOCK_PHRASES.length];
    phraseIdxRef.current += 1;
    const words = phrase.split(' ');
    let i = 0;

    setPendingSubmit(false);
    if (silenceRef.current) {
      clearTimeout(silenceRef.current);
      silenceRef.current = null;
    }

    // prefix with any existing trailing text (add space if needed)
    const baseText = () => {
      const cur = taRef.current ? taRef.current.value : text;
      if (!cur) return '';
      return /[.!?…]\s*$/.test(cur) ? cur + ' ' : cur + ' ';
    };
    const base = baseText();

    typingRef.current = setInterval(() => {
      if (i >= words.length) {
        clearInterval(typingRef.current);
        typingRef.current = null;
        // silence detected → schedule auto-submit; keep listening after
        setPendingSubmit(true);
        silenceRef.current = setTimeout(() => {
          setPendingSubmit(false);
          // snapshot current text and submit
          setText((curText) => {
            const toSend = curText.trim();
            if (toSend) {
              onSend({ text: toSend, attach });
              setAttach([]);
            }
            return '';
          });
          // remain in speaking mode — queue next phrase after a beat
          silenceRef.current = setTimeout(() => {
            if (speakingRef.current) speakOne();
          }, 1800);
        }, 1200);
        return;
      }
      const next = base + words.slice(0, i + 1).join(' ');
      setText(next);
      i++;
    }, 220);
  }, [text, attach, onSend]);

  // track speaking in a ref so timers can see latest value
  const speakingRef = useRef(false);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

  const startSpeaking = () => {
    setSpeaking(true);
    // begin first phrase shortly
    silenceRef.current = setTimeout(() => {
      if (speakingRef.current) speakOne();
    }, 500);
  };

  const stopSpeaking = () => {
    speakingRef.current = false;
    setSpeaking(false);
    setPendingSubmit(false);
    clearTimers();
  };

  useEffect(() => () => clearTimers(), []);

  // Common rendering bits --------

  const attachStrip = attach.length > 0 && (
    <div className="attach-strip">
      {attach.map((a, i) => (
        <span key={i} className="attach">
          <Icons.paperclip size={12} /> {a}
          <span className="x" onClick={() => setAttach(attach.filter((_, j) => j !== i))}>
            ×
          </span>
        </span>
      ))}
    </div>
  );

  // morphing send / waveform slot
  const sendSlot = speaking ? (
    <button
      className={`send speaking ${pendingSubmit ? 'pending' : ''}`}
      onClick={stopSpeaking}
      title="Stop listening (Esc)"
    >
      <LiveWave active={!pendingSubmit} />
      <span className="lbl">{pendingSubmit ? 'sending…' : 'listening'}</span>
    </button>
  ) : (
    <button className="send" onClick={() => send()} disabled={!text.trim() && !attach.length}>
      send <Icons.send size={12} />
    </button>
  );

  const micBtn = (
    <button
      className={`ibtn ${speaking ? 'active' : ''}`}
      onClick={speaking ? stopSpeaking : startSpeaking}
      title={speaking ? 'Stop speaking' : 'Speaking mode'}
    >
      <Icons.mic size={15} />
    </button>
  );

  const attachBtn = (
    <button className="ibtn" onClick={fakeAttach} title="Attach file">
      <Icons.paperclip size={15} />
    </button>
  );

  const textareaEl = (
    <textarea
      ref={taRef}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={onKey}
      placeholder={speaking ? 'listening — speak your message…' : 'Message the session…'}
      rows={1}
      readOnly={speaking}
    />
  );

  if (variant === 'segmented') {
    return (
      <div className={`composer c-segmented ${speaking ? 'is-speaking' : ''}`}>
        {attachStrip}
        <div className="composer-box">
          {textareaEl}
          <div className="bar">
            <button className="ibtn" onClick={fakeAttach} title="Attach file">
              <Icons.paperclip size={14} /> <span>attach</span>
            </button>
            <button
              className={`ibtn ${speaking ? 'active' : ''}`}
              onClick={speaking ? stopSpeaking : startSpeaking}
              title="Speak"
            >
              <Icons.mic size={14} /> <span>{speaking ? 'stop' : 'speak'}</span>
            </button>
            <div className="spacer" />
            {sendSlot}
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'minimal') {
    return (
      <div className={`composer c-minimal ${speaking ? 'is-speaking' : ''}`}>
        {attach.length > 0 && (
          <div className="attach-strip" style={{ padding: '6px 12px 0' }}>
            {attach.map((a, i) => (
              <span key={i} className="attach">
                <Icons.paperclip size={12} /> {a}
                <span className="x" onClick={() => setAttach(attach.filter((_, j) => j !== i))}>
                  ×
                </span>
              </span>
            ))}
          </div>
        )}
        <div className="composer-box">
          <span
            style={{
              color: 'var(--accent)',
              fontFamily: "'JetBrains Mono'",
              fontSize: 13,
              marginRight: 6,
              userSelect: 'none',
            }}
          >
            $
          </span>
          {textareaEl}
          {attachBtn}
          {micBtn}
        </div>
      </div>
    );
  }

  // rail (default)
  return (
    <div className={`composer ${speaking ? 'is-speaking' : ''}`}>
      {attachStrip}
      <div className="composer-box">
        <div className="tools">
          {attachBtn}
          {micBtn}
        </div>
        {textareaEl}
        {sendSlot}
      </div>
      <div className="hint">
        {speaking ? (
          <span className="speaking-hint">
            <span className="rec-dot" /> speaking mode — auto-sends after a pause · <kbd>esc</kbd>{' '}
            to stop
          </span>
        ) : (
          <span>
            markdown supported · <kbd>⏎</kbd> to send · <kbd>⇧⏎</kbd> newline
          </span>
        )}
        <span>end-to-end via VPS</span>
      </div>
    </div>
  );
}

window.Composer = Composer;
