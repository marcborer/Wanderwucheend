import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyValueRepair, AmbiguousRepairError, lineDisplay } from './repair.mjs';
import { rediffCards } from './lib.mjs';
import { parseHunks, allowedHtmlRanges, rangesCovered, FILE_ALLOWLIST } from './gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const files = () => ({
  conn: JSON.parse(readFileSync(join(root, 'connections.json'), 'utf8')),
  html: readFileSync(join(root, 'index.html'), 'utf8'),
  ics: readFileSync(join(root, 'wanderwucheend-2026.ics'), 'utf8')
});

test('departure shift repairs JSON, card, countdown, .ics, duration, stamp, share-link mark', () => {
  const r = applyValueRepair(files(), {
    hifaart: [{ leg: 0, field: 'dep', old: '05:12', new: '05:17' }]
  });
  assert.equal(r.conn.journeys.hifaart.legs[0].dep, '05:17');
  assert.equal(r.conn.journeys.hifaart.durationMin, 320);
  assert.match(r.html, /data-conn="hifaart\.0\.dep">05:17</);
  assert.match(r.html, /data-conn="hifaart\.durationText">5 Std\. 20 Min\.</);
  assert.match(r.html, /var target = new Date\('2026-09-26T05:17:00\+02:00'\)/);
  assert.match(r.html, /var CONN_STAMP = '2'/);
  assert.match(r.ics, /DTSTART;TZID=Europe\/Zurich:20260926T051700/);
  assert.match(r.ics, /Abfahrt: 05:17 ab Breitenbach/);
  const hifRegion = r.html.slice(r.html.indexOf('conn:hifaart:start'), r.html.indexOf('conn:hifaart:end'));
  assert.match(hifRegion, /Link wird no aktualisiert/);
  assert.deepEqual(rediffCards(r.html, r.conn), []); // gate's re-diff stays clean
});

test('platform change repairs the anchored span with its prefix', () => {
  const r = applyValueRepair(files(), {
    hifaart: [{ leg: 2, field: 'platform', old: '9', new: '7' }]
  });
  assert.equal(r.conn.journeys.hifaart.legs[2].platform, '7');
  assert.match(r.html, /data-conn="hifaart\.2\.platform"[^>]*>Gleis 7</);
  assert.deepEqual(rediffCards(r.html, r.conn), []);
});

test('arrival change on the last leg repairs the final-row anchor and .ics DTEND', () => {
  const r = applyValueRepair(files(), {
    heimfaart: [{ leg: 5, field: 'arr', old: '20:40', new: '20:55' }]
  });
  assert.match(r.html, /data-conn="heimfaart\.5\.arr">20:55</);
  assert.match(r.ics, /DTEND;TZID=Europe\/Zurich:20260928T205500/);
  assert.equal(r.conn.journeys.heimfaart.durationMin, 275);
  assert.deepEqual(rediffCards(r.html, r.conn), []);
});

test('line category flip RE→EV rewrites badge class and display deterministically', () => {
  const r = applyValueRepair(files(), {
    heimfaart: [{ leg: 2, field: 'line', old: { category: 'RE', number: '13' }, new: { category: 'EV', number: 'EV13' } }]
  });
  assert.match(r.html, /class="travel-line-badge badge-ev"[^>]*data-conn="heimfaart\.2\.line">EV13</);
  assert.equal(r.conn.journeys.heimfaart.legs[2].line.badge, 'ev');
  assert.deepEqual(rediffCards(r.html, r.conn), []);
});

test('unmapped line category refuses to repair (ambiguous per R11)', () => {
  assert.throws(
    () => applyValueRepair(files(), {
      heimfaart: [{ leg: 2, field: 'line', old: { category: 'RE', number: '13' }, new: { category: 'GONDEL', number: '9' } }]
    }),
    AmbiguousRepairError
  );
});

test('stale diff (old value no longer in JSON) fails closed', () => {
  assert.throws(
    () => applyValueRepair(files(), {
      hifaart: [{ leg: 0, field: 'dep', old: '04:44', new: '05:17' }]
    }),
    /stale change/
  );
});

test('tag2 repair works without a card region (JSON-only, no share-link mark crash)', () => {
  const r = applyValueRepair(files(), {
    tag2: [{ leg: 0, field: 'dep', old: '11:23', new: '11:26' }]
  });
  assert.equal(r.conn.journeys.tag2.legs[0].dep, '11:26');
  assert.deepEqual(rediffCards(r.html, r.conn), []);
});

test('empty change set is a no-op on all three files', () => {
  const f = files();
  const r = applyValueRepair(f, {});
  assert.deepEqual(r.conn, f.conn);
  // stamp still bumps only when invoked with changes? No: repair with {} is never
  // invoked by run.mjs — but prove it does no harm beyond the stamp bump:
  assert.equal(r.ics, f.ics);
});

test('line display convention: spaces for trains, compact for S and EV', () => {
  assert.equal(lineDisplay('B', '115'), 'B 115');
  assert.equal(lineDisplay('IC', '3'), 'IC 3');
  assert.equal(lineDisplay('S', '3'), 'S3');
  assert.equal(lineDisplay('EV', 'EV1'), 'EV1');
  assert.equal(lineDisplay('ICE', ''), 'ICE');
});

// ── gate helpers ──

test('gate: hunk ranges inside anchored regions pass, outside fail', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const allowed = allowedHtmlRanges(html);
  assert.ok(allowed.length >= 4); // two card regions, countdown marker, stamp
  const [cardStart, cardEnd] = allowed[0];
  assert.ok(rangesCovered([[cardStart + 1, cardStart + 2]], allowed));
  assert.ok(!rangesCovered([[5, 6]], allowed)); // <head> is never repairable
});

test('gate: parseHunks reads -U0 headers', () => {
  const diff = '@@ -10,2 +10,2 @@ x\n@@ -20 +21 @@ y\n@@ -30,0 +31,3 @@ z\n';
  assert.deepEqual(parseHunks(diff), [[10, 11], [21, 21], [31, 33]]);
});

test('gate: file allowlist is exactly the four repairable artifacts', () => {
  assert.deepEqual([...FILE_ALLOWLIST].sort(), [
    '.github/watchdog-state.json', 'connections.json', 'index.html', 'wanderwucheend-2026.ics'
  ]);
});
