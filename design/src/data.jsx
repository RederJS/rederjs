/* global React */
const { useState, useMemo, useEffect, useRef, useCallback } = React;

// ------------ mock data ------------

const NAMES = [
  ['atlas', 'R7', '#7cd38c'],
  ['borg', 'B2', '#4f8cff'],
  ['cipher', 'C4', '#e0b341'],
  ['delta', 'D9', '#e06a8c'],
  ['echo', 'E1', '#b281ff'],
  ['forge', 'F3', '#4ed6c4'],
  ['glyph', 'G8', '#ff8a3c'],
  ['helix', 'H5', '#8ac8ff'],
  ['ibex', 'I6', '#c7f464'],
  ['juno', 'J2', '#ff6b9d'],
  ['kilo', 'K9', '#9bafff'],
  ['loom', 'L4', '#ffcd6b'],
  ['mesa', 'M7', '#7cd3c4'],
  ['nova', 'N3', '#e0b341'],
  ['orion', 'O5', '#4f8cff'],
  ['pax', 'P8', '#ff8a3c'],
  ['quill', 'Q1', '#b281ff'],
  ['rune', 'R6', '#7cd38c'],
  ['sigil', 'S2', '#e06a8c'],
  ['tarot', 'T9', '#4ed6c4'],
  ['umber', 'U4', '#ff6b9d'],
  ['vector', 'V7', '#c7f464'],
  ['wraith', 'W3', '#8ac8ff'],
  ['xenon', 'X5', '#ffcd6b'],
  ['yak', 'Y8', '#9bafff'],
  ['zeta', 'Z1', '#7cd3c4'],
  ['arc', 'A9', '#ff8a3c'],
  ['braid', 'B6', '#b281ff'],
  ['coil', 'C3', '#e0b341'],
  ['drift', 'D7', '#e06a8c'],
  ['embr', 'E4', '#4f8cff'],
  ['frost', 'F2', '#7cd38c'],
  ['gale', 'G1', '#ff6b9d'],
  ['husk', 'H8', '#c7f464'],
  ['iris', 'I5', '#4ed6c4'],
  ['jolt', 'J6', '#8ac8ff'],
];

const STATUSES = ['waiting', 'busy', 'idle', 'offline'];

const TASKS = {
  waiting: [
    'Awaiting approval on migration plan — 3 steps queued',
    'Pending: confirm production deploy target',
    'Stopped to ask: overwrite existing fixtures?',
    'Needs decision — two failing tests, which to trust?',
    'Blocked on: which env vars should we preserve?',
    'Ready to merge — waiting on your sign-off',
  ],
  busy: [
    'Refactoring `src/auth/**` — 23 files touched',
    'Running test suite (path 4/12)',
    'Building Docker image: stage 2 of 4',
    'Reindexing postgres — ~2m remaining',
    'Parsing 1,847 commits for changelog…',
    'Compiling Rust dependencies…',
  ],
  idle: [
    'Finished indexing. Repo mapped.',
    'All tests pass. Ready for next task.',
    'Deployed v0.4.2 — standing by.',
    'Reviewed PR #284. Left comments.',
    'Session initialized. Awaiting instruction.',
  ],
  offline: [
    'Last seen: SIGTERM at 14:02',
    'Connection lost — VPS unreachable',
    'Session ended normally',
    'Disconnected — token expired',
  ],
};

const DIRS = [
  '~/projects/reder-api',
  '~/projects/voyager/core',
  '~/projects/dashboard',
  '~/work/client-stripe-webhook',
  '~/sandbox/rust-embed',
  '~/projects/reder-web',
  '~/work/monolith',
  '~/projects/ansible-infra',
  '~/lab/scratch',
];

