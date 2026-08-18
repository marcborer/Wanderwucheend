// CI page smoke (jsdom): loads the real index.html with representative
// ?fake-date values and asserts the trip state machine, hero variants, and
// zero page errors — the page itself stays build- and dependency-free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const connRaw = readFileSync(join(root, 'connections.json'), 'utf8');

function loadPage(query, { failFetch = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e)));
  const dom = new JSDOM(html, {
    url: 'https://wanderweekend.marc-borer.ch/' + query,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = () => failFetch
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(connRaw)) });
      window.IntersectionObserver = class {
        observe() {} unobserve() {} disconnect() {}
      };
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    }
  });
  return { dom, errors };
}

const settle = () => new Promise((r) => setTimeout(r, 1200)); // one tick + fetch

const shown = (el) => el.style.display !== 'none';

test('BEFORE: countdown visible, hüt/after hidden, no page errors', async () => {
  const { dom, errors } = loadPage('?fake-date=2026-09-01T12:00');
  await settle();
  const d = dom.window.document;
  assert.ok(shown(d.getElementById('countdown')));
  assert.ok(!shown(d.getElementById('huetPanel')));
  assert.ok(!shown(d.getElementById('afterPanel')));
  assert.match(d.getElementById('cd-days').textContent, /^\d+$/);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('DURING day 1: hüt hero with Etappe 1 and the 05:12 departure', async () => {
  const { dom, errors } = loadPage('?fake-date=2026-09-26T04:50');
  await settle();
  const d = dom.window.document;
  assert.ok(shown(d.getElementById('huetPanel')));
  assert.ok(!shown(d.getElementById('countdown')));
  assert.match(d.getElementById('huetTitle').textContent, /Etappe 1/);
  assert.match(d.getElementById('huetDeparture').textContent, /05:12/);
  assert.match(d.getElementById('huetLive').href, /von=.*nach=.*datum=2026-09-26/);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('DURING day 3 after last departure: widget hidden, ticker still there', async () => {
  const { dom, errors } = loadPage('?fake-date=2026-09-28T22:00');
  await settle();
  const d = dom.window.document;
  assert.ok(shown(d.getElementById('huetPanel')));
  assert.ok(!shown(d.getElementById('huetDeparture')));
  assert.notEqual(d.getElementById('huetJetzgrad').textContent.trim(), '');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('DURING with failed fetch: widget hidden, stage + ticker render, no errors', async () => {
  const { dom, errors } = loadPage('?fake-date=2026-09-27T10:00', { failFetch: true });
  await settle();
  const d = dom.window.document;
  assert.ok(shown(d.getElementById('huetPanel')));
  assert.ok(!shown(d.getElementById('huetDeparture')));
  assert.match(d.getElementById('huetTitle').textContent, /Etappe 2/);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('AFTER: past-tense hero with day count', async () => {
  const { dom, errors } = loadPage('?fake-date=2026-10-05T12:00');
  await settle();
  const d = dom.window.document;
  assert.ok(shown(d.getElementById('afterPanel')));
  assert.ok(!shown(d.getElementById('countdown')));
  assert.match(d.getElementById('afterCount').textContent, /7 Täg/);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('boundary instants: 25.9 23:59 BEFORE, 26.9 00:00 DURING, 29.9 00:00 AFTER', async () => {
  const cases = [
    ['?fake-date=2026-09-25T23:59', 'countdown'],
    ['?fake-date=2026-09-26T00:00', 'huetPanel'],
    ['?fake-date=2026-09-28T23:59', 'huetPanel'],
    ['?fake-date=2026-09-29T00:00', 'afterPanel']
  ];
  for (const [query, visibleId] of cases) {
    const { dom, errors } = loadPage(query);
    await settle();
    const d = dom.window.document;
    for (const id of ['countdown', 'huetPanel', 'afterPanel']) {
      assert.equal(shown(d.getElementById(id)), id === visibleId, `${query}: ${id}`);
    }
    assert.deepEqual(errors, []);
    dom.window.close();
  }
});

test('invalid fake-date falls back to real time without errors', async () => {
  const { dom, errors } = loadPage('?fake-date=nonsense');
  await settle();
  const d = dom.window.document;
  const states = [d.getElementById('countdown'), d.getElementById('huetPanel'), d.getElementById('afterPanel')].filter(shown);
  assert.equal(states.length, 1); // exactly one state renders, whatever today is
  assert.deepEqual(errors, []);
  dom.window.close();
});
