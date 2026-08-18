# Structural card rewrite — instructions for the AI repair arm

You are rewriting the leg rows of one or more travel cards in `index.html`
because the booked SBB routing changed structurally (a leg was added, removed,
split, or replaced — e.g. a train replaced by an Ersatzbus). The deterministic
repair has ALREADY updated `connections.json`; your only job is to make the
affected card's HTML match it, in the site's dialect and style. A validation
gate diffs your output against `connections.json` and rejects anything outside
the card regions — so precision matters more than creativity.

## Inputs

- `.structural-changes.json` — which journeys changed, with their new legs and
  `durationMin` (already reflected in `connections.json`)
- `connections.json` — the source of truth for every value you write
- `index.html` — edit ONLY between `<!-- conn:<journey>:start -->` and
  `<!-- conn:<journey>:end -->` for the journeys listed in the changes file

## Card conventions (copy the existing cards' structure exactly)

One `.travel-leg` per transit leg, in order. A leg with departure time:

```html
<div class="travel-leg">
  <div class="travel-time" data-conn="<journey>.<i>.dep">HH:MM</div>
  <span class="travel-line-badge badge-<badge>" data-conn="<journey>.<i>.line">LINE</span>
  <div class="travel-desc">
    <div class="t-from">FromDisplay → ToDisplay</div>
    <div class="t-to"><span data-conn="<journey>.<i>.platform" data-conn-prefix="Gleis ">Gleis N</span>, Richtig DirectionDialect</div>
  </div>
</div>
```

Rules:
- `<i>` is the leg's index in `connections.json` (0-based, transit legs only).
- Time, line display, and platform values must equal `connections.json` exactly
  (`legs[i].dep`, `legs[i].line.display`, `legs[i].line.badge`, `legs[i].platform`).
- Platform prefix: `Gleis ` for trains, `Kante ` for buses (category `B`); when
  `platform` is null, write no platform span — the `t-to` line carries only the
  direction or a short dialect note (see the EV1 leg: "Ersatzbus, Richtig Küblis").
- Station names in prose use the `display` fields (dialect: Zwinge, Cuira,
  Tavau Dorf, Loufe …), never the official API names.
- Direction ("Richtig …") is dialect too — translate the `direction` field the
  way the existing cards do (Olten → "Richtig Olte", Nunningen → "Richtig
  Nuninge", St. Moritz → "Richtig San Murezzan").
- The first row of the card (origin + departure) and the final row
  (🏁 arrival + `Faarzit total: <span data-conn="<journey>.durationText">X Std. Y Min.</span>`)
  keep their existing shape; `durationText` = `durationMin` as "X Std. Y Min.".
- The last transit leg's arrival is anchored on the final row's time:
  `data-conn="<journey>.<last>.arr"`.
- Keep the marked share link (`… ⚠️ (Link wird no aktualisiert)`) as it is.

## Voice

Swiss German dialect as on the rest of the page — short, warm, no High German.
When a leg is an Ersatzbus, say so the way the page already does ("Ersatzbus,
Richtig …"). Do not add commentary, emojis beyond the existing ones, or any
content outside the card regions.

## Hard limits

- Edit only `index.html`, only inside the listed journeys' comment regions.
- Never touch `connections.json`, the `.ics`, the countdown, or other sections.
- Do not run git commands (they are not available to you); the workflow
  validates and commits your working-tree edit.
