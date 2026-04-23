/* global React, ReactDOM, Icons, Card, Panel, Tweaks */
const { useState, useEffect, useMemo, useCallback } = React;

const STATUS_ORDER = { waiting: 0, idle: 1, busy: 2, offline: 3 };
const STATUS_COLORS = {
  waiting: 'var(--st-waiting)',
  busy: 'var(--st-busy)',
  idle: 'var(--st-idle)',
  offline: 'var(--st-offline)',
};

function persistTweaks(edits) {
  try {
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*');
  } catch {}
}

function App() {
  const [sessions] = useState(() => window.__reder.makeSessions());
  const [selectedId, setSelectedId] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState('priority'); // priority | name | recent
  const [search, setSearch] = useState('');
  const [tweaksOpen, setTweaksOpen] = useState(false);

  const [tweaks, setTweaksState] = useState(() => ({ ...window.TWEAKS }));

  // edit-mode protocol
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === '__activate_edit_mode') setTweaksOpen(true);
      if (d.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    try {
      window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    } catch {}
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const setTweaks = useCallback((next) => {
    setTweaksState(next);
    // persist only the keys that live in TWEAK block
    const {
      theme,
      accent,
      cardVariant,
      statusVariant,
      bubbleVariant,
      composerVariant,
      panelVariant,
      gridDensity,
    } = next;
    persistTweaks({
      theme,
      accent,
      cardVariant,
      statusVariant,
      bubbleVariant,
      composerVariant,
      panelVariant,
      gridDensity,
    });
  }, []);

  // apply theme + accent to :root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
    document.documentElement.style.setProperty('--accent', tweaks.accent);
  }, [tweaks.theme, tweaks.accent]);

  const filtered = useMemo(() => {
    let list = sessions;
    if (statusFilter !== 'all') list = list.filter((s) => s.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.includes(q) || s.id.toLowerCase().includes(q) || s.task.toLowerCase().includes(q),
      );
    }
    if (sort === 'priority') {
      list = [...list].sort((a, b) => {
        const d = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (d !== 0) return d;
        return a.name.localeCompare(b.name);
      });
    } else if (sort === 'name') {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'recent') {
      list = [...list].sort((a, b) => a.lastMin - b.lastMin);
    }
    return list;
  }, [sessions, statusFilter, search, sort]);

  const selected = sessions.find((s) => s.id === selectedId);

  const counts = useMemo(() => {
    const c = { all: sessions.length, waiting: 0, busy: 0, idle: 0, offline: 0 };
    sessions.forEach((s) => c[s.status]++);
    return c;
  }, [sessions]);

  const contentClass = `content ${selected ? 'open' : ''} p-${tweaks.panelVariant}`;

  return (
    <div className="app">
      {/* left rail */}
      <aside className="rail">
        <div className="mark">R</div>
        <button className="rail-btn active" title="Sessions">
          <Icons.grid size={18} />
        </button>
        <button className="rail-btn" title="Terminal">
          <Icons.terminal size={18} />
        </button>
        <button className="rail-btn" title="CPU / Usage">
          <Icons.cpu size={18} />
        </button>
        <button className="rail-btn" title="Notifications">
          <Icons.bell size={18} />
        </button>
        <div className="spacer" />
        <button
          className="rail-btn"
          title={tweaks.theme === 'dark' ? 'Light mode' : 'Dark mode'}
          onClick={() =>
            setTweaks({ ...tweaks, theme: tweaks.theme === 'dark' ? 'light' : 'dark' })
          }
        >
          {tweaks.theme === 'dark' ? <Icons.sun size={18} /> : <Icons.moon size={18} />}
        </button>
        <button className="rail-btn" title="Tweaks" onClick={() => setTweaksOpen(!tweaksOpen)}>
          <Icons.settings size={18} />
        </button>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="wordmark">
            reder
            <span className="caret" />
          </div>
          <div className="breadcrumb">
            <span className="dot" />
            <span>
              <span className="k">host</span> <span className="v">vps-nyc-03.reder.dev</span>
            </span>
            <span className="k">·</span>
            <span>
              <span className="k">sessions</span> <span className="v">{counts.all}</span>
            </span>
            <span className="k">·</span>
            <span>
              <span className="k">waiting</span>{' '}
              <span className="v" style={{ color: 'var(--st-waiting)' }}>
                {counts.waiting}
              </span>
            </span>
          </div>
          <div className="grow" />
          <div className="search">
            <Icons.search size={13} />
            <input
              placeholder="search sessions…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <kbd>⌘K</kbd>
          </div>
          <button className="icon-btn" title="New session">
            <Icons.plus size={16} />
          </button>
        </div>

        <div className={contentClass}>
          <div className="grid-wrap">
            <div className="grid-head">
              <div className="count">
                {filtered.length} <em>/ {sessions.length} sessions</em>
              </div>
              <div className="sep" />
              <div className="chips">
                <button
                  className={`chip ${statusFilter === 'all' ? 'on' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  all{' '}
                  <span className="mono" style={{ color: 'var(--fg-4)' }}>
                    {counts.all}
                  </span>
                </button>
                {['waiting', 'busy', 'idle', 'offline'].map((s) => (
                  <button
                    key={s}
                    className={`chip ${statusFilter === s ? 'on' : ''}`}
                    onClick={() => setStatusFilter(s)}
                  >
                    <span className="swatch" style={{ background: `var(--st-${s})` }} /> {s}{' '}
                    <span className="mono" style={{ color: 'var(--fg-4)' }}>
                      {counts[s]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="grow" />
              <div className="cols-slider" title="Columns">
                <Icons.grid size={12} />
                <input
                  type="range"
                  min="2"
                  max="8"
                  step="1"
                  value={tweaks.gridDensity}
                  onChange={(e) => setTweaks({ ...tweaks, gridDensity: parseInt(e.target.value) })}
                />
                <span className="cols-val mono">{tweaks.gridDensity}</span>
              </div>
              <div className="sort">
                <button
                  className={sort === 'priority' ? 'on' : ''}
                  onClick={() => setSort('priority')}
                >
                  priority
                </button>
                <button className={sort === 'recent' ? 'on' : ''} onClick={() => setSort('recent')}>
                  recent
                </button>
                <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>
                  name
                </button>
              </div>
            </div>

            <div
              className={`sessions v-${tweaks.cardVariant}`}
              style={{
                '--cols':
                  tweaks.cardVariant === 'compact'
                    ? Math.max(2, Math.floor(tweaks.gridDensity * 0.7))
                    : tweaks.gridDensity,
              }}
            >
              {filtered.map((s) => (
                <Card
                  key={s.id}
                  session={s}
                  selected={selectedId === s.id}
                  onClick={() => setSelectedId(s.id === selectedId ? null : s.id)}
                  variant={tweaks.cardVariant}
                  statusVariant={tweaks.statusVariant}
                />
              ))}
              {filtered.length === 0 && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    padding: 80,
                    textAlign: 'center',
                    color: 'var(--fg-4)',
                    fontFamily: "'JetBrains Mono'",
                    fontSize: 12,
                  }}
                >
                  no sessions match the current filter.
                </div>
              )}
            </div>
          </div>

          {selected && (
            <Panel
              key={selected.id}
              session={selected}
              onClose={() => setSelectedId(null)}
              bubbleVariant={tweaks.bubbleVariant}
              composerVariant={tweaks.composerVariant}
              panelVariant={tweaks.panelVariant}
            />
          )}
        </div>
      </main>

      <Tweaks
        open={tweaksOpen}
        onClose={() => setTweaksOpen(false)}
        state={tweaks}
        setState={setTweaks}
      />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
