# Dewsweeper 3D: architecture contract

Dewsweeper is a daily three-hole golf game played on a phone in portrait. The player stands behind the ball,
pulls down to set power, slides sideways to aim, lets go to swing, and the camera follows the ball.
This file is the contract every module is written against. If code and contract disagree, fix the code or
raise it with the chief designer; do not quietly change the contract.

## 1. Output and hard limits

- One self-contained page: `dist/index.html`, produced by `python3 build.py` (inlines CSS and JS in a fixed order).
- The only external script is three.js r128 (`THREE` global) from cdnjs. No other libraries, no external images,
  audio or data. Everything is procedural (canvas textures, shaders, WebAudio synthesis).
- The page runs inside a sandboxed frame: no alert/confirm/prompt, no downloads, no Web Share, no network calls.
  Audio may only start from a click handler. localStorage may throw; all access is wrapped in try/catch.
- Target: 60 fps on a mid-range phone. Budget for the whole frame: about 250k triangles, 60 draw calls,
  one 2048x4096 ground texture, no more than two full-screen passes. `DW.quality.tier === 'low'` must cut
  instance counts and skip optional passes.
- Shaders must work on mobile GPUs under WebGL2 and WebGL1: no reliance on float render targets,
  no `gl_FragDepth`, declare precision, keep hash/noise functions stable at `mediump` where they run in fragment shaders
  (prefer value noise from small textures over `fract(sin())` tricks on large coordinates).

## 2. Coordinates and units

- Game space: x east, y north, z up, in yards. Headings are radians clockwise from north; direction = (sin a, cos a).
- Three space: (x, z, -y). Always convert with `DW.P(vec3, x, y, z)`.
- The hole runs roughly north from the tee at (0, 0).

## 3. Source files, load order and owners

| # | File | Owns |
|---|------|------|
| 1 | `src/core3d.js` | `Core`: course generation, ground height, clubs, ball physics. No DOM, no three. |
| 2 | `src/engine.js` | `DW` namespace: renderer, scene, camera object, quality, events, module registry, storage, helpers. |
| 3 | `src/world-sky.js` | Sky dome, sun, lights, fog, distant ridges, far ground. May replace `DW.render` for a post pass. |
| 4 | `src/world-terrain.js` | Ground mesh, material and texture, tree shadows on the ground, pin, flag, cup, tee markers, pin distance tag. |
| 5 | `src/world-water.js` | Water surfaces. |
| 6 | `src/world-flora.js` | Trees and plants: the in-play trees from `hole.trees` plus decorative woods outside the bounds. |
| 7 | `src/world-fx.js` | Particles and ambient life (bursts on shot events, and anything that drifts or flies). |
| 8 | `src/player.js` | Ball, ball shadow, club, flight trail, aim preview (arc, landing ring, beam, run-out, blocked mark, aim tag), putting aids (green grid, slope beads). |
| 9 | `src/camera.js` | Camera director for every mode. Writes `DW.cam` and the camera transform. |
| 10 | `src/audio.js` | All sound. |
| 11 | `src/hud.js` (+ `src/style.css`, `src/index.template.html`) | All DOM UI: top bar, club bar, hints, hole banner, score-moment text, title, summary, mini-map, the 2D overlay canvas `#fx`. |
| 12 | `src/game.js` | State machine, input, round flow, persistence, hot reload, boot, debug API. |

Each file is one IIFE. Files talk to each other only through `DW` (below). A module never reaches into
another module's private objects.

## 4. The `DW` namespace (engine.js)

```
DW.THREE, DW.C (Core), DW.T (Core.T terrain enum), DW.$ (getElementById)
DW.renderer, DW.scene, DW.camera        three objects; camera.js sets the camera transform every frame
DW.W, DW.H                              stage size in CSS px
DW.pr                                   pixel ratio in use
DW.quality = { tier: 'high' | 'low' }   decided at boot; `?q=low|high` in the URL overrides
DW.reduced                              true when the viewer prefers reduced motion
DW.art                                  shared art constants (section 6); read-only for modules
DW.P(v, x, y, z)                        sets a THREE.Vector3 from game coordinates, returns v
DW.hole                                 current Core hole; DW.hole.ext = {x0,x1,y0,y1} is the ground-mesh extent
DW.MARGIN                               yards of ground drawn beyond the hole bounds (120)
DW.groundH(x, y)                        visual ground height: Core.heightAt inside the hole, easing to -2 well outside it
DW.project(x, y, z)                     -> {x, y} in CSS px, or null when behind the camera
DW.cam = { pos, look, yaw }             THREE.Vector3 pos/look in three space, yaw as a game heading; written by camera.js
DW.wind = { x, y, mph }                 unit direction the wind blows toward (game space) and its speed; mph 0 when calm
DW.time                                 seconds on the game clock
DW.store = { data, save() }             persisted object: { days, hints, muted, progress }
DW.on(evt, fn) / DW.emit(evt, payload)  event bus
DW.register(module)                     module = { name, order, init?(), buildHole?(hole), update?(dt), resize?(W, H) }
DW.buildHole(hole)                      game calls this: sets DW.hole, hole.ext, DW.wind, runs every module's buildHole in order, emits 'hole:build'
DW.frame(dt)                            game calls this every frame after advancing state: runs module updates in order, then DW.render()
DW.render()                             default renderer.render(scene, camera)
DW.world                                handoff registry between world modules: { shadowCasters: [] } (see section 7)
DW.G                                    game state, owned by game.js, read-only elsewhere (section 5)
DW.game                                 actions the UI may call: play(), practice(), replay(), setClub(id), advance(), shareText(), toggleSound()
DW.audio                                { init(), setOn(bool), isOn() }
```

