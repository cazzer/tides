// Turns a run's results into report.md (and returns its path): one row per
// pose and tier, the median over runs, with the spread across runs.
import fs from 'node:fs'
import path from 'node:path'
import { noiseBand, percentile } from './stats.mjs'
import { thermalLine } from './adb.mjs'

const f1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '–')
const shortFn = (fn) => fn.replace(/https?:\/\/[^ ]*\/assets\/([\w-]+?)-[\w]{8}\.js/, '$1.js')
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '–')
const median = (values) => {
  const present = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  return present.length ? percentile(present, 50) : null
}

export function aggregate(results) {
  const byKey = new Map()
  for (const r of results) {
    if (!byKey.has(r.key)) byKey.set(r.key, [])
    byKey.get(r.key).push(r)
  }
  return [...byKey.entries()].map(([key, runs]) => {
    const ok = runs.filter((r) => !r.error)
    const last = ok[ok.length - 1]
    const categories = {}
    for (const r of ok) {
      for (const [c, ms] of Object.entries(r.trace?.main?.categoriesPerFrameMs ?? {})) {
        ;(categories[c] ??= []).push(ms)
      }
    }
    const categoryMedians = Object.fromEntries(
      Object.entries(categories)
        .map(([c, list]) => [c, median(list)])
        .sort((a, b) => b[1] - a[1])
    )
    const gpuThreads = {}
    for (const r of ok) {
      for (const t of r.trace?.gpuThreads ?? []) (gpuThreads[t.thread] ??= []).push(t.busyPerFrameMs)
    }
    const functions = {}
    for (const r of ok) {
      const seconds = r.profile?.seconds || 1
      for (const { fn, ms } of r.profile?.topSelfMs ?? []) (functions[fn] ??= []).push(ms / seconds)
    }
    return {
      key,
      label: runs[0].label,
      tier: runs[0].tier,
      runs: runs.length,
      failed: runs.length - ok.length,
      errors: runs.filter((r) => r.error).map((r) => r.error),
      p50: median(ok.map((r) => r.frames.p50)),
      p95: median(ok.map((r) => r.frames.p95)),
      p99: median(ok.map((r) => r.frames.p99)),
      dropped: median(ok.map((r) => r.frames.droppedShare)),
      refreshHz: median(ok.map((r) => r.frames.refreshHz)),
      longTasks: median(ok.map((r) => r.longTasks?.count)),
      noise: {
        p50: noiseBand(ok.map((r) => r.frames.p50)),
        p95: noiseBand(ok.map((r) => r.frames.p95)),
        gpu: noiseBand(ok.map((r) => r.gpu?.p50)),
      },
      gpuMs: median(ok.map((r) => r.gpu?.p50)),
      gpuSource: last?.gpu?.source ?? 'none',
      gpuDeviceMs: median(ok.map((r) => r.trace?.gpuDevicePerFrameMs)),
      gpuThreadsMs: Object.fromEntries(Object.entries(gpuThreads).map(([t, list]) => [t, median(list)])),
      mainBusyMs: median(ok.map((r) => r.trace?.main?.busyPerFrameMs)),
      replayMs: median(ok.map((r) => r.replay?.ms)),
      noiseReplay: noiseBand(ok.map((r) => r.replay?.ms)),
      mainBusyShare: median(ok.map((r) => r.trace?.main?.busyShare)),
      categoriesMs: categoryMedians,
      topFunctionsMsPerS: Object.entries(functions)
        .map(([fn, list]) => ({ fn, msPerS: median(list) }))
        .filter(({ fn }) => !/^\((idle|program|root)\)/.test(fn))
        .sort((a, b) => b.msPerS - a.msPerS)
        .slice(0, 8),
      info: last?.info ?? null,
      loadMs: median(ok.map((r) => r.loadMs)),
      thermal: runs.map((r) => ({ before: r.thermalBefore, after: r.thermalAfter })),
    }
  })
}

