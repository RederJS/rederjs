# Reder — Functional Specification

> Web dashboard for orchestrating Claude Code sessions running on a VPS.
> Status: interactive hi-fi prototype (`Reder.html`).

---

## 1. Product overview

**Reder** is a command-deck dashboard that gives a single operator at-a-glance visibility into a fleet of autonomous Claude Code sessions, and a focused chat surface for directing each one. The design goal is **attention triage**: the operator should immediately see which sessions need them, open one, resolve it, and move on.

**Primary user:** one person running many agents on a VPS.
**Primary job-to-be-done:** triage → respond → return to overview.

---

## 2. Aesthetic & system

- **Direction:** mission-control / command-deck. Functional, futuristic, lightly editorial.
- **Type:** `JetBrains Mono` for labels, data, UI chrome, status. `Inter` for prose and message bodies. `Instrument Serif` reserved for display moments.
- **Palette:** deep near-black dark mode (`#0b0c0f`) and warm near-white light mode (`#f4f2ee`). Single user-selectable accent; default is blue `#4f8cff`.
- **Status hues (fixed, semantic):**
  - `waiting` — blue `#4f8cff` (pulses)
  - `busy`    — amber `#e0b341` (scan bar)
  - `idle`    — mint `#7cd38c` (solid)
  - `offline` — grey `#6a6e78` (dashed)
- **Brand wordmark:** lowercase `reder` followed by a blinking accent caret `▍`.
- **Both light and dark themes,** user-toggleable from the left rail or Tweaks.

---

## 3. Layout

```
┌────┬─────────────────────────────────────────────┐
│    │ topbar: wordmark · breadcrumb · search · + │
│ R  ├──────────────────────────────┬──────────────┤
│    │ grid-head: chips, cols, sort │              │
│ ▨  │                              │  side panel  │
│ ⌘  │   session grid (cards)       │   (chat)     │
│ ⓘ  │                              │              │
│ 🔔 │                              │              │
│    │                              │              │
│ ☀  │                              │              │
│ ⚙  │                              │              │
└────┴──────────────────────────────┴──────────────┘
```

- **Left rail (56px):** brand mark; sessions, terminal, usage, notifications; theme toggle; tweaks.
- **Topbar:** `reder▍` wordmark, host breadcrumb with session + waiting counts, search (⌘K), new-session button.
- **Grid area:** card grid of sessions, filter chips, column slider (2–8), sort toggle.
- **Side panel:** opens on card click; pushes the grid left (configurable).

---

## 4. Session grid

### 4.1 Card content
Each card shows:
- **Avatar** — colored disc with mono initials (e.g. `R7`).
- **Name + id** — lowercase name; mono id beneath.
- **Status pill** — color, dot, label.
- **Task preview** — 2-line clamp of current task or last message.
- **Scan bar** — when `busy`.
- **Meta row** — uptime · last-activity · tokens (and cost in the `panel` variant).

### 4.2 Status indicator variants (user-selectable)
- `ringed` (default) — animated ring around the avatar.
- `corner` — small status dot at the avatar's bottom-right.
- `pill` — label-only pill inside the card.

### 4.3 Card layout variants
- `tactical` (default) — full card with preview + meta.
- `panel`   — bordered sections; adds cost meta.
- `compact` — single-row, status pill on the right.

### 4.4 Responsive behavior
Cards use **CSS container queries**. As a card narrows:
- **≤210px** — status pill wraps below the name.
- **≤170px** — meta collapses to a single column; preview extends.
- **≤140px** — meta hides entirely; id hides; preview fills.

### 4.5 Filter & sort
- **Chips:** all · waiting · busy · idle · offline (with counts).
- **Column slider:** inline, 2–8 columns, lives next to the sort toggle.
- **Sort:** `priority` (waiting → idle → busy → offline) · `recent` · `name`.
- **Search:** matches name, id, and task preview.

---

## 5. Side panel (chat)

### 5.1 Panel header
Avatar (with status ring), name, id, working directory. Pin / settings / close actions.

### 5.2 Message stream
- Messages grouped by day (`Today` separator).
- Each message has a mono author + timestamp header and a bubble.
- **Full markdown** support: headings, paragraphs, bold, italic, inline code, fenced code blocks, ordered/unordered lists, links, blockquotes.
- Session vs. operator messages are visually distinct (bubble tint, alignment, border accent).
- A live `activity-line` shows underneath the stream when the session is `busy`.

