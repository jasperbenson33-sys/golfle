# Dewsweeper 3D — brief for effect-module authors

Read this whole file before writing code. It is the contract between your module and the game.

## 1. The game and the goal

Dewsweeper is a daily golf game for phones (portrait), played in a browser. Three holes a day, the same course
for everyone, about three minutes a round. You stand behind the ball, pull back and release to swing, the camera
follows the ball through its flight, you putt out. It already plays well. The job now is to make it **beautiful and
seamless**: the player should feel transported to a quiet course at first light.

You are one of several specialists, each owning **one module file**. A director integrates the modules. Your work
must look like it belongs to the same world as everyone else's, so follow the art direction below closely.

## 2. Art direction

**First light on a parkland course in late autumn.** The sun is low in the north-east, the shadows are long and
soft, there is dew on the grass and a thin mist lying in the hollows. A few trees have turned amber and rust.
It is quiet. Nothing is in a hurry.

- **Stylised, not photoreal.** Low-poly forms with clean silhouettes, flat or softly graded facets, gentle
  gradients. No noisy photographic textures, no hard specular plastic, no neon. Think of a calm, hand-made
  diorama lit by a real morning.
- **Calm motion.** Everything that moves does so slowly and continuously: leaves drift, grass leans, water
  breathes, mist slides. Nothing flickers, pops, strobes or loops visibly. If in doubt, halve the speed and amplitude.
- **Light.** Warm where the sun reaches, cool blue-green in shade. Keep contrast gentle. Brightest things in a
  frame should be the sun's glow, the ball, the flag.
- **Restraint.** One beautiful idea done precisely beats five effects fighting for attention. The golf must stay
  readable: the ball, the pin, the fairway edges, water and sand must always be easy to see.

Palette (display-space hex, used as-is; the renderer does no gamma conversion):

| Thing | Colours |
|---|---|
| Haze / fog / horizon | `#E3E6D3` (this is `scene.fog` and must be what the sky fades to at the horizon) |
| Sky | horizon `#E3E6D3` → mid `#BDD8E6` → zenith `#79AEDB`; warm tint toward the sun `#FFD9A2` |
| Sun glow | `#FFFCEB` core, `#FFE296` halo |
| Rough | `#6F9B62` · woods floor `#4C7550` |
| Fairway | `#9BC878` / `#A8D284` (mowing stripes) · fringe `#A2CE80` |
| Green | `#B4DE90` / `#BDE59A` |
| Sand | `#EDE3BE` |
| Water | `#6FA6C2` mid, `#4F8FAE` deep, sky-pale toward the horizon |
| Trees | greens around HSL(0.34, 0.36, 0.27–0.36), conifers darker and bluer; autumn `#C98A32 #B5572C #D8A63C #A94A2B #CF7A2E` |
| Trunks | `#5A4A3B` |
| Interface | pine `#173326`, mist white `#EEF4EA`, sun gold `#F2C768`, flag red `#D5432D` |

## 3. Where things are, and what you may touch

```
/home/claude/dew3d/
  base/            FROZEN copy of the game. Read it, never edit it.
    core3d.js        course generation, hills, clubs, ball physics (no DOM). Global `Core`.
    ui3d.js          the game: world, camera, input, HUD. Look here to see how the defaults are built.
    style.css, index.template.html
  fx/<name>.js     YOUR module. This is the only file you create or edit (plus your own screenshots).
  tools/build.py   builds a single-file page
  tools/view.js    renders a built page headlessly and saves screenshots
  tools/holes.js   prints a day's hole layouts (coordinates of tee, pin, water, bunkers)
  shots/<name>/    put your screenshots here
  vendor/three.min.js   three.js r128, used by the tools
```

Rules: edit **only** `fx/<name>.js` (the name is given in your task). Do not edit `base/`, `src/`, `tools/`,
other modules, or anything outside `/home/claude/dew3d`. Do not delete files. Other agents are working in the
same folder at the same time on other modules.

## 4. Build and look at your work

```bash
cd /home/claude/dew3d
# build the frozen game + only your module, into your own output file
python3 tools/build.py --from base --fx <name> --out dist/dev-<name>.html
# look at it (see the header of tools/view.js for every option)
node tools/view.js --html dist/dev-<name>.html --date 2026-11-12 --hole 0 --scene address --out shots/<name>/address.png
node tools/view.js --html dist/dev-<name>.html --date 2026-11-12 --hole 0 --scene flight --times "0.5,1.8,3.2" --out shots/<name>/flight.png
node tools/view.js --html dist/dev-<name>.html --date 2026-11-12 --hole 1 --scene green --out shots/<name>/green.png
node tools/view.js --html dist/dev-<name>.html --date 2026-11-12 --hole 2 --scene free --cam "-60,430,14,-100,505,-3" --out shots/<name>/pond.png
node tools/holes.js 2026-11-12 --from base      # coordinates for placing a free camera
```

