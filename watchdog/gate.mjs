// R22 validation gate — the repair may not commit a page it cannot prove
// intact. Run AFTER edits, BEFORE commit. Exit 1 = open an issue, no commit.
//
// Checks: (1) changed files ⊆ allowlist, (2) index.html hunks confined to the
// anchored regions, (3) no NEW parse5 document errors vs the pre-edit baseline,
// (4) the dependency-free page checks (card re-diff, inline JS syntax, .ics
// structure, countdown literal) via check-page.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export const FILE_ALLOWLIST = new Set([
  'connections.json',
  'index.html',
  'wanderwucheend-2026.ics',
  '.github/watchdog-state.json'
]);

export function parseHunks(diffText) {
  // -U0 hunk headers: @@ -a[,b] +c[,d] @@  → changed new-file ranges [c, c+d)
  const ranges = [];
  for (const m of diffText.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = +m[1];
    const len = m[2] == null ? 1 : +m[2];
    ranges.push([len === 0 ? start : start, len === 0 ? 0 : len]);
  }
  return ranges.filter(([, len]) => len > 0).map(([s, l]) => [s, s + l - 1]);
}

export function allowedHtmlRanges(html) {
  const lines = html.split('\n');
  const ranges = [];
  let start = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/<!-- conn:\w+:start -->/.test(line)) start = n;
    if (/<!-- conn:\w+:end -->/.test(line) && start != null) { ranges.push([start, n]); start = null; }
    if (/conn:countdown-target/.test(line)) ranges.push([n, n + 1]);
    if (/var CONN_STAMP = /.test(line)) ranges.push([n, n]);
  });
  return ranges;
}

export const rangesCovered = (changed, allowed) =>
  changed.every(([s, e]) => allowed.some(([as, ae]) => s >= as && e <= ae));

async function parse5Errors(html) {
  const { parse } = await import('parse5');
  const errors = [];
  parse(html, { onParseError: (e) => errors.push(e.code) });
  const counts = {};
  for (const c of errors) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}

export async function runGate() {
  const problems = [];
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

  const changedFiles = git(['diff', '--name-only']).split('\n').filter(Boolean);
  for (const f of changedFiles) {
    if (!FILE_ALLOWLIST.has(f)) problems.push(`file outside allowlist changed: ${f}`);
  }

  if (changedFiles.includes('index.html')) {
    const diff = git(['diff', '-U0', '--', 'index.html']);
    const changed = parseHunks(diff);
    const allowed = allowedHtmlRanges(readFileSync(join(root, 'index.html'), 'utf8'));
    if (!rangesCovered(changed, allowed)) {
      problems.push(`index.html changes outside anchored regions: hunks ${JSON.stringify(changed)} vs allowed ${JSON.stringify(allowed)}`);
    }
    const baseHtml = git(['show', 'HEAD:index.html']);
    const baseErr = await parse5Errors(baseHtml);
    const newErr = await parse5Errors(readFileSync(join(root, 'index.html'), 'utf8'));
    for (const [code, n] of Object.entries(newErr)) {
      if (n > (baseErr[code] ?? 0)) problems.push(`new HTML parse error introduced: ${code} (${baseErr[code] ?? 0} → ${n})`);
    }
  }

  try {
    execFileSync(process.execPath, [join(here, 'check-page.mjs')], { cwd: root, stdio: 'pipe' });
  } catch (e) {
    problems.push('check-page failed:\n' + String(e.stdout) + String(e.stderr));
  }

  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`.replace(/\\/g, '/') || process.argv[1]?.endsWith('gate.mjs')) {
  const problems = await runGate();
  if (problems.length) {
    console.error('GATE FAILED (issue, not commit):');
    for (const p of problems) console.error(' -', p);
    process.exit(1);
  }
  console.log('gate passed — repair may commit');
}
