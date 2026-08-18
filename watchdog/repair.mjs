// Deterministic value-level repair (R14): edits connections.json, the
// data-conn-anchored card values (text + badge class), the countdown literal,
// and the .ics — all as in-place substitutions. AI never touches these.
// Structural changes are NOT handled here (they go to the structural arm/issue).
import { BADGE_BY_CATEGORY, journeyDurationMin } from './lib.mjs';

export class AmbiguousRepairError extends Error {}

const durationText = (min) => `${Math.floor(min / 60)} Std. ${min % 60} Min.`;

// Display convention on the cards: "B 115", "IC 3", "IR 38" — but "S3" and
// "EV1" (no space; EV numbers already embed the category).
export function lineDisplay(category, number) {
  const n = String(number ?? '');
  if (!n) return category;
  if (n.startsWith(category)) return n;
  return category === 'S' ? category + n : `${category} ${n}`;
}

function setAnchorText(html, key, value) {
  const re = new RegExp(`(data-conn="${key}"[^>]*>)[^<]*(<)`);
  if (!re.test(html)) throw new Error(`anchor not found: ${key}`);
  return html.replace(re, `$1${value}$2`);
}

function setBadgeClass(html, key, badge) {
  const re = new RegExp(`(class="travel-line-badge )badge-[a-z0-9]+("[^>]*data-conn="${key}")`);
  if (!re.test(html)) throw new Error(`badge anchor not found: ${key}`);
  return html.replace(re, `$1badge-${badge}$2`);
}

export function markShareLink(html, journeyKey) {
  const start = html.indexOf(`<!-- conn:${journeyKey}:start -->`);
  const end = html.indexOf(`<!-- conn:${journeyKey}:end -->`);
  if (start < 0 || end < 0) return html; // no card region (e.g. tag2) — follow-up issue covers it
  const region = html.slice(start, end);
  if (region.includes('Link wird no aktualisiert')) return html;
  const marked = region.replace('>In SBB App uufmache<', '>In SBB App uufmache ⚠️ (Link wird no aktualisiert)<');
  return html.slice(0, start) + marked + html.slice(end);
}