- `view.js` prints `no page errors` or the errors and warnings from the page. **Zero errors is required.** It also
  prints draw calls and triangles (`info`), which is how you check your budget (compare against `dist/dev-base.html`,
  the game with no modules).
- Then open the PNG with your image-reading tool and actually look at it. Iterate until it is beautiful. Check at
  least: address view, mid-flight, the green, one free-camera hero shot of your feature, and the title screen.
- Rendering in the tool is software WebGL2: slow (5–12 fps) but correct. Game time runs slower than wall time
  there; `view.js` keys captures to game time. Use a `timeout` of 120–180 s per run. Several agents share this
  machine, so keep runs short and do not loop screenshots needlessly.
- To see animation, capture `--frames 3 --every 1500` and compare.
- Holes with water (date, hole index): `2026-11-12 2` pond beside the green at (-102,505); `2026-11-13 1` pond at a
  fairway corner (12,229); `2026-11-13 2` pond in front of a par-3 green (-7,83); `2026-11-17 1` creek across the
  fairway near (-38,333); `2026-11-21 2` two ponds. `2026-11-12 0` is a calm par 4 with no water.

## 5. Platform constraints (hard)

- The game ships as **one HTML file**. three.js **r128** is a global (`THREE`, UMD build). Nothing else loads:
  no ES modules, no `import`, no three "examples" (no EffectComposer, OrbitControls, Water, Sky, Lensflare,
  BufferGeometryUtils …), no images, fonts, sounds or JSON from the network. Make textures procedurally
  (2D canvas → `THREE.CanvasTexture`, or in the shader). Write plain browser JavaScript (ES2018 is fine).
- **Phones first.** Portrait, about 390×780 CSS px, pixel ratio up to 2. Mid-range phone GPUs. Budgets for the
  whole game: ≤ 350k triangles, ≤ 70 draw calls, 60 fps. Your module's share is in your task. No render targets,
  no post-processing passes, no shadow maps, no per-frame geometry rebuilds, no per-frame allocations
  (`new` in `update` is a bug). Animate in the vertex/fragment shader from a time uniform wherever possible.
- **Overdraw kills phones.** Large transparent surfaces must be few (count them). Prefer opaque + alphaTest, or
  small additive sprites.
- GLSL must work under **WebGL1 and WebGL2** through three's `ShaderMaterial` (write GLSL ES 1.0 style: `attribute`,
  `varying`, `texture2D`, `gl_FragColor`; three converts for WebGL2). No `#version` line. Loops need constant
  bounds. Use `precision highp float` only if needed in the fragment shader (three adds a default).
- Never throw from `update` or `onEvent`. Guard optional things. The host wraps your hooks in try/catch and logs
  the first error, but an erroring module is a failed module.
- Respect `ctx.reduced` (the player asked for reduced motion): keep things still or very slow.
- Use `ctx.quality` (0 low, 1 standard = most phones, 2 high) to scale counts.
- No DOM, no HUD, no CSS: the interface is not yours. No `console.log` spam.
- Everything seeded: use `Core.makeRng(Core.hashStr('your-seed' + hole.yards))` (see §8) instead of
  `Math.random()` for layout, so the same hole looks the same for every player. (`Math.random` is fine for
  particle jitter.)

## 6. Coordinates and units

- Units are **yards**; time is seconds.
- **Game coordinates:** `x` east, `y` north, `z` up. Holes run roughly north: the tee is at (0,0), the green
  several hundred yards up +y.
- **three.js coordinates:** `(x, z, -y)`. Use `ctx.P(vec3, x, y, z)` to set a `THREE.Vector3` from game
  coordinates. So "up" in three is +Y, and north is −Z.
- Headings are radians **clockwise from north**: direction = `(sin a, cos a)` in game x,y.
- Ground height anywhere: `ctx.C.heightAt(hole, x, y)` (z in yards). Gradient: `ctx.C.gradAt(hole, x, y)` → `{x, y}`.
  Outside the hole bounds the visible mesh eases to a level plain; use `ctx.meshH(hole, x, y)` for the height of
  the **drawn** ground (same as `heightAt` inside the hole).

## 7. The module API

Register before the game starts by pushing an object onto `window.DewFX` at the top level of your file:

