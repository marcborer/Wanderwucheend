// Fahrplan-Watchdog — pure diff logic. No I/O here: run.mjs shells around it.
// Rules R13/R18/R21 from docs/brainstorms/2026-08-18-laebigi-siite-fahrplan-watchdog-requirements.md

const MAX_STR = 80;
const clean = (s) =>
  typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_STR) : null;

export const toMin = (hm) => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);

export const journeyDurationMin = (j) =>
  toMin(j.legs[j.legs.length - 1].arr) - toMin(j.legs[0].dep);

// Badge CSS class per API line category; an unmapped category makes the diff
// ambiguous (issue, not commit) — the repair checks membership here.
export const BADGE_BY_CATEGORY = {
  B: 'bus', S: 's3', IC: 'ic', ICE: 'ic', EC: 'ic', IR: 're', RE: 're', R: 're', EV: 'ev'
};

// R21: the API response is untrusted. Whitelist exactly the fields we consume,
// strip control characters, cap string length. Anything unexpected fails closed.
export function validateApiResponse(json) {
  if (!json || !Array.isArray(json.connections)) return { ok: false, reason: 'no-connections-array' };
  const connections = [];
  for (const c of json.connections) {
    if (!Array.isArray(c.sections)) return { ok: false, reason: 'no-sections' };
    const legs = [];
    for (const s of c.sections) {
      if (!s || typeof s !== 'object') return { ok: false, reason: 'bad-section' };
      if (!s.journey) continue; // walk section
      const j = s.journey, d = s.departure, a = s.arrival;
      if (!d || !d.station || d.station.id == null || !a || !a.station || a.station.id == null ||
          typeof d.departure !== 'string' || typeof a.arrival !== 'string') {
        return { ok: false, reason: 'leg-missing-fields' };
      }
      const dep = d.departure.slice(11, 16), arr = a.arrival.slice(11, 16);
      if (!/^\d{2}:\d{2}$/.test(dep) || !/^\d{2}:\d{2}$/.test(arr)) return { ok: false, reason: 'bad-time' };
      legs.push({
        fromId: clean(String(d.station.id)),
        fromName: clean(d.station.name) ?? '',
        toId: clean(String(a.station.id)),
        toName: clean(a.station.name) ?? '',
        dep, arr,
        category: clean(j.category) ?? '',
        number: j.number == null ? '' : clean(String(j.number)) ?? '',
        operator: clean(j.operator) ?? '',
        headsign: clean(j.to) ?? '',
        platform: d.platform == null || d.platform === '' ? null : clean(String(d.platform))
      });
    }
    if (legs.length) connections.push({ legs });
  }
  return { ok: true, connections };
}

// R18: a candidate is "the booked journey" only if it shares origin id, final
// destination id, departs within ±30 min of the booked time — and is unique.
export function matchBookedJourney(candidates, booked) {
  const bl = booked.legs;
  const origin = bl[0].from.id, dest = bl[bl.length - 1].to.id, bDep = toMin(bl[0].dep);
  const hits = candidates.filter((c) => {
    const l = c.legs;
    return l.length > 0 && l[0].fromId === origin && l[l.length - 1].toId === dest &&
      Math.abs(toMin(l[0].dep) - bDep) <= 30;
  });
  if (hits.length === 1) return { status: 'matched', candidate: hits[0] };
  return { status: 'ambiguous', reason: hits.length === 0 ? 'no-candidate' : 'multiple-candidates' };
}

