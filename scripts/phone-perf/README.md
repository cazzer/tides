# phone-perf

Frame-time profile of tides on an Android phone (Chrome over adb + the
DevTools protocol), or on desktop Chrome emulating one. One command builds the
app with the harness's pose hooks, serves it, opens each standard pose in a
fresh tab, and writes `results.json` and `report.md` to
`scripts/phone-perf/runs/<time>-<target>/` (or `OUT`).

```bash
npm run perf:phone                                    # phone over adb (needs one attached device)
ANDROID_SERIAL=192.168.68.56:36979 npm run perf:phone # pick the device
TARGET=desktop npm run perf:phone                     # desktop Chrome, 390x844 @3, mobile UA
POSES=ship-sea,aurora-night RUNS=1 npm run perf:phone # a subset, one round
BUILDS=before=../wt-a,after=../wt-b POSES=system npm run perf:phone  # before/after
```

## Before / after (`BUILDS`)

`BUILDS=name=path,name=path` (or `name=path?query` for a build's own URL
params, after `PARAMS`; the same tree may be listed twice) builds each source tree with this harness's hooks
(the tree is the build root, so its `src/` is what gets bundled) and serves
them on `VITE_PORT`, `+1`, ... Per pose the builds run back to back, their
order alternating each round, each after its own cool-down. The report adds a
before/after table: each later build against the first, the median of the
per-round differences and their range, starred when every round moved the
same way. Use detached worktrees pinned to the commits you compare
(`git worktree add --detach <path> <sha>`), with `node_modules` installed or
symlinked from a checkout with the same `package-lock.json`; the tree's
`vite.config.ts` must match this checkout's (checked). On a pose that already
holds 60 fps the p50 can't move; compare replay ms and GPU-process ms.
Rounds that rendered at a different dpr or canvas are left out of the pairs;
`COMPARE_DPR=0` keeps them, for a build whose own controller picks the dpr.

No dependencies beyond Node 22 (built-in WebSocket) and `adb` on the PATH.

## What a run does

1. `vite build` with `vite.config.mjs` (the app's config plus transform-time
   hooks, so the app source never carries them), then `vite preview` on
   `VITE_PORT` (default 5393). The build keeps identifiers unminified, so
   profiles name real functions; `SERVE=dev` serves the dev server instead,
   and `SERVE=none BASE_URL=...` points at a server you already run (it must
   serve a build made with this config, or the handles are missing).
2. Phone: `adb reverse` for the server, `adb forward tcp:CDP_PORT
   localabstract:chrome_devtools_remote` (default 9393; 9222 belongs to other
   workspaces), screen kept on (`svc power stayon true`; the previous
   `stay_on_while_plugged_in` value is restored at the end), wake + dismiss a
   swipe keyguard (a PIN lock needs a person). Desktop: launches Chrome
   (`CHROME`, default Google Chrome) headless with a throwaway profile and
   emulates the phone per tab.
3. Per round (`RUNS`, default 3; the pose order rotates each round), per pose
   and tier:
   - phone: waits until `dumpsys thermalservice` reports status 0 and the skin
     sensor is at or under `COOL_C` (default 36 °C, up to `COOL_TIMEOUT_MS`);
     the reading before and after is recorded;
   - desktop with `GPU_LOCK=<dir>`: holds the cross-stream GPU lock (shared
     with the perf-audit harness: mkdir lock, owner `<who> <epoch ms>`, stale
     after 180 s) for the whole pose;
   - opens a new tab, loads the pose URL, waits for the loader to go, poses,
     waits the pose's settle time (tiles stream for 15-20 s at low altitude);
   - **frames**: rAF deltas for `DURATION_MS` (10 s): p50/p95/p99, dropped
     share against the display's refresh (the phone's reported render rate,
     or `REFRESH_HZ`), long tasks;
   - **GPU ms**: `EXT_disjoint_timer_query_webgl2` when the GPU exposes it
     (the Adreno 660 does not). If the app times frames itself (high tier,
     AdaptivePixelRatio) the harness records the app's results rather than
     nesting a query;
   - **trace** (`TRACE_MS`, 4 s): CDP Tracing over the whole browser. Main
     thread busy time per frame split by self time into script, gc, compile,
     webgl, style-layout, paint-composite and other, plus the GPU process's
     CrGpuMain and Viz thread busy time per frame;
   - **profile** (`PROFILE_MS`, 4 s): CDP Profiler self time per function.
     Starting the profiler stalls one frame, so this window gives no frame
     times;
   - **replay**: the frame's recorded `gl.render` calls re-run `REPLAY_K`
     (10) times back to back, synced by a 1-pixel readPixels, median of 7. That
     is CPU submit plus GPU without vsync, the headroom figure where the GPU
     has no timer;
   - **scene**: tier, dpr, canvas size, draws and triangles summed over the
     frame's render passes, programs, and resident GPU memory by format
     (tracked from the GL calls: a re-upload replaces, a delete frees,
     compressed formats count at their block size, renderbuffers incl. MSAA;
     bytes uploaded since load are reported apart), also read once the pose is up and
     before the settle (`memoryAtReady`: in ship mode, what entry uploads).

