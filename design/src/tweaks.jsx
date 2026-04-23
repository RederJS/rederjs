/* global React, Icons */
const { useState, useEffect } = React;

const ACCENTS = [
  { name: 'blue', v: '#4f8cff' },
  { name: 'mint', v: '#5de3b1' },
  { name: 'amber', v: '#ffb347' },
  { name: 'coral', v: '#ff6b6b' },
  { name: 'violet', v: '#b281ff' },
];

function Seg({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tweaks({ open, onClose, state, setState }) {
  if (!open) return null;
  const set = (k, v) => setState({ ...state, [k]: v });

  return (
    <React.Fragment>
      <div className="tweaks-scrim" onClick={onClose} />
      <div className="tweaks" onClick={(e) => e.stopPropagation()}>
        <div className="tweaks-head">
          <span className="live-dot" />
          <Icons.settings size={14} />
          <div className="t">Tweaks</div>
          <button className="x-btn" onClick={onClose}>
            <Icons.close size={14} />
          </button>
        </div>
        <div className="tweaks-body">
          <div className="tweak-row">
            <div className="label">
              <span>Theme</span>
              <b>{state.theme}</b>
            </div>
            <Seg
              value={state.theme}
              onChange={(v) => set('theme', v)}
              options={[
                { value: 'dark', label: 'dark' },
                { value: 'light', label: 'light' },
              ]}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Accent</span>
              <b>{ACCENTS.find((a) => a.v === state.accent)?.name || 'custom'}</b>
            </div>
            <div className="swatches">
              {ACCENTS.map((a) => (
                <button
                  key={a.v}
                  className={state.accent === a.v ? 'on' : ''}
                  style={{ background: a.v }}
                  onClick={() => set('accent', a.v)}
                />
              ))}
            </div>
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Grid density</span>
              <b>{state.gridDensity} col</b>
            </div>
            <input
              type="range"
              className="rng"
              min="2"
              max="8"
              step="1"
              value={state.gridDensity}
              onChange={(e) => set('gridDensity', parseInt(e.target.value))}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Card variant</span>
              <b>{state.cardVariant}</b>
            </div>
            <Seg
              value={state.cardVariant}
              onChange={(v) => set('cardVariant', v)}
              options={[
                { value: 'tactical', label: 'tactical' },
                { value: 'panel', label: 'panel' },
                { value: 'compact', label: 'compact' },
              ]}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Status viz</span>
              <b>{state.statusVariant}</b>
            </div>
            <Seg
              value={state.statusVariant}
              onChange={(v) => set('statusVariant', v)}
              options={[
                { value: 'ringed', label: 'ring' },
                { value: 'corner', label: 'dot' },
                { value: 'pill', label: 'pill' },
              ]}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Message bubble</span>
              <b>{state.bubbleVariant}</b>
            </div>
            <Seg
              value={state.bubbleVariant}
              onChange={(v) => set('bubbleVariant', v)}
              options={[
                { value: 'classic', label: 'classic' },
                { value: 'terminal', label: 'terminal' },
                { value: 'minimal', label: 'minimal' },
              ]}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Composer</span>
              <b>{state.composerVariant}</b>
            </div>
            <Seg
              value={state.composerVariant}
              onChange={(v) => set('composerVariant', v)}
              options={[
                { value: 'rail', label: 'rail' },
                { value: 'segmented', label: 'segmented' },
                { value: 'minimal', label: 'minimal' },
              ]}
            />
          </div>

          <div className="tweak-row">
            <div className="label">
              <span>Side panel</span>
              <b>{state.panelVariant}</b>
            </div>
            <Seg
              value={state.panelVariant}
              onChange={(v) => set('panelVariant', v)}
              options={[
                { value: 'push', label: 'push' },
                { value: 'overlay', label: 'overlay' },
                { value: 'takeover', label: 'takeover' },
              ]}
            />
          </div>
        </div>
      </div>
    </React.Fragment>
  );
}

window.Tweaks = Tweaks;