// changesByJourney: { hifaart: [{leg, field, old, new}, ...], ... } — value diffs only.
export function applyValueRepair({ conn, html, ics }, changesByJourney) {
  conn = JSON.parse(JSON.stringify(conn));
  const anchored = new Set([...html.matchAll(/data-conn="([^"]+)"/g)].map((m) => m[1]));
  const touched = [];

  for (const [jKey, changes] of Object.entries(changesByJourney)) {
    if (!changes.length) continue;
    const journey = conn.journeys[jKey];
    if (!journey) throw new Error(`unknown journey: ${jKey}`);
    for (const ch of changes) {
      const leg = journey.legs[ch.leg];
      if (!leg) throw new Error(`unknown leg: ${jKey}.${ch.leg}`);
      if (ch.field === 'dep' || ch.field === 'arr' || ch.field === 'platform') {
        if (String(leg[ch.field]) !== String(ch.old)) throw new Error(`stale change for ${jKey}.${ch.leg}.${ch.field}: json has ${leg[ch.field]}, diff says ${ch.old}`);
        leg[ch.field] = ch.new;
        const key = `${jKey}.${ch.leg}.${ch.field}`;
        if (anchored.has(key)) {
          const prefix = ch.field === 'platform' ? (leg.line.category === 'B' ? 'Kante ' : 'Gleis ') : '';
          html = setAnchorText(html, key, prefix + ch.new);
        }
      } else if (ch.field === 'line') {
        const badge = BADGE_BY_CATEGORY[ch.new.category];
        if (!badge) throw new AmbiguousRepairError(`no badge mapping for category ${ch.new.category} (R11: issue, not commit)`);
        leg.line = { category: ch.new.category, number: ch.new.number, display: lineDisplay(ch.new.category, ch.new.number), badge };
        const key = `${jKey}.${ch.leg}.line`;
        if (anchored.has(key)) {
          html = setAnchorText(html, key, leg.line.display);
          html = setBadgeClass(html, key, badge);
        }
      } else {
        throw new Error(`unrepairable field: ${ch.field}`);
      }
    }
    journey.durationMin = journeyDurationMin(journey);
    if (anchored.has(`${jKey}.durationText`)) {
      html = setAnchorText(html, `${jKey}.durationText`, durationText(journey.durationMin));
    }
    // arrival of the last leg is anchored as {j}.{last}.arr on the final row
    const lastIdx = journey.legs.length - 1;
    if (anchored.has(`${jKey}.${lastIdx}.arr`)) {
      html = setAnchorText(html, `${jKey}.${lastIdx}.arr`, journey.legs[lastIdx].arr);
    }
    html = markShareLink(html, jKey);
    touched.push(jKey);
  }

  return { ...syncDerived({ conn, html, ics }), touched };
}

// Countdown, .ics, and cache stamp follow the journey times — one derived-sync
// step shared by the value and structural arms.
export function syncDerived({ conn, html, ics }) {
  const hifDep = conn.journeys.hifaart.legs[0].dep;
  html = html.replace(
    /(conn:countdown-target[^\n]*\n\s*var target = new Date\(')[^']+('\))/,
    `$12026-09-26T${hifDep}:00+02:00$2`
  );
  ics = ics.replace(/DTSTART;TZID=Europe\/Zurich:20260926T\d{6}/, `DTSTART;TZID=Europe/Zurich:20260926T${hifDep.replace(':', '')}00`);
  ics = ics.replace(/Abfahrt: \d{2}:\d{2} ab Breitenbach/, `Abfahrt: ${hifDep} ab Breitenbach`);
  const heimLegs = conn.journeys.heimfaart.legs;
  const heimArr = heimLegs[heimLegs.length - 1].arr;
  ics = ics.replace(/DTEND;TZID=Europe\/Zurich:20260928T\d{6}/, `DTEND;TZID=Europe/Zurich:20260928T${heimArr.replace(':', '')}00`);

  // Cache pinning: bump the stamp so HTML and JSON versions stay paired.
  html = html.replace(/(var CONN_STAMP = ')(\d+)(')/, (_, a, n, c) => a + (Number(n) + 1) + c);

  return { conn, html, ics };
}

// Structural arm, deterministic half (R14/R18): rebuild a journey's legs in
// connections.json from the journey-matched candidate. Stops without an
// existing dialect mapping and unmapped line categories are ambiguous (R11).
export function applyStructuralJson(conn, journeyKey, candidateLegs) {
  const displayById = {};
  for (const j of Object.values(conn.journeys)) {
    for (const leg of j.legs) {
      displayById[leg.from.id] = leg.from.display;
      displayById[leg.to.id] = leg.to.display;
    }
  }
  if (conn.b313) { displayById[conn.b313.from.id] = conn.b313.from.display; displayById[conn.b313.to.id] = conn.b313.to.display; }
  const stops = (conn.meta && conn.meta.stops) || {};
  const resolveDisplay = (id, apiName) =>
    displayById[id] ?? stops[apiName] ?? stops[apiName.replace(/, (Bahnhof|staziun|Staziun)$/, '')] ?? null;
  const legs = candidateLegs.map((cl) => {
    const badge = BADGE_BY_CATEGORY[cl.category];
    if (!badge) throw new AmbiguousRepairError(`no badge mapping for category ${cl.category}`);
    const fromDisplay = resolveDisplay(cl.fromId, cl.fromName), toDisplay = resolveDisplay(cl.toId, cl.toName);
    if (!fromDisplay || !toDisplay) {
      throw new AmbiguousRepairError(`no dialect mapping for stop ${!fromDisplay ? cl.fromId + ' ' + cl.fromName : cl.toId + ' ' + cl.toName} (R11: issue, not commit)`);
    }
    return {
      from: { id: cl.fromId, api: cl.fromName, display: fromDisplay },
      to: { id: cl.toId, api: cl.toName, display: toDisplay },
      dep: cl.dep, arr: cl.arr,
      line: { category: cl.category, number: cl.number, display: lineDisplay(cl.category, cl.number), badge },
      platform: cl.platform,
      direction: cl.headsign || cl.toName
    };
  });
  const journey = conn.journeys[journeyKey];
  journey.legs = legs;
  journey.durationMin = journeyDurationMin(journey);
  return legs;
}