Module `order` values: camera 10, sky 20, terrain 30, water 40, flora 50, fx 60, player 70, audio 80, hud 90.
`init` runs once at boot in that order; `buildHole` runs for every new hole (a module disposes its previous
hole's objects itself at the start of `buildHole`); `update(dt)` runs every frame in that order, after the game
has advanced and after camera.js has placed the camera.

## 5. Game state `DW.G` (read-only outside game.js)

```
mode        'title' | 'aim' | 'swing' | 'flying' | 'holed' | 'summary'
round, practice, hi (hole index 0..2), hole
ball        { x, y, z }  resting position
strokes, scores[], trails[]
club        'driver' | 'iron' | 'wedge' | 'putter'
opt         Core.clubOptions(hole, ball): { lie, dist, clubs: { id: { ok, max, sway } }, suggest }
base        default heading for this shot
aim         while a finger is down: { power 0..1, off (radians from base), sway (degrees) }, else null
pend        during 'swing' (club coming down): { off, power, t, dur }
shot        during 'flying': the Core shot object (x, y, z, h, vx, vy, vz, phase 'fly'|'drop'|'roll', club, done, result)
pv          current aim preview from Core.previewShot (plus pv.ang), or null
intro       seconds left of the hole-intro camera move
moment      during 'holed': { t, dur, diff, pickup }
fast        true when the player tapped to speed the ball up
follow      seconds left of the club follow-through after impact
```

## 6. Events

| Event | Payload | When |
|-------|---------|------|
| `boot` | – | all modules initialised |
| `title` | – | title screen shown |
| `hole:build` | hole | world for a hole is built |
| `hole:start` | { index, hole, resumed } | a hole begins |
| `aim:ready` | { opt, club } | the player may aim (hole start, and after every shot settles) |
| `club` | { club } | club changed |
| `aim:start` / `aim:cancel` | – | finger down / pull abandoned |
| `swing` | { club, power, off } | released; the club is coming down |
| `shot:start` | { club, power, angle, shot } | impact |
| `shot:event` | { type: 'land'\|'sand'\|'splash'\|'tree'\|'lip'\|'holed', x, y, z, shot } | during flight and roll |
| `shot:done` | { result, penalty } | ball at rest (or in water) |
| `hole:done` | { index, score, par, diff, name, pickup } | score moment begins |
| `round:done` | { scores, total, par } | third hole finished |
| `summary` | – | summary card shown |
| `mode` | { mode, prev } | any mode change |

## 7. Cross-module handoffs

- `DW.world.shadowCasters`: world-flora.js fills this array in `buildHole` with the Object3Ds that should cast
  ground shadows (the tree canopies). world-terrain.js may read it in its `'hole:build'` handler.
- DOM elements `#aim-tag` and `#pin-tag` exist in the template (styled by hud.js's CSS); player.js positions
  `#aim-tag`, world-terrain.js positions `#pin-tag`.
- `DW.art` holds the sun direction, fog colour and palette so that sky, ground, water and plants agree.

## 8. Core hole data (what renderers may rely on)

```
hole.par, hole.diff (0 gentle .. 2 hardest), hole.index, hole.yards, hole.drop (feet from tee down to cup)
hole.tee {x,y,z}, hole.pin {x,y,z}
hole.path [points]          centreline tee -> landing zones -> green centre; hole.legs [{a, len}]
hole.fairways [{pts, hw}]   polylines with half-width hw (round caps and joins)
hole.green [circles], hole.fringeW
hole.bunkers [[circles]], hole.water [[circles]]   each inner list is one bunker / one pond as a union of {x,y,r}
hole.ter.wl[i]              water level (z) of pond i
hole.trees [{x,y,r,H,z,tone,kind}]   footprint radius r, height H, base z, tone 0..1 (use for variety), kind 0 broadleaf / 1 conifer
hole.bounds {x0,x1,y0,y1}   play area; a wall of woods stands on it
hole.wind {mph,x,y}, hole.slope {x,y}
Core.terrainAt(hole,x,y) -> Core.T.*   Core.heightAt(hole,x,y)   Core.gradAt(hole,x,y)
```

Surface precedence where shapes overlap: green > bunker > water > fringe > tee > fairway > rough.

## 9. Debug and test hooks

`window.__dew = { DW, G, C, peek(dateKey, holeIndex), tp(x, y), swing(club, off, power), snapshot }`

- `peek` loads a hole in practice mode straight into aiming. `tp` moves the ball. `swing` plays a shot without input.
- URL: `?date=YYYY-MM-DD` picks the daily course, `?q=low|high` forces a quality tier.
- `test/lib.js` launches headless Chrome with software WebGL and serves three.js locally (see the file header).
  Software rendering runs at roughly 5-10 fps on this machine; game time is capped per frame, so wait on state, not on wall time.
