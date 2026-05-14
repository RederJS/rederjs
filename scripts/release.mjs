#!/usr/bin/env node
// Lockstep release helper: bumps every workspace + the root in unison,
// rewrites inter-package dep ranges to the new version, refreshes the
// lockfile, moves the CHANGELOG `[Unreleased]` heading into a dated
// release section, then commits and tags. Publishing is left to the
// caller (needs npm auth) — the script prints the dependency-ordered
// publish commands at the end.
//
// Usage: npm run release -- <patch|minor|major|x.y.z>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REDER_PKGS = new Set([
  'rederjs',
  '@rederjs/core',
  '@rederjs/daemon',
  '@rederjs/shim',
  '@rederjs/adapter-telegram',
  '@rederjs/adapter-web',
]);

const PKG_PATHS = [
  'packages/cli/package.json',
  'packages/core/package.json',
  'packages/daemon/package.json',
  'packages/shim/package.json',
  'packages/adapter-telegram/package.json',
  'packages/adapter-web/package.json',
];

// Publish order — first list element has no @rederjs/* deps; later
// entries depend only on packages above them.
const PUBLISH_ORDER = [
  'packages/core',
  'packages/shim',
  'packages/adapter-telegram',
  'packages/adapter-web',
  'packages/daemon',
  'packages/cli',
];

const VALID_LEVEL =
  /^(patch|minor|major|premajor|preminor|prepatch|prerelease|\d+\.\d+\.\d+(-[\w.]+)?)$/;

function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

const level = process.argv[2];
if (!level || !VALID_LEVEL.test(level)) {
  die('usage: npm run release -- <patch|minor|major|x.y.z>');
}

if (capture('git', ['status', '--porcelain']).trim().length > 0) {
  die('working tree dirty; commit or stash first');
}

const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch !== 'main') {
  process.stderr.write(`warning: not on main (current: ${branch}); continuing\n`);
}

run('npm', ['version', level, '--workspaces', '--include-workspace-root', '--no-git-tag-version']);

const newVersion = JSON.parse(readFileSync('packages/cli/package.json', 'utf8')).version;

let depsRewritten = 0;
for (const path of PKG_PATHS) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (REDER_PKGS.has(name) && deps[name] !== `^${newVersion}`) {
        deps[name] = `^${newVersion}`;
        changed = true;
        depsRewritten += 1;
      }
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

run('npm', ['install', '--package-lock-only']);

const today = new Date().toISOString().slice(0, 10);
const cl = readFileSync('CHANGELOG.md', 'utf8');
if (!/## \[Unreleased\]/.test(cl)) {
  process.stderr.write(
    'warning: no [Unreleased] heading in CHANGELOG.md; skipping changelog rewrite\n',
  );
} else {
  const updated = cl.replace(
    /## \[Unreleased\]\n/,
    `## [Unreleased]\n\n## [${newVersion}] — ${today}\n`,
  );
  writeFileSync('CHANGELOG.md', updated);
}

const filesToCommit = ['CHANGELOG.md', 'package.json', 'package-lock.json', ...PKG_PATHS];
run('git', ['add', ...filesToCommit]);
run('git', ['commit', '-m', `chore(release): v${newVersion}`]);
run('git', ['tag', '-a', `v${newVersion}`, '-m', `Release v${newVersion}`]);

process.stdout.write(
  `\n✓ v${newVersion} — committed, tagged. Rewrote ${depsRewritten} inter-package dep ref(s).\n\n`,
);
process.stdout.write('Push:\n');
process.stdout.write('  git push && git push --tags\n\n');
process.stdout.write('Publish (in dependency order):\n');
for (const dir of PUBLISH_ORDER) {
  process.stdout.write(`  (cd ${dir} && npm publish)\n`);
}