### 5.3 Bubble variants
- `classic` — filled bubbles, distinct tint for you vs. session.
- `terminal` — no background, left rule, mono type.
- `minimal` — plain text, no container; operator messages tinted accent.

### 5.4 Quick-reply buttons (Telegram-style)
Session messages may carry `buttons: [{label, value, kind?}]`.
- Rendered as chips below the bubble.
- `kind`: `primary` (filled accent), `danger` (red), or default (outline).
- Clicking sends `value` as the operator's reply.
- Once answered, buttons collapse to `↳ replied · <label>`.
- Only the **most recent unanswered** message stays interactive; earlier ones mark as superseded.

### 5.5 Panel placement variants
- `push` (default) — grid compresses, both stay visible.
- `overlay`  — panel floats over grid.
- `takeover` — panel fills the workspace.

---

## 6. Composer

### 6.1 Controls
- Multiline autosizing textarea.
- Attach button — adds a mock filename chip; chips removable.
- Mic button — toggles speaking mode.
- Send button — submits; disabled when empty.
- Keyboard: `⏎` to send, `⇧⏎` for newline.
- Hint row shows shortcuts and a "end-to-end via VPS" note.

### 6.2 Composer variants
- `rail` (default) — tools left of textarea, send on the right.
- `segmented` — textarea on top, toolbar below with labeled buttons.
- `minimal`  — single-line mono prompt, no hint row.

### 6.3 Speaking mode (inline, no overlay)
- Mic click enters speaking mode; composer box glows with an accent border and soft fill.
- **Transcription streams into the textarea itself** (where you'd type).
- The send button **morphs into a live waveform** labeled `listening`.
- On a detected silence the button briefly flashes `sending…`, auto-submits the message, and then **keeps listening** — the mic stays active and transcribes the next phrase automatically.
- Exits on mic click or `Esc`.
- `is-speaking` state also marks the textarea readonly and hides the caret to make the mode unambiguous.

### 6.4 Attachments
File chips appear above the input. Each carries a paperclip glyph, filename, and × remove. On send, attachments are embedded as `📎 \`filename\`` lines inside the outgoing message.

---

## 7. Tweaks panel

A floating control center for all design variants; visually distinct so it's unmistakable when open.

### 7.1 Activation
- Toggle via the left-rail cog.
- Toolbar-driven Tweaks toggle (host-managed) also activates it via `__activate_edit_mode` / `__deactivate_edit_mode` messages.
- Scrim behind panel; click scrim or × to close.

### 7.2 Visual treatment
- Accent border with matching glow, accent top-bar stripe.
- Accent-tinted header with a pulsing live dot.
- Slide-in + scale-in animation on open.

### 7.3 Controls exposed
| Tweak | Options |
|---|---|
| Theme | `dark` / `light` |
| Accent | blue · mint · amber · coral · violet |
| Grid density | 2–8 columns (slider) |
| Card variant | `tactical` / `panel` / `compact` |
| Status viz | `ring` / `dot` / `pill` |
| Bubble style | `classic` / `terminal` / `minimal` |
| Composer | `rail` / `segmented` / `minimal` |
| Side panel | `push` / `overlay` / `takeover` |

All values persist via `__edit_mode_set_keys` into the `EDITMODE` block in `Reder.html`.

---

## 8. Data & behavior (prototype)

- **36 mock sessions** seeded deterministically (distribution: ~25% waiting, ~25% busy, ~35% idle, ~15% offline).
- Each session has a scripted transcript keyed to its status.
- Waiting / idle transcripts include sample `buttons[]` for quick replies.
- Operator sends (typed, voice, or quick-reply) append to the stream and trigger a canned acknowledgement after ~900ms.
- No real network — everything is local state.

---

## 9. File map

```
Reder.html                  – self-contained entry (CSS inlined; scripts referenced)
styles.css                  – source CSS
src/
  data.jsx                  – mock sessions, transcripts, formatters
  icons.jsx                 – inline SVG icon set
  markdown.jsx              – safe minimal markdown renderer
  status.jsx                – Avatar + Status indicator components
  card.jsx                  – session card (all variants)
  composer.jsx              – composer, speaking mode
  panel.jsx                 – chat panel, markdown stream, quick replies
  tweaks.jsx                – tweaks control panel
  app.jsx                   – top-level app, rail, topbar, grid, wiring
```



