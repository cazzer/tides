# perf-audit

In-page GPU cost and pixel-identity checks for tides. This is the harness behind the phone-efficiency audit
(bead tides-0oi.2), and the top-10 on tides-0oi points at it. Use it to:

- re-prove that a change is exact (0 px), and
- measure its gain at the phone viewport.

For frame-time profiles on a real phone, use `scripts/phone-perf/` on s02/perf-device.

| File | What it is |
|---|---|
| `lib.cjs` | The harness. Opens headless Chrome with ANGLE-Metal (390x844 at dpr 3, which the app caps to a 780x1688 canvas), poses the camera, records one frame's `gl.render` calls and replays them. Provides interleaved paired A/B timing, same-tick pixel diffs, a per-object breakdown, a VRAM log, a CPU profile, and a shared GPU lock. |
| `ab.cjs` | CLI: same-tick pixel A/B/A2 and paired timing for named shader variants at one pose. |
| `variants/top10.cjs` | The exact shader-text variants behind the top-10's shader items: clouds-1, aurora gate, aurora noise floor, ground detail gate, night water, plus skip controls. |
| `body-maps.cjs` | Ship-mode body maps (tides-0oi.7): resident texture memory at named poses, same-tick A/B of the mip-tail proxies against their full maps, and approach runs that log the switch to a full map. |
| `curtain.cjs` | tides-0oi.5's proof: the aurora curtain bake against the live noise (pixels, quality against a 128-step reference, timing per STEPS, board composites). |
| `glow-pass-only.js` | In-page helpers for timing the glow pass. Frame replay is invalid on glow=1 frames. |
| `glow-ab.cjs` | CLI: same-tick pixel A/B/A2 and paired wall timing of the real glow pass with one of its `glowPassSwitches` off (scissor, depth invalidate, compact targets), plus a no-glow control and board composites (tides-0oi.15). |
| `cold-start.cjs` | CLI: the cold start's longest main-thread block, from a CDP Profiler run started before the page loads, with each program's first use, the Sun bake's first face, mip passes and the loading screen's reveal (tides-0oi.6). |

## Setup

1. Serve the app with the pose hooks. `lib.cjs` drives `window.__mainPose`, `__ship` and `__shipPose`. These are
   added at transform time by `scripts/phone-perf/vite.config.mjs`, which is on s02/perf-device and isn't
   duplicated here. Start the dev server from the repo root, using its own cache so it doesn't race other vites:
   ```bash
   npx vite --config scripts/phone-perf/vite.config.mjs --port 5391 --strictPort
   # with parallel worktrees, wrap it to set cacheDir (see bd memory tides-vite-shared-dep-cache)
   ```
   `lib.cjs` uses the build's `window.__ppHandles` when present, or the dev server's module URLs otherwise. Both
   work. Point it elsewhere with `BASE_URL=http://host:port/tides/` (default `http://localhost:5391/tides/`).
2. `playwright-core` isn't a tides dependency. Set `PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core`. Chrome
   is the newest `~/Library/Caches/ms-playwright/chromium_headless_shell-*`, or set `CHROME=<exe>`.

## A shader change: exact? how much?

```bash
cd scripts/perf-audit
VARIANTS=auroraStormGate,auroraSkip POSE='{"lat":65,"lon":120,"km":400}' \
  PARAMS='{"t":"2026-03-20T15:00:00Z"}' node ab.cjs
```

Example output, from the M4 at the phone viewport (2026-11-05):

```
pixels auroraStormGate  A vs A2 {"px":0,...}  A vs B {"px":0,...}
timing base             gpu 4.96 ...
timing auroraStormGate  ... dGpu -2.439 dWall -2.438
```

### Pixels

For each variant, one `page.evaluate` renders base, the variant, then base again, with no rAF in between, and reads
back the whole canvas each time.

- **A vs A2 must be 0.** If it isn't, the pose isn't frozen; `ab.cjs` calls `__H.freeze()`, which pins sim time
  and cloud drift.
- **A vs B** isolates the change.
- **Always run a control.** Add a variant that visibly changes the pose, such as `cloudSkip` or `auroraSkip`, to
  prove the code path is on screen. A 0 px result with a control that also reads 0 px proves nothing.

### Timing

`__H.ab` interleaves the variants and rotates their order each round. Each round renders the recorded frame K times
between `readPixels` syncs. Read `dGpu`/`dWall`: the median of the per-round differences against base.

- **Noise:** about ±0.05-0.1 ms when the GPU is quiet. Under other sessions' headless browsers it can reach ±0.3.
  Don't compare numbers across pages or runs.
