// Fahrplan-Watchdog — nightly I/O shell around lib.mjs (detect-and-issue mode).
// Env: GH_TOKEN (gh CLI auth), WATCHDOG_API_BASE (test override; collaborator-
// gated workflow_dispatch input), WATCHDOG_DRY_RUN=1 (print instead of gh).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateApiResponse, matchBookedJourney, classifyDiff, applyDebounce,
  validateState, initialState, toMin
} from './lib.mjs';
import { applyValueRepair, AmbiguousRepairError } from './repair.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = join(root, '.github', 'watchdog-state.json');
const API = (process.env.WATCHDOG_API_BASE || 'https://transport.opendata.ch/v1').replace(/\/$/, '');
const DRY = process.env.WATCHDOG_DRY_RUN === '1';
const TRACKING_TITLE = '🐕 Watchdog — Fahrplan-Überwachig';
const BLIND_TITLE = '🙈 Watchdog isch blind — API-Probleme';
const LAST_TRIP_DAY = '2026-09-28';
const HEARTBEAT_FROM = '2026-09-19';

const zh = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' });
const todayZurich = () => zh.format(new Date()); // YYYY-MM-DD

function gh(args, input) {
  if (DRY) { console.log('[dry-run] gh', args.join(' '), input ? `<<< ${input.slice(0, 120)}…` : ''); return ''; }
  return execFileSync('gh', args, { encoding: 'utf8', input });
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    console.log('state: absent — first run, bootstrapping');
    return { state: initialState(), corrupt: false };
  }
  try {
    const v = validateState(JSON.parse(readFileSync(STATE_PATH, 'utf8')));
    if (v.ok) return { state: v.state, corrupt: false };
  } catch {}
  // R20: corrupt state is a failed-run signal, never a silent reset.
  console.error('state: CORRUPT — counting as a failed run');
  return { state: initialState(), corrupt: true };
}

const saveState = (state) => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

function findIssue(title) {
  const out = gh(['issue', 'list', '--state', 'open', '--search', `in:title "${title}"`, '--json', 'number,title']);
  if (DRY) return null;
  const hit = JSON.parse(out || '[]').find((i) => i.title === title);
  return hit ? hit.number : null;
}

function ensureTrackingIssue(state) {
  if (state.trackingIssue) return state.trackingIssue;
  let n = findIssue(TRACKING_TITLE);
  if (!n) {
    const out = gh(['issue', 'create', '--title', TRACKING_TITLE, '--body',
      'Pinned tracking issue for the nightly Fahrplan-Watchdog. Every repair and (in the final week) every run comments here — GitHub does not notify on commits.'],
    );
    n = DRY ? 0 : +out.trim().split('/').pop();
    if (n) { try { gh(['issue', 'pin', String(n)]); } catch { console.error('pinning failed (non-fatal)'); } }
  }
  state.trackingIssue = n;
  return n;
}