## Poses (`poses.mjs`)

Time is 2026-03-20 19:00 UTC with static weather. Poses marked *+high* also
run at `?quality=high`: phones auto-select the low tier (by user agent),
which has no surface tiles and keeps the ship above the shells (~450 km), so
the high pass shows what a phone pays for the high tier's look.

| id | what | tiers |
|---|---|---|
| system | default system view (the opening move is waited out) | auto |
| earth-100km | close zoom 100 km over the Grand Canyon, 30° tilt | auto +high |
| ship-sea | ship at 3 km over the Pacific (20N 130W) | auto +high |
| ship-land | ship at 4 km over the Grand Canyon | auto +high |
| aurora-night | close zoom 300 km at 66N 20E at night, looking north across the oval | auto +high |
| seasons | seasons tour, step 1 (June solstice), step clock replayed before timing | auto |
| solar-eclipse | solar eclipse tour, step 0, step clock replayed before timing | auto |

Extra poses, run only when `POSES` names them (the sprint fixes' own poses):

| id | what | for |
|---|---|---|
| cz-sheet | close zoom 20 km under the cloud sheet, Himalaya 27.9N 86.9E, tilt 60 | tides-0oi.3 |
| night-ocean | close zoom 100 km over the Indian Ocean (0N 90E) at local 01:00, looking down | tides-0oi.10 |
| aurora-gate | close zoom 400 km at 65N 120E, 15:00 UTC (23:00 local), looking down | tides-0oi.4 |
| night-city | close zoom 100 km over Tokyo (35.7N 139.8E) at 04:00 local, tilt 30: city lights under the night glow | tides-0oi.15 |
| system-touch | the system view in use: a pointermove on each side panel every 5 s and x3600 for 10 s of every 30, through sampling, trace and profile (stopped before the replay); use DURATION_MS=30000 and TRACE_MS=30000 so each window sees the whole cycle | tides-0oi.18 |
| cold-start | the system view loaded with the HTTP cache cleared: first frame, first frame after the loader leaves (first interactive), long tasks (longest, before/after the loader, total) and the longest frame in the 6 s after; the GPU's disk shader cache is not reachable over CDP and stays warm | tides-0oi.6 |

`POSES` filters by id; `TIERS=auto,high` forces tiers on every pose.
`PARAMS='dprctl=systemMax:3'` adds a query string to every pose URL, set
last so it overrides the common and pose params. When the page exposes
`window.__dprctl.changes` (the low tier's dpr controller, tides-0oi.13), each
result records it as `dprTimeline` (last 500 entries) in `results.json`, and
the report lists each change with its reason, window stats, cpuShare,
cpuMedian and lagMedian.

`TELEMETRY_MS=5000` polls, every 5 s while sampling, the phone's thermal
state and `dumpsys battery` (`current now` in mA and the charge counter; on
AC that is the net charge current, so a lighter load shows as more charge)
the Adreno's clock (`/sys/class/kgsl/kgsl-3d0`: current and allowed maximum
frequency, busy %, thermal power level; the clock is also read going into the
replay) and the idle cap's `window.__idleRate` counters (tides-0oi.31); the report
summarises them per pose and round.

`VARIANTS='off=dprctl=off;fixed2=dprctl=fixed:2'` runs each pose once per
named query string per round (split on `;`, since dprctl values carry
commas), back to back and alternating like builds, on the same build and
server; with `BUILDS` every build runs under every variant
(`build+variant`). The before/after table compares each against the first.

## Hooks (`vite.config.mjs`)

Injected at transform time, never committed to `src/`. Names match the
perf-audit stream's hooked tree:

- `window.__mainPose?.(camera, controls)` after the main view's `controls.update()`
- `window.__ship = { state, bodies, input, telemetry, earth }` and
  `window.__shipPose?.(state, earth)` after `stepShip`
- `window.__ppHandles = { getState, THREE, addEffect, addAfterEffect, useStore, qualityTier, savedQualityChoice }`

A hook whose anchor text moves fails the build with a message naming this
file.

## Pitfalls

- One tab at a time: tabs share the GPU. The harness closes each pose's tab.
- Close other tabs on the phone first (`curl localhost:9393/json/list`,
  `/json/close/<id>` with the forward up). A busy background tab skews
  everything.
- The S21 runs Chrome at 60 Hz with `refresh_rate_mode` 1 (adaptive). The
  report states the display rate it counted drops against.
- Texture memory near 1 GB on the high tier is close to the phone's free RAM.
  Watch for a tab crash ("Target closed") in the failures section.