// Shape = leg count plus each leg's from/to station ids. Same shape → value
// diff (times, platforms, line label incl. category flips like RE→EV on the
// same routing). Different shape (leg added/removed/split — the EV1 case) →
// structural, repairable only via the journey-level match that got us here.
export function classifyDiff(candidate, booked) {
  const cl = candidate.legs, bl = booked.legs;
  const sameShape = cl.length === bl.length &&
    bl.every((b, i) => cl[i].fromId === b.from.id && cl[i].toId === b.to.id);
  if (!sameShape) return { kind: 'structural', changes: [] };
  const changes = [];
  bl.forEach((b, i) => {
    const c = cl[i];
    if (c.dep !== b.dep) changes.push({ leg: i, field: 'dep', old: b.dep, new: c.dep });
    if (c.arr !== b.arr) changes.push({ leg: i, field: 'arr', old: b.arr, new: c.arr });
    const numberDiffers = b.line.number != null && String(c.number) !== String(b.line.number);
    if (c.category !== b.line.category || numberDiffers) {
      changes.push({
        leg: i, field: 'line',
        old: { category: b.line.category, number: b.line.number },
        new: { category: c.category, number: c.number }
      });
    }
    // R13: a null/absent platform in the API never diffs against a populated value.
    if (c.platform != null && b.platform != null && c.platform !== b.platform) {
      changes.push({ leg: i, field: 'platform', old: b.platform, new: c.platform });
    }
  });
  return changes.length ? { kind: 'value', changes } : { kind: 'none', changes: [] };
}

// R13 debounce: platform-only changes act on the second consecutive sighting —
// waived within 3 days of the leg's travel date. Flaps that vanish reset.
export function applyDebounce(state, journeyKey, changes, runDateISO, travelDateISO) {
  const daysOut = Math.round((Date.parse(travelDateISO) - Date.parse(runDateISO)) / 86400000);
  const waived = daysOut <= 3;
  const prev = (state && state.pending) || {};
  const pending = Object.fromEntries(
    Object.entries(prev).filter(([k]) => !k.startsWith(journeyKey + '.'))
  );
  const act = [], hold = [];
  for (const ch of changes) {
    if (ch.field !== 'platform' || waived) { act.push(ch); continue; }
    const key = `${journeyKey}.${ch.leg}.platform:${ch.old}->${ch.new}`;
    if ((prev[key] ?? 0) >= 1) { act.push(ch); }
    else { pending[key] = 1; hold.push(ch); }
  }
  return { act, hold, pending };
}

// Cross-run state (committed .github/watchdog-state.json). Missing or invalid
// state counts as a FAILED RUN toward the blind-issue threshold (R20) — never
// a silent reset to "all clear".
export const initialState = () => ({ schema: 1, failures: 0, pending: {}, lastRun: null });

export function validateState(json) {
  if (!json || typeof json !== 'object' || json.schema !== 1 ||
      typeof json.failures !== 'number' || typeof json.pending !== 'object' || json.pending === null) {
    return { ok: false };
  }
  return {
    ok: true,
    state: {
      schema: 1,
      failures: json.failures,
      pending: json.pending,
      lastRun: typeof json.lastRun === 'string' ? json.lastRun : null
    }
  };
}

// R22/R26: deterministic re-diff of the hand-crafted cards against
// connections.json via the data-conn anchors. Regex extraction is safe here
// because the anchored spans are machine-written leaf elements.
export function extractCardValues(html) {
  const out = {};
  const re = /data-conn="([^"]+)"(?:\s+data-conn-prefix="([^"]*)")?[^>]*>([^<]*)</g;
  let m;
  while ((m = re.exec(html))) out[m[1]] = { text: m[3].trim(), prefix: m[2] ?? '' };
  return out;
}

export function rediffCards(html, conn) {
  const vals = extractCardValues(html);
  const problems = [];
  for (const [key, { text, prefix }] of Object.entries(vals)) {
    const [jKey, a, field] = key.split('.');
    const journey = conn.journeys && conn.journeys[jKey];
    if (!journey) { problems.push({ key, error: 'no-such-journey' }); continue; }
    let expected;
    if (a === 'durationText') {
      const d = journey.durationMin;
      expected = `${Math.floor(d / 60)} Std. ${d % 60} Min.`;
    } else {
      const leg = journey.legs[+a];
      if (!leg) { problems.push({ key, error: 'no-such-leg' }); continue; }
      if (field === 'line') expected = leg.line.display;
      else if (field === 'platform') expected = prefix + leg.platform;
      else expected = leg[field];
    }
    if (text !== String(expected)) problems.push({ key, card: text, json: String(expected) });
  }
  return problems;
}
