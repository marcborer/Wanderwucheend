# Fahrplan-Watchdog — operations guide

Nightly guard for the booked SBB connections on wanderweekend.marc-borer.ch.
It queries transport.opendata.ch for the exact booked journeys, diffs them
against `connections.json`, and **self-heals the site** by committing repairs
directly to main — after a validation gate proves the page is intact.
Active until 28.09.2026, then it disables itself; the October cleanup deletes it.

## What runs when

- `.github/workflows/watchdog.yml` — nightly ~05:23 CH time, plus manual
  `workflow_dispatch` (collaborator-only; the `api_base` input is a test
  override and must be https://).
- `.github/workflows/ci.yml` — tests + page integrity on every push/PR.

## The pipeline (one nightly run)

1. **Detect** (`watchdog/run.mjs` + `watchdog/lib.mjs`): fetch each journey
   (`hifaart` Sa, `tag2` So, `heimfaart` Mo) and the B313 stationboard;
   whitelist-validate the untrusted response; match "the booked journey"
   (same origin/destination ids, departure within ±30 min, unique candidate);
   classify the diff. Platform-only changes are debounced across two nights
   (waived within 3 days of travel).
2. **Repair**: value-level changes (times, platforms, line labels) are
   deterministic in-place substitutions via the `data-conn` anchors in
   `index.html`, plus `connections.json`, the countdown literal, and the .ics.
   Structural changes (legs added/removed/replaced — like the 18.8. EV1 swap)
   update the JSON deterministically; the card prose is rewritten by a
   tool-restricted claude-code-action step per `watchdog/structural-prompt.md`.
3. **Gate** (`watchdog/gate.mjs`): file allowlist, hunks confined to anchored
   regions, no new parse5 errors, card re-diff clean, inline JS `node --check`,
   .ics structure, countdown validity. Any failure → issue, **no commit**.
4. **Commit + notify** (`watchdog/post-repair.mjs`): commit with per-leg
   old→new message, rebase-once push, explicit Pages build request, comment on
   the pinned "🐕 Watchdog" tracking issue, and one consolidated follow-up
   issue for the SBB app share links (only a human can regenerate those).

## Issues you might see

- **🚆 Fahrplan-Änderig entdeckt** — ambiguous cases or B313 pattern breaks
  that need a human decision.
- **⛔ Reparatur vom Gate gstoppt** — a repair failed validation and was NOT
  committed; apply the change manually.
- **🔗 SBB-Share-Links nöi generiere** — a repair landed; regenerate the
  marked share links in the SBB app.
- **🙈 Watchdog isch blind** — two consecutive failed nights; the API is down
  or broken. Auto-closes when it recovers.
- **🐕 Watchdog — Fahrplan-Überwachig** (pinned) — repair comments; in the
  final week (from 19.9.) every run heartbeats here. **Silence in the final
  week means the scheduler died, not that all is well.**

## State

`.github/watchdog-state.json` (committed): `{ schema: 1, failures, pending,
lastRun, trackingIssue?, blindIssue?, lastDiffIssue?, lastIssueHash? }`.
`failures` = consecutive failed nights (2 → blind issue). `pending` =
platform-change debounce counters. Missing file = first run; **corrupt file
counts as a failed run** (never a silent reset). If it is corrupt, delete it —
the counters restart, which is safe.

## Local testing

```bash
node --test watchdog/lib.test.mjs watchdog/repair.test.mjs   # unit tests
node watchdog/check-page.mjs                                 # page integrity
npm ci && node --test watchdog/page.smoke.test.mjs           # jsdom page smoke
WATCHDOG_DRY_RUN=1 node watchdog/run.mjs                     # full detect, gh calls printed
node watchdog/gate.mjs                                       # gate against working tree
```

The page itself: `python -m http.server` and open
`http://localhost:8000/index.html?fake-date=2026-09-27T09:00` (Zurich
wall-clock; any DURING instant previews the "Hüt" hero).

## Recovery

- Bad auto-commit: `git revert <sha>` — every repair is a single commit whose
  message lists old→new per leg.
- Manual timetable edit: change `connections.json` AND the card values
  together (CI's re-diff fails otherwise), bump `CONN_STAMP` in `index.html`.
- Secrets: `ANTHROPIC_API_KEY` repo secret (spend-capped; rotate after the
  trip). The workflow authenticates with `GITHUB_TOKEN` only.