```js
(function () {
  'use strict';
  var S = {};                         // your state
  window.DewFX = window.DewFX || [];
  window.DewFX.push({
    name: 'water',
    replaces: ['water'],              // optional: default pieces you take over (see the list below)
    init: function (ctx) {},          // once, after renderer/scene exist. Create persistent objects, add to ctx.scene.
    onHole: function (ctx, hole) {},  // every time a hole is built. Add per-hole objects to ctx.holeGroup.
    update: function (ctx, dt) {},    // every frame. dt seconds, capped at 0.05.
    onEvent: function (ctx, type, data) {}   // game events, see below
    // ground module only:
    // paintTerrain: function (ctx, hole, g, info) {},   // draw extra detail into the terrain colour map
    // terrainMaterial: function (ctx, map, info) { return material; }
  });
})();
```

`ctx.holeGroup` is a `THREE.Group` that the host **removes and disposes** (geometries, materials, `material.map`)
when the next hole is built, so per-hole objects need no cleanup. Persistent objects go on `ctx.scene`. Keep
`onHole` fast (well under 100 ms on a phone).

**Replaceable defaults** (`replaces`):

| name | what the host stops drawing | what you must then provide |
|---|---|---|
| `sky` | sky dome, sun glow sprite, the two distant ridgelines | all of those. Not the fog, lights, or far ground plane (those stay) |
| `water` | flat discs at each pond's level | the water surface for every pond in `hole.water` |
| `trees` | instanced canopies and trunks for `ctx.trees` | every tree in `ctx.trees` (in-play and background) |
| `club` | the club in the player's hands | a club model driven by `ctx.club` |
| `trail` | the white line behind the ball in flight | a ball trail driven by `ctx.ball` |
| `particles` | small point bursts on landing, sand, splash, tree | impact effects from events |

**`ctx` fields** (read-only unless noted):

```
THREE, C (= Core), scene, camera, renderer, PR (pixel ratio), P(vec3, x, y, z)
quality (0|1|2), reduced (bool)
sunAz, sunEl            visual sun: azimuth 0.92 rad clockwise from north (north-east), elevation 0.26 rad
sunH {x,y}              horizontal unit vector toward the sun, game coords
sunDir                  THREE.Vector3 unit vector toward the visual sun, three coords
lightDir                THREE.Vector3 unit vector toward the shading light (same azimuth, 40° elevation)
fogColor (THREE.Color #E3E6D3), fog (the scene's THREE.Fog: near 170, far 1500)
time, dt                seconds
mode                    'title' | 'aim' | 'swing' | 'flying' | 'holed' | 'summary'
hole, holeGroup, ext    current hole, its group, and the drawn ground's extent {x0,x1,y0,y1} (hole bounds + 120 yd)
trees                   every tree for this hole: {x, y, z, r, H, tone, kind, play}
                          z ground height, r canopy radius, H height, tone 0..1 random, kind 0 broadleaf / 1 conifer,
                          play true = in play (the ball collides with a cylinder of radius r, height H), false = background woods
meshH(hole, x, y)       height of the drawn ground
wind {x, y, mph}        direction the wind blows TOWARD (unit, game coords) and speed 0..15
ball {x, y, z, h, visible, moving, speed, phase, club}
                          game coords of the ball centre; h = height above ground; phase 'fly'|'roll'|'drop'|'rest'
club {visible, id, angle, phi, hands, head}
                          id 'driver'|'iron'|'wedge'|'putter'; angle = aim heading; phi = swing angle (0 at address,
                          up to +1.9 at the top of the backswing, to about -1.7 in the follow-through);
                          hands, head = THREE.Vector3 in three coords (grip end and centre of the club head)
camPos, camLook         THREE.Vector3, three coords
viewW, viewH            CSS px
```

**Events** (`onEvent(ctx, type, data)`), positions in game coords:

```
'aim'     {active}                      the player started / stopped pulling back
'strike'  {club, power, x, y, z, lie, dir:{x,y}}     club meets ball (power 0..1)
'land'    {x, y, z, lie, club, speed}   first touch-down after flight (not sand or water)
'sand'    {x, y, z, ...}                plugged in a bunker
'splash'  {x, y, z, ...}                into water
'tree'    {x, y, z, ...}                knocked down by a tree
'lip'     {...}                         lipped out of the cup
'holed'   {x, y, z, ...}                dropped in the cup
'rest'    {x, y, z, lie, kind}          the shot is over
'score'   {diff, name, pickup}          hole finished; diff = strokes − par
```
`lie` / terrain types: `Core.T = { ROUGH:0, FAIRWAY:1, FRINGE:2, TEE:3, GREEN:4, SAND:5, WATER:6 }`.

**Sound module** (only `fx/audio.js`): define `window.DewAudio = function (opts) { return {...}; }` instead of
pushing to `DewFX`. Details are in that task.

## 8. The world you are decorating

How the host builds things (read `base/ui3d.js`, function `buildHole`, for the exact code):

