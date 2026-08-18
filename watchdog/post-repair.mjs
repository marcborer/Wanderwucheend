// Runs after a repair passed the gate and was committed: comments the pinned
// tracking issue (GitHub does not notify on commits — R23) and opens ONE
// consolidated follow-up issue for the share links the repair could not fix
// (only the owner can regenerate a.sbbmobile.ch links in the SBB app — R16).
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateState, initialState } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = join(root, '.github', 'watchdog-state.json');
const SUMMARY_PATH = join(root, '.repair-summary.md');
const DRY = process.env.WATCHDOG_DRY_RUN === '1';
const TRACKING_TITLE = '🐕 Watchdog — Fahrplan-Überwachig';

function gh(args, input) {
  if (DRY) { console.log('[dry-run] gh', args.join(' '), input ? `<<< ${input.slice(0, 120)}…` : ''); return ''; }
  return execFileSync('gh', args, { encoding: 'utf8', input });
}

if (!existsSync(SUMMARY_PATH)) { console.log('no repair summary — nothing to announce'); process.exit(0); }
const summary = readFileSync(SUMMARY_PATH, 'utf8').trim();
const timeChanged = /: (dep|arr) /.test(summary);

let state = initialState();
try {
  const v = validateState(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
  if (v.ok) state = v.state;
} catch {}

// Tracking-issue comment (create + pin on first need)
let tracking = state.trackingIssue;
if (!tracking) {
  const out = gh(['issue', 'create', '--title', TRACKING_TITLE, '--body',
    'Pinned tracking issue for the nightly Fahrplan-Watchdog. Every repair and (in the final week) every run comments here — GitHub does not notify on commits.']);
  tracking = DRY ? 0 : +out.trim().split('/').pop();
  if (tracking) { try { gh(['issue', 'pin', String(tracking)]); } catch {} }
  state.trackingIssue = tracking;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}
const announce = timeChanged
  ? '\n\n➡️ **Zitä hend gänderet — bitte de Gruppe im Chat Bscheid gäh!** (Scho importierti Kaländer aktualisiered sich nid vo sälber.)'
  : '';
if (tracking != null) {
  gh(['issue', 'comment', String(tracking), '--body',
    `🔧 Reparatur committed und live:\n\n${summary}${announce}`]);
}

// Consolidated share-link follow-up (R16)
const journeys = [...new Set([...summary.matchAll(/^- (\w+) /gm)].map((m) => m[1]))];
const linkNames = { hifaart: 'Hifaart-Card', tag2: 'Tag-2-Links (La Punt/Zuoz)', heimfaart: 'Heimfaart-Card' };
gh(['issue', 'create', '--title', `🔗 SBB-Share-Links nöi generiere (${journeys.join(', ')})`, '--body',
  `D'Reparatur het d'Fahrplan-Date aktualisiert, aber d'\`a.sbbmobile.ch\`-Share-Links chan nur du im SBB-App nöi mache:\n\n` +
  journeys.map((j) => `- [ ] ${linkNames[j] ?? j}: Verbindig im SBB-App sueche → teile → Link in \`index.html\` ersetze und d'Markierig "Link wird no aktualisiert" entferne`).join('\n') +
  `\n\nÄnderige:\n${summary}`]);

rmSync(SUMMARY_PATH, { force: true });
console.log('post-repair notifications done');