function seededRand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function formatUptime(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60),
    m = mins % 60;
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatLast(mins) {
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}m`;
}

function makeSessions() {
  const rand = seededRand(42);
  return NAMES.map(([name, id, color], i) => {
    // distribute statuses: ~25% waiting, ~25% busy, ~35% idle, ~15% offline
    const r = rand();
    let status;
    if (r < 0.25) status = 'waiting';
    else if (r < 0.5) status = 'busy';
    else if (r < 0.85) status = 'idle';
    else status = 'offline';

    const taskList = TASKS[status];
    const task = taskList[Math.floor(rand() * taskList.length)];

    const uptime = status === 'offline' ? 0 : Math.floor(rand() * 3200) + 20;
    const lastMin =
      status === 'busy'
        ? 0
        : status === 'waiting'
          ? Math.floor(rand() * 8)
          : Math.floor(rand() * 240);
    const tokens = status === 'offline' ? 0 : Math.floor(rand() * 450000) + 2000;
    const cost = tokens * 0.0000025;
    const unread = status === 'waiting' ? 1 + Math.floor(rand() * 3) : 0;

    return {
      id: `${id}-${(100 + i).toString(36)}`,
      slug: id.toLowerCase(),
      name,
      initials: id,
      color,
      status,
      task,
      dir: DIRS[Math.floor(rand() * DIRS.length)],
      uptime, // minutes
      lastMin,
      tokens,
      cost,
      unread,
    };
  });
}

// ------------ transcripts ------------

const SCRIPTS = {
  waiting: [
    {
      who: 'them',
      t: -14,
      md: 'I finished scaffolding the migration. Before I run it, I want to confirm:\n\n- `users.email` will switch from `varchar(255)` to `citext`\n- `sessions.token` becomes `text` (no length limit)\n- Adding a partial index `WHERE deleted_at IS NULL`\n\nShall I proceed against production, or dry-run on staging first?',
      buttons: [
        { label: 'Dry-run on staging', value: 'Dry-run on staging first.', kind: 'primary' },
        { label: 'Run on production', value: 'Run it on production.', kind: 'danger' },
        { label: 'Show me the plan', value: 'Show me the full migration plan first.' },
      ],
    },
    { who: 'me', t: -13, md: 'Staging first. Send me the explain plan when you have it.' },
    { who: 'them', t: -12, md: 'Running `EXPLAIN ANALYZE` on staging now…' },
    {
      who: 'them',
      t: -11,
      md: '```\nSeq Scan on users  (cost=0.00..18419.00 rows=1000000 width=58)\n  Filter: (deleted_at IS NULL)\nPlanning Time: 0.412 ms\nExecution Time: 2141.089 ms\n```\n\nThe partial index drops this to **48ms**. Worth it.',
    },
    { who: 'me', t: -10, md: 'Good. What about `sessions`?' },
    {
      who: 'them',
      t: -7,
      md: "`sessions` is cleaner — no existing constraints conflict. The only risk: there's a `btree_gist` extension required for the new exclusion constraint. Should I add that as a prereq step, or assume it's installed?",
    },
    {
      who: 'them',
      t: -4,
      md: 'I can proceed three ways:\n\n1. **Cautious** — add a guard that installs `btree_gist` if missing, logs, continues.\n2. **Strict** — bail out if extension is missing, you install manually.\n3. **Greedy** — just `CREATE EXTENSION IF NOT EXISTS` and move on.\n\nWhich?',
      buttons: [
        { label: 'Cautious', value: 'Go with cautious — guard + log.', kind: 'primary' },
        { label: 'Strict', value: 'Strict. Bail if missing.' },
        { label: 'Greedy', value: 'Greedy is fine.' },
        { label: 'Cancel migration', value: 'Hold off for now.', kind: 'danger' },
      ],
    },
  ],
  busy: [
    {
      who: 'me',
      t: -22,
      md: 'Refactor the auth module to drop the legacy session helper. Keep the public API stable.',
    },
    {
      who: 'them',
      t: -21,
      md: "Starting. I'll inventory callsites first, then cut them over in a topological order so nothing breaks mid-refactor.",
    },
    {
      who: 'them',
      t: -19,
      md: 'Found **47 callsites** across 23 files. Dependencies graphed:\n\n```\nauth.session → auth.cookie → (14 files)\nauth.session → auth.middleware → (26 files)\nauth.session direct → (7 files)\n```\n\nRewriting leaves first.',
    },
    {
      who: 'them',
      t: -16,
      md: '- ✅ `auth.cookie` cut over\n- ✅ `auth.middleware` cut over\n- ⏳ Direct callsites (3/7)',
    },
    { who: 'them', t: -9, md: '- ✅ Direct callsites (7/7)\n- ⏳ Running test suite' },
    {
      who: 'them',
      t: -2,
      md: "Path 4/12 passing. Holding — I'll message when the suite clears or fails.",
    },
  ],
  idle: [
    { who: 'me', t: -58, md: 'Pull the latest from main and rebuild the index.' },
    { who: 'them', t: -57, md: 'On it.' },
    {
      who: 'them',
      t: -42,
      md: 'Done. Pulled **13 new commits**, indexed **1,847 files**. Nothing looks unusual — some minor churn in `src/api/routes`.\n\nReady for the next task.',
      buttons: [
        { label: 'Run tests', value: 'Run the full test suite.', kind: 'primary' },
        { label: 'Show the changes', value: 'Show me the notable changes in src/api/routes.' },
        { label: 'Standby', value: 'Standby for now.' },
      ],
    },
  ],
  offline: [
    { who: 'me', t: -180, md: 'Take a break.' },
    { who: 'them', t: -179, md: 'Saving state and exiting cleanly. See you soon.' },
  ],
};

function fmtTime(minAgo) {
  const d = new Date(Date.now() + minAgo * 60000);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function buildStream(session) {
  const base = SCRIPTS[session.status] || SCRIPTS.idle;
  return base.map((m, i) => ({ ...m, id: `${session.id}-m-${i}`, time: fmtTime(m.t) }));
}

window.__reder = {
  makeSessions,
  STATUSES,
  formatUptime,
  formatLast,
  formatTokens,
  buildStream,
  fmtTime,
};