async function fetchConnections(journey) {
  const legs = journey.legs;
  const dep = legs[0].dep;
  const time = `${String(Math.max(0, Math.floor((toMin(dep) - 15) / 60))).padStart(2, '0')}:${String((toMin(dep) - 15) % 60).padStart(2, '0')}`;
  const url = `${API}/connections?from=${legs[0].from.id}&to=${legs[legs.length - 1].to.id}&date=${journey.date}&time=${time}&limit=6`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function checkB313(b313) {
  const url = `${API}/stationboard?id=${b313.from.id}&datetime=${b313.date}T13:00&limit=40`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`stationboard http ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json.stationboard)) throw new Error('stationboard shape');
  const seen = new Set(
    json.stationboard
      .filter((e) => e && e.stop && typeof e.stop.departure === 'string')
      .map((e) => e.stop.departure.slice(11, 16))
  );
  return b313.departures.filter((hm) => !seen.has(hm));
}

function fmtChanges(key, changes) {
  return changes.map((c) => c.field === 'line'
    ? `- ${key} Leg ${c.leg}: Linie ${c.old.category} ${c.old.number ?? ''} → ${c.new.category} ${c.new.number}`.trim()
    : `- ${key} Leg ${c.leg}: ${c.field} ${c.old} → ${c.new}`
  ).join('\n');
}

const today = todayZurich();

// R17: self-disable after the trip — the October project deletes the file.
if (today > LAST_TRIP_DAY) {
  console.log('trip is over — self-disabling workflow (R17)');
  try { gh(['workflow', 'disable', 'watchdog.yml']); } catch (e) { console.error('disable failed:', String(e).slice(0, 200)); process.exitCode = 1; }
  process.exit();
}

const { state, corrupt } = loadState();
const conn = JSON.parse(readFileSync(join(root, 'connections.json'), 'utf8'));

let runFailed = corrupt;
const report = { held: [], ambiguous: [], structural: [], b313Missing: [], errors: [] };
const actByJourney = {};

for (const [key, journey] of Object.entries(conn.journeys)) {
  try {
    const raw = await fetchConnections(journey);
    const v = validateApiResponse(raw);
    if (!v.ok) { report.errors.push(`${key}: API-Antwort ungültig (${v.reason})`); runFailed = true; continue; }
    const m = matchBookedJourney(v.connections, journey);
    if (m.status === 'ambiguous') { report.ambiguous.push(`${key}: ${m.reason}`); continue; }
    const d = classifyDiff(m.candidate, journey);
    if (d.kind === 'structural') {
      report.structural.push(`${key}: Streckenstruktur het gänderet (Legs: ${journey.legs.length} → ${m.candidate.legs.length})`);
    } else if (d.kind === 'value') {
      const { act, hold, pending } = applyDebounce(state, key, d.changes, today, journey.date);
      state.pending = pending;
      if (act.length) actByJourney[key] = act;
      if (hold.length) report.held.push(fmtChanges(key, hold));
    } else {
      state.pending = applyDebounce(state, key, [], today, journey.date).pending; // clear vanished flaps
    }
  } catch (e) {
    report.errors.push(`${key}: ${String(e.message || e).slice(0, 120)}`);
    runFailed = true;
  }
}

try {
  const missing = await checkB313(conn.b313);
  if (missing.length) report.b313Missing = missing;
} catch (e) {
  report.errors.push(`b313: ${String(e.message || e).slice(0, 120)}`);
  runFailed = true;
}

// ── self-healing repair (R14, value-level only; the gate runs afterwards) ──
let repaired = null;
if (Object.keys(actByJourney).length && !runFailed) {
  try {
    const files = {
      conn,
      html: readFileSync(join(root, 'index.html'), 'utf8'),
      ics: readFileSync(join(root, 'wanderwucheend-2026.ics'), 'utf8')
    };
    const r = applyValueRepair(files, actByJourney);
    writeFileSync(join(root, 'connections.json'), JSON.stringify(r.conn, null, 2) + '\n');
    writeFileSync(join(root, 'index.html'), r.html);
    writeFileSync(join(root, 'wanderwucheend-2026.ics'), r.ics);
    const summary = Object.entries(actByJourney).map(([k, c]) => fmtChanges(k, c)).join('\n');
    repaired = { touched: r.touched, summary };
    writeFileSync(join(root, '.repair-summary.md'), summary + '\n');
    console.log('repair applied:\n' + summary);
  } catch (e) {
    if (e instanceof AmbiguousRepairError) report.ambiguous.push('repair: ' + e.message);
    else { report.errors.push('repair: ' + String(e.message).slice(0, 200)); runFailed = true; }
  }
}
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `repaired=${repaired ? 'true' : 'false'}\n`, { flag: 'a' });
}

// ── outcomes needing a human: structural, ambiguous, B313 pattern breaks ──
const hasFindings = report.structural.length || report.ambiguous.length || report.b313Missing.length;

if (runFailed) {
  state.failures += 1;
  console.error(`run failed (${state.failures} consecutive):`, report.errors);
  if (state.failures >= 2 && !state.blindIssue) {
    const body = `Zwei Nächt hintrenand kei brauchbari Antwort vo transport.opendata.ch.\n\nLetschti Fähler:\n${report.errors.map((e) => '- ' + e).join('\n')}\n\nDe Watchdog gseht im Momänt nüt — Fahrplan-Änderige blibed unentdeckt!`;
    const out = gh(['issue', 'create', '--title', BLIND_TITLE, '--body', body]);
    state.blindIssue = DRY ? 0 : +out.trim().split('/').pop();
  }
} else {
  state.failures = 0;
  if (state.blindIssue) {
    try {
      gh(['issue', 'comment', String(state.blindIssue), '--body', 'De Watchdog gseht wieder — API antwortet normal. 🐕']);
      gh(['issue', 'close', String(state.blindIssue)]);
    } catch {}
    state.blindIssue = null;
  }
}

if (hasFindings) {
  const sections = [];
  if (report.structural.length) sections.push('## ⚠️ Strukturelli Änderige\n' + report.structural.join('\n') + '\n\nDie bruuched (no) e Hand: `connections.json`, d\'Travel-Cards und d\'Share-Links aapasse.');
  if (report.ambiguous.length) sections.push('## Unklar (kei eideutigi Verbindig gfonde)\n' + report.ambiguous.map((a) => '- ' + a).join('\n'));
  if (report.b313Missing.length) sections.push('## B313-Muster\nFähledi :20er-Abfahrte ab Teufi: ' + report.b313Missing.join(', '));
  sections.push('\n**Checklischte:** `connections.json` aapasse → Cards folged (CI-Re-Diff prüeft) → Countdown/.ics bi Zitänderige → SBB-Share-Links im SBB-App nöi generiere.');
  const body = sections.join('\n\n');
  const hash = [...body].reduce((h, c) => (h * 31 + c.codePointAt(0)) % 1e9, 7).toString(36);
  if (state.lastIssueHash === hash && state.lastDiffIssue) {
    console.log('identical findings already reported in issue #' + state.lastDiffIssue);
  } else {
    const out = gh(['issue', 'create', '--title', `🚆 Fahrplan-Änderig entdeckt (${today})`, '--body', body]);
    state.lastDiffIssue = DRY ? 0 : +out.trim().split('/').pop();
    state.lastIssueHash = hash;
  }
}

// Heartbeat in the final week — silence must mean death, not health (R23).
if (today >= HEARTBEAT_FROM) {
  const n = ensureTrackingIssue(state);
  const status = runFailed ? `⚠️ Lauf mit Fähler (${state.failures}. Nacht)` : repaired ? '🔧 Reparatur aagwandt' : hasFindings ? '🔔 Änderige gmäldet' : report.held.length ? '👀 Gleis-Änderig beobachtet (Debounce)' : '✅ Alles ruhig — Fahrplan stimmt';
  if (n != null) { try { gh(['issue', 'comment', String(n), '--body', `Heartbeat ${today}: ${status}`]); } catch {} }
}

if (report.held.length) console.log('held by debounce (watching again tomorrow):\n' + report.held.join('\n'));

state.lastRun = today;
saveState(state);
console.log('done:', JSON.stringify({ failed: runFailed, findings: !!hasFindings, repaired: !!repaired, failures: state.failures }));
if (runFailed) process.exitCode = 1;
