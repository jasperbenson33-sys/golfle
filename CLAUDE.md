# Dewsweeper (repo: golfle)

Daily three-hole 3D golf game for phones. Single HTML file, three.js r128, everything procedural.
**Read `docs/HANDOFF.md` first.** It has the state of the work, the owner's rules, and the next steps in order.
Specialists writing effect modules read `docs/BRIEF.md`.

- Build: `python3 tools/build.py` (live `src/` + all `fx/` modules -> `dist/index.html`); see the file header for `--from base --fx name --out`.
- Look: `node tools/view.js --html dist/index.html --scene address --out shots/x.png` (header lists scenes). Needs Playwright + Chrome; paths are hard-coded near the top of the tool.
- Bots: `node test/bot3d.js 30`.
- Keep usage low: at most two or three subagents at once, finish and publish one piece before starting the next.
