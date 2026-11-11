# Dewsweeper: handoff (11 Nov 2026)

## What this is
A daily golf game: three holes a day (par 3, 4, 5 in shuffled order, par 12), same course for everyone, seeded by local date.
Phone, portrait. You stand behind the ball, pull down for power, slide sideways to aim, let go to swing; the camera follows the ball.
Share card is one emoji tile per shot. Working name Dewsweeper. Owner: Jasper.

Two versions exist:
- `topdown/` — the first, 2D top-down MVP. Saved on purpose as a possible simpler spin-off. Leave it alone.
- repo root — the 3D game. All current work is here.

Published pages (Claude artifacts, owner-only): "Dewsweeper Daily Golf" (top-down) and "Dewsweeper 3D Golf".
The live 3D page is the version *before* everything listed under "In progress": calmer aiming, longer roll, nothing else.

## The owner's standing rules
1. Round length (three holes) is right. Pull-back-and-release is right; aiming must be calm, not twitchy (done: power = vertical pull only, aim = sideways travel on a gentle curve, both smoothed, lift-off twitch ignored).
2. On-course 3D view, not from above. See the ball's arc, see the club, four clubs to pick (driver, iron, wedge, putter; the game suggests one), sky and scenery, camera follows the ball.
3. Hills affect play. Portrait. First-person ball-and-club view.
4. Rollout: wanted more, twice. Current `src/core3d.js` already has the second increase (not yet published). Do not raise again without asking.
5. **Never a hole where the driver is used at full capacity more than once.** Decision: driver is tee-only.
6. **Harder holes come from obstacles and hilliness, never from sheer length.**
7. Name and wind are fine for now.
8. Goal now: "absolutely gorgeous and seamless", effects like lens flare, water ripples, swaying grass and trees, wind carrying fall leaves. He asked for a team of agents.

## Layout
```
src/core3d.js        Core: course generation, ground height, clubs, physics. No DOM. IN PROGRESS (see below).
src/ui3d.js          the game host: world, camera, input, HUD, flow. Has the module hooks (window.DewFX, window.DewAudio).
src/style.css, src/index.template.html
base/                frozen snapshot of src/ that module authors build against. Core here is the OLD generator.
fx/<name>.js         effect modules (see docs/BRIEF.md for the API). All five are FIRST DRAFTS, never run.
tools/build.py       builds one HTML file; tools/view.js screenshots scenes; tools/holes.js prints layouts; tools/audio-check.js (draft)
test/bot3d.js        bots that play generated courses (fairness, scoring spread). play3d.js / chaos3d.js drive the page via Playwright.
docs/BRIEF.md        contract + art direction for module authors
docs/core-gen-draft.js   director's draft of the new hole generator (already merged into src/core3d.js by the architect, untested)
docs/archive/        an abandoned full-modularisation plan; ignore
vendor/three.min.js  r128, for tests (page loads it from cdnjs)
```

## In progress when work stopped (usage limit hit twice; nothing below is tested)
- **Course redesign** in `src/core3d.js` (uncommitted diff vs the first commit is large): plan-based holes (`choosePlan`, names like "Lakeside", "Peninsula green"), tee-only driver, three-shot par 5s of about 450-525 yd, `ter.tilt` and `ter.bumps`, `regulationOK`, `pathRem`. It loads and generates. NOT done: bot run (`test/bot3d.js` still assumes driver off the fairway), tuning, `tools/maps.js` contact sheet, host edits (driver button "Tee only", hint text, hole name in banner), build + view check. The full task spec is in "Architect task" below.
- **fx/sky.js, ground.js, trees.js, water.js, audio.js**: each agent wrote a first version and was cut off before building or looking at it. They pass `node --check` only. Each needs: build on base (`python3 tools/build.py --from base --fx NAME --out dist/dev-NAME.html`), screenshots, iteration, budget check.

## Next steps, in order (publish after each)
1. Finish and verify the course redesign; build with `--fx none`; publish. This is what the owner asked for most directly.
2. Bring modules to finished one or two at a time: trees and ground first (largest visual gain), then sky, water, audio. After each, build `src` + finished modules, look at address / flight / green / title, publish.
3. Second wave, not started: `fx/grass.js` (swaying grass near the camera, never hiding the ball), `fx/life.js` (drifting leaves with the wind, motes, birds; replaces the host's 2D birds on score moments), `fx/strike.js` (`replaces: ['club','trail','particles']`: better club models, ball trail ribbon, impact effects).
4. Host polish in `src/ui3d.js`: camera choreography (intro, flight, landing, putt, score moment), aim visuals, HUD and onboarding, a quality toggle. One editor at a time on this file.
5. Then refresh `base/` from `src/` so later module work sees the new course generator.

## Architect task (step 1 spec)
- Driver `ok` only when lie is TEE (max 225). Suggest wedge if d <= wedgeFull*1.03, iron if d <= iron.max*1.07 or driver not allowed, else driver.
- Par 3: 110-165 yd, wedge or iron. Par 4: first leg 236-258, second 75-135. Par 5: 236-258, 150-176, 62-92.
- Difficulty by hole index (diff 0,1,2) from features: pond carry, pond beside green, peninsula green, water on a dogleg corner, creek before green, creek splitting a par-5 fairway, pond fronting a par-5 green, long lake down one side; cross bunkers, run-through bunker, pot bunkers; guard groves inside doglegs; narrower fairways, smaller greens, more tilt; bigger swells, overall climb/fall, plateau greens, drop-shot tees, mounds and hollows. Hole 1 stays calm.
- One prevailing wind per day. Every hole must pass `regulationOK` (green reachable in par-2 strokes, still air, driver only from the tee).
- Keep the hole data contract (BRIEF section 8) plus new `name`. No new surface types.
- Acceptance: `node test/bot3d.js 30` clean (0 invalid, 0 stuck, full-power driver swings per hole never above 1), round generates in under ~150 ms, expert par-5 eagles under 15%, regular bot about -2..+1 per round, newbie about 0..+4. Tune features, not length.
- Small host edits: "Tee only" under the driver off the tee; remove "No driver from here" from the rough hint; hole name in the banner.

## Environment notes
- The tools assume Playwright at `/opt/npm-tools/node_modules/playwright` and Chrome at `/usr/bin/google-chrome` with software WebGL flags; adjust for the local machine.
- Artifact pages only allow scripts from cdnjs/jsdelivr/unpkg, no network calls, audio only from a click, no downloads or Web Share.
- An earlier pass left `src/ui3d.js` with the DewFX hook system; that is the architecture in use. Do not re-architect.
