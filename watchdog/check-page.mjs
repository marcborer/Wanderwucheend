// CI page check — dependency-free core of the R22 gate:
// 1. connections.json parses and re-diffs clean against the cards' data-conn anchors
// 2. the inline <script> in index.html is syntactically valid JS (node --check) —
//    an HTML parser would happily ship a page whose whole IIFE is dead
// 3. wanderwucheend-2026.ics is structurally sound (VCALENDAR/VEVENT/DTSTART/DTEND,
//    CRLF line endings; TZID-without-VTIMEZONE is the accepted existing convention)
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rediffCards } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1; };

const html = readFileSync(join(root, 'index.html'), 'utf8');

// 1 — re-diff
let conn;
try {
  conn = JSON.parse(readFileSync(join(root, 'connections.json'), 'utf8'));
} catch (e) {
  fail('connections.json does not parse: ' + e.message);
}
if (conn) {
  const problems = rediffCards(html, conn);
  if (problems.length) fail('card/JSON drift: ' + JSON.stringify(problems));
  else console.log('ok: cards re-diff clean against connections.json');
}

// 2 — inline JS syntax
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) fail('no inline <script> found in index.html');
const dir = mkdtempSync(join(tmpdir(), 'ww-check-'));
try {
  scripts.forEach((code, i) => {
    const f = join(dir, `inline-${i}.js`);
    writeFileSync(f, code);
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
      console.log(`ok: inline script ${i} parses (${code.length} chars)`);
    } catch (e) {
      fail(`inline script ${i} has a syntax error:\n` + String(e.stderr));
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 3 — .ics structure
const ics = readFileSync(join(root, 'wanderwucheend-2026.ics'), 'utf8');
for (const needle of ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'DTSTART;TZID=Europe/Zurich:', 'DTEND;TZID=Europe/Zurich:', 'END:VEVENT', 'END:VCALENDAR']) {
  if (!ics.includes(needle)) fail('.ics missing ' + needle);
}
if (!/\r\n/.test(ics)) fail('.ics lost its CRLF line endings');
const dt = ics.match(/DTSTART;TZID=Europe\/Zurich:(\d{8}T\d{6})/);
if (!dt) fail('.ics DTSTART not in expected basic format');
else console.log('ok: .ics structurally sound, DTSTART ' + dt[1]);

// 4 — countdown literal parses as a date and matches connections.json departure
const target = html.match(/conn:countdown-target[^\n]*\n\s*var target = new Date\('([^']+)'\)/);
if (!target) fail('countdown-target marker/literal not found');
else if (Number.isNaN(Date.parse(target[1]))) fail('countdown target is not a valid date: ' + target[1]);
else if (conn && !target[1].includes(conn.journeys.hifaart.legs[0].dep)) {
  fail(`countdown target ${target[1]} does not contain the booked departure ${conn.journeys.hifaart.legs[0].dep}`);
} else console.log('ok: countdown target valid and consistent: ' + target[1]);

if (process.exitCode) process.exit(process.exitCode);
console.log('page check passed');