- **Ground:** one grid mesh (name `'terrain'`, ~60k vertices) over `ctx.ext`, UVs 0..1 across the extent, with a
  painted colour map (2D canvas 2048×2048 or 2048×4096, repainted per hole) on a `MeshLambertMaterial`.
  Tree shadows are **painted** into that map as long soft ellipses pointing away from the sun. There are no
  shadow maps.
- **Lights:** `HemisphereLight(0xE8F2FF, 0x7A9A66, 0.66)` + `DirectionalLight(0xFFF1D6, 0.58)` from `ctx.lightDir`.
  Do not add, remove or change lights or fog.
- **Renderer:** default (linear) output encoding, antialias on. Colours you author are the colours on screen.
- **Camera:** perspective, vertical FOV 62°, near 0.25, far 9000. At address it is ~4.3 yd behind and 1.8 yd
  above the ball, so the ground within a few yards is seen very close; in flight it chases the ball; on the green
  it sits 3–10 yd behind the ball, 2–7 yd up.
- **Far ground:** a flat plane at z = −2.05 out to the horizon (colour `#55805A`, fogged). Beyond ~1500 yd
  everything is fog colour.

**Hole object** (`ctx.hole`), all in game coords:

```
par, yards, diff (0 opener, 1, 2 finisher), index
tee {x,y,z}, pin {x,y,z}
path [ {x,y}, ... ]                  centre line: tee → landing zone(s) → green centre
legs [ {a, len}, ... ]               heading and length of each leg
fairways [ {pts:[{x,y}...], hw} ]    centre polyline and half-width (fairway = within hw of the polyline)
green [ {x,y,r}, ... ]               union of circles; fringeW = 2.6 yd ring around it
bunkers [ [ {x,y,r}, ... ], ... ]    each bunker is a union of circles
water [ [ {x,y,r}, ... ], ... ]      each pond/creek is a union of circles; ter.wl[i] = that pond's flat water level (z)
trees [ {x,y,z,r,H,tone,kind} ]      in-play trees only (ctx.trees also has the background woods)
bounds {x0,x1,y0,y1}                 playable area; the border is ringed with trees
wind {mph, x, y}, slope {x,y}        wind toward; downhill pull on the green
gbox {x0,x1,y0,y1}                   bounding box of the green
```
The ground is carved to sit below `wl[i]` inside each pond and rises to the bank outside it, so a level surface
at `wl[i]` is only visible inside the pond's outline plus a yard or so of shoreline.

**Core helpers** (`ctx.C`): `terrainAt(h,x,y)` → `Core.T` type; `heightAt`, `gradAt`; `inCircles(list,x,y,pad)`;
`sdCircles(list,x,y)` signed distance to a union of circles (negative inside); `distToPolyline(pts,x,y)`;
`dist(a,b)`; `clamp`, `smooth(a,b,v)` (smoothstep); `makeRng(seed)` → `rng()` in [0,1) with `rng.range(lo,hi)`,
`rng.int(lo,hi)`, `rng.chance(p)`, `rng.pick(arr)`, `rng.sign()`; `hashStr(s)`.

## 9. Fog in custom shaders

Anything in the world must fade into the haze like the built-in materials do. For a `ShaderMaterial`:

```js
var mat = new THREE.ShaderMaterial({
  fog: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
  vertexShader: [
    '#include <fog_pars_vertex>',
    'void main(){',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}'].join('\n'),
  fragmentShader: [
    '#include <fog_pars_fragment>',
    'void main(){',
    '  gl_FragColor = vec4(0.4, 0.65, 0.76, 1.0);',
    '  #include <fog_fragment>',
    '}'].join('\n')
});
```
To extend a built-in material instead (often the best route for lit, instanced things), use
`material.onBeforeCompile = function (shader) { ... }` and patch `shader.vertexShader` / `shader.fragmentShader`
around chunks such as `#include <begin_vertex>` (r128 chunk names). Instancing exposes `instanceMatrix` and
`instanceColor` in the vertex shader. Keep a reference to `shader.uniforms` to update your time uniform.

## 10. What to hand back

1. `fx/<name>.js`, starting with a comment block: what it draws, which defaults it replaces, its hooks, its cost.
2. A short report as your final message: what you built; draw calls and triangles added (from `view.js` info,
   versus `dist/dev-base.html` on the same hole and scene); the screenshot files worth looking at; anything you
   are unsure about or that the director should tune (list the tunable constants at the top of your file).
3. Proof: `view.js` output showing `no page errors` for address, flight, green and title scenes with your module.

Quality bar: a player on a phone should think "that's lovely" and never "that's a glitch". If a feature cannot be
made both beautiful and cheap, leave it out and say so.