export function renderMarkdown({ meta, results }) {
  const rows = aggregate(results)
  const lines = []
  const device = meta.device ?? {}
  lines.push(`# tides phone perf: ${meta.target} run`, '')
  lines.push(
    `- ${meta.startedAt} → ${meta.finishedAt ?? '…'}, build ${meta.git} (${meta.serve}), ${meta.browser}`,
    device.kind === 'phone'
      ? `- ${device.model}, Android ${device.android}, Chrome ${device.chrome}, battery ${device.battery}% at start, display ${device.displayFps ? Math.round(device.displayFps) + ' fps' : '?'} (refresh_rate_mode ${device.refreshRateMode}), ${device.thermalAtStart ? thermalLine(device.thermalAtStart) : ''}`
      : `- desktop emulation ${device.emulation?.width}x${device.emulation?.height} @${device.emulation?.deviceScaleFactor}, mobile UA`,
    `- ${meta.config.runs} rounds, pose order rotated each round; frames over ${meta.config.durationMs} ms, trace ${meta.config.traceMs} ms, profile ${meta.config.profileMs} ms per pose per round`,
    `- values are medians over rounds; noise = ±half of (max - min) / mean across rounds`,
    `- replay ms = the frame's recorded renders re-run ${meta.config.replayK}x back to back then synced by a 1-pixel readPixels, per frame: CPU submit + GPU, without vsync. The headroom figure where the GPU has no timer`,
    ''
  )
  lines.push(
    '| pose | tier | dpr | canvas | p50 | p95 | p99 | dropped | Hz | main ms/frame | replay ms | GPU ms | GPU-process ms/frame | VRAM MB (compressed) | p50 noise |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  )
  for (const r of rows) {
    const info = r.info ?? {}
    const gpuProc = Object.entries(r.gpuThreadsMs)
      .map(([t, ms]) => `${t.replace('VizCompositorThread', 'Viz')} ${f1(ms)}`)
      .join(', ')
    lines.push(
      `| ${r.key} | ${info.quality ?? r.tier} | ${info.dpr ?? '–'} | ${info.canvas?.join('x') ?? '–'} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${pct(r.dropped)} | ${r.refreshHz ?? '–'} | ${f1(r.mainBusyMs)} | ${f1(r.replayMs)}${r.noiseReplay && r.noiseReplay.runs > 1 ? ` ±${f1(r.noiseReplay.spreadPct / 2)}%` : ''} | ${r.gpuMs !== null ? `${f1(r.gpuMs)} (${r.gpuSource})` : r.gpuDeviceMs !== null ? `${f1(r.gpuDeviceMs)} (trace)` : 'n/a'} | ${gpuProc || '–'} | ${info.vramMB ? `${info.vramMB.total} (${info.vramMB.compressed})` : '–'} | ${r.noise.p50 ? `±${f1(r.noise.p50.spreadPct / 2)}%` : '–'} |`
    )
  }
  lines.push('', '## Main thread by category (ms per frame, self time)', '')
  for (const r of rows) {
    const parts = Object.entries(r.categoriesMs).map(([c, ms]) => `${c} ${f1(ms)}`)
    lines.push(`- **${r.key}**: busy ${f1(r.mainBusyMs)} ms/frame (${pct(r.mainBusyShare)} of wall); ${parts.join(', ') || '–'}`)
  }
  lines.push('', '## Heaviest script functions (self ms per second)', '')
  for (const r of rows) {
    const parts = r.topFunctionsMsPerS.map(({ fn, msPerS }) => `\`${shortFn(fn)}\` ${f1(msPerS)}`)
    lines.push(`- **${r.key}**: ${parts.join(', ') || '–'}`)
  }
  lines.push('', '## Scene and memory (last round)', '')
  for (const r of rows) {
    const info = r.info
    if (!info) continue
    const formats = Object.entries(info.vramMB.byFormat)
      .slice(0, 5)
      .map(([fmt, mb]) => `${fmt} ${mb}`)
      .join(', ')
    lines.push(
      `- **${r.key}**: ${info.render.calls} draws / ${info.render.triangles} tris per frame over ${info.render.passes} render passes, ${info.memory.textures} textures, ${info.memory.geometries} geometries, ${info.programs} programs (${info.programLinks} links); VRAM ${info.vramMB.total} MB of which ${info.vramMB.compressed} compressed (${formats}); load ${f1(r.loadMs / 1000)} s; ${info.renderer}`
    )
  }
  if (device.kind === 'phone') {
    lines.push('', '## Thermal per pose (before → after each round)', '')
    for (const r of rows) {
      const parts = r.thermal.map((t) =>
        t.before
          ? `${t.before.skin?.c ?? '?'}→${t.after?.skin?.c ?? '?'}°C (status ${t.before.status}→${t.after?.status ?? '?'}${t.before.waitedMs > 1000 ? `, cooled ${Math.round(t.before.waitedMs / 1000)} s` : ''})`
          : '–'
      )
      lines.push(`- **${r.key}**: ${parts.join('; ')}`)
    }
  }
  const failed = rows.filter((r) => r.failed)
  if (failed.length) {
    lines.push('', '## Failures', '')
    for (const r of failed) lines.push(`- **${r.key}**: ${r.failed}/${r.runs} failed: ${[...new Set(r.errors)].join('; ')}`)
  }
  return lines.join('\n') + '\n'
}

export function writeReport(outDir, data) {
  const file = path.join(outDir, 'report.md')
  fs.writeFileSync(file, renderMarkdown(data))
  return file
}