- **Multi-pass frames** (extra render targets, such as the glow): ANGLE-Metal's timer over-reads them, so trust
  `dWall`.

### Hits

The run prints `hits` per variant. A variant that made 0 replacements no longer matches the shader. Fix its text in
`variants/*.cjs` before believing any result. Write your own variants file in the same shape and point `VARFILE` at it.
A pair's `from` is a string (every occurrence) or `{ re, flags }`.

### Env

- `POSE`: close zoom by default (`lat`, `lon`, `km`, and `tilt`, the degrees from straight down toward north). For
  ship mode, add `"ship": true` with `pitch` and `heading`.
- `PARAMS`: any URL params; `quality=low`, `weather=static` and `speed=0` are the defaults.
- `PHONE=0`: 960x600 at dpr 1 instead of the phone viewport.
- `SETTLE`: settle time in ms. Use 20000 or more below about 60 km.
- `K`, `N`: renders per round and number of rounds.
- `SHOT=<png>`: screenshot the pose. Check it before trusting a number.
- `NOTIME=1`: pixels only, no timing.

## The glow pass: exact? how much?

```bash
cd scripts/perf-audit
VARS=noScissor,glowOff PARAMS='{"quality":"high"}' NOTIME=1 node glow-ab.cjs
VARS=noScissor,noInvalidate,half,glowOff PARAMS='{"quality":"low","glow":"1"}' K=24 N=16 node glow-ab.cjs
```

It draws a fresh `createGlowPass()` around the recorded View draws, so it measures the shipped code, not a port.
A vs B is a switch off against all of them on; `glowOff` is the control (no glow at all) and the glow's total cost.
`PASSONLY=1` times the pass without the View draws, where the composite's fill shows; read `dWall`.

## Cold start: how long does the main thread block?

```bash
cd scripts/perf-audit
COLD=1 RUNS=3 node cold-start.cjs     # cold Metal shader cache
RUNS=3 node cold-start.cjs            # warm
```

Each run opens a fresh browser under the GPU lock, starts the profiler (200 µs samples) on a same-origin page, then
loads the app and profiles until `AFTER` ms (4000) past the reveal. It prints one JSON line per run:

- `block`: the longest stretch with no idle sample after navigation, with its top self time and each one's callers.
  Native WebGL calls show up by name: `getProgramInfoLog` is a program's first use waiting on its link,
  `texSubImage2D` an upload. `blocks` lists the five longest.
- `readyAt`: when the loading screen starts to fade (`tides:ready`).
- `bake`: the Sun bake's first face, the stretch and frame holding it, and when its last face was drawn.
- `mips`: `generateMipmap` calls on cube maps and on 2D textures.
- `firstUses` (>= 1 ms) and `drawUses`: programs whose first use came at a draw rather than from a warm-up.

A sync WebGL call waits for the GPU process to finish what was sent before it. So a stall often shows up in
whatever call comes next, not in the work that caused it. Compare builds interleaved under one vite (swap the files
between runs), as other streams load the GPU.

## Writing your own script

Read `lib.cjs`'s header, then follow the shape of `ab.cjs`. The in-page `__H` gives you:

- `reg(name, on, off)` for any JS-side variant (uniforms, geometry draw ranges, visibility).
- `breakdown(K, N)` to hide each group of drawn objects and time the frame without it. It hides with
  `layers.mask = 0`; `visible = false` would also hide the object's children.
- `vram()` and `window.__vram.list`, which record allocations since load (`totalMB`), and `liveMB`, the texture
  bytes resident now (`window.__vram.live`, less each `deleteTexture`; `__vram.liveOf(webglTexture)` for one).
- `H.cpuProfile(page, ms)` for a sampled main-thread profile.

Wrap every timing call in `H.withGpuLock`. It's a mkdir lock, shared with phone-perf's `GPU_LOCK`.

## Pitfalls the audit hit

- **Poses the phone can't reach.** The low tier (the phone's) has no streamed tiles, and its ship stops at about
  450 km. Phone low-altitude views are close zoom in the system view (`poseMain`, which goes down to the ground).
  A low-tier ship forced lower renders broken and its timings are meaningless.
- **Three Views.** The default phone layout has three of them (main, View from Earth, Moon Phase), and many
  renderers exist once per View. Make sure a variant or a hide hits the instance you mean.
- **Dirty measurements.** Pause the page (`__H.pause()`) before timing, close browsers when done, and never
  `pkill` Chrome or vite. Other sessions share the machine.
- **Cold shader cache.** `COLD=1` salts every fragment shader so macOS's Metal shader cache can't hide
  compile stalls.
