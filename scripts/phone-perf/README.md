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
```

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
     frame's render passes, programs, and texture memory by format (summed
     from texStorage/texImage/compressedTexImage calls, so it counts uploads,
     not what the driver keeps).

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

`POSES` filters by id; `TIERS=auto,high` forces tiers on every pose.

## Hooks (`vite.config.mjs`)

Injected at transform time, never committed to `src/`. Names match the
perf-audit stream's hooked tree:

- `window.__mainPose?.(camera, controls)` after the main view's `controls.update()`
- `window.__ship = { state, bodies, input, telemetry, earth }` and
  `window.__shipPose?.(state, earth)` after `stepShip`
- `window.__ppHandles = { getState, THREE, useStore, qualityTier, savedQualityChoice }`

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
