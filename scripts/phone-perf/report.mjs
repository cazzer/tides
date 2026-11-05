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
      gpuSource: [...new Set(ok.map((r) => r.gpu?.source).filter(Boolean))].join('+') || 'none',
      gpuDeviceMs: median(ok.map((r) => r.trace?.gpuDevicePerFrameMs)),
      gpuThreadsMs: Object.fromEntries(Object.entries(gpuThreads).map(([t, list]) => [t, median(list)])),
      mainBusyMs: median(ok.map((r) => r.trace?.main?.busyPerFrameMs)),
      replayMs: median(ok.map((r) => r.replay?.ms)),
      noiseReplay: noiseBand(ok.map((r) => r.replay?.ms)),
      mainBusyShare: median(ok.map((r) => r.trace?.main?.busyShare)),
      traceErrors: [...new Set(ok.map((r) => r.trace?.error).filter(Boolean))],
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

const gpuProcessMs = (r) => {
  const threads = r.trace?.gpuThreads
  return threads?.length ? threads.reduce((sum, t) => sum + t.busyPerFrameMs, 0) : null
}

const COMPARED = [
  ['replay ms', (r) => r.replay?.ms],
  ['GPU-process ms/frame', gpuProcessMs],
  ['main ms/frame', (r) => r.trace?.main?.busyPerFrameMs],
  ['p50 ms', (r) => r.frames?.p50],
  ['p95 ms', (r) => r.frames?.p95],
  ['dropped %', (r) => (typeof r.frames?.droppedShare === 'number' ? r.frames.droppedShare * 100 : null)],
  ['GPU mem MB', (r) => r.info?.vramMB?.total],
  ['GPU mem at ready MB', (r) => r.memoryAtReady?.total],
  ['first interactive frame ms', (r) => r.startup?.loaderGoneMs],
  ['longest main-thread block ms', (r) => r.startup?.longestTaskMs],
  ['longest block after loader ms', (r) => r.startup?.longestTaskAfterLoaderMs],
  ['long-task total ms', (r) => r.startup?.longTaskTotalMs],
  ['longest frame after loader ms', (r) => r.startup?.longestFrameAfterLoaderMs],
]

// Before/after per pose across builds (BUILDS): each later build against the
// first, paired by round (the two ran back to back), so the delta is the
// median of per-round differences and its range shows the noise.
export function compareBuilds(results, buildNames) {
  if (!buildNames || buildNames.length < 2) return []
  const [before, ...afters] = buildNames
  const poseKeys = [...new Set(results.filter((r) => r.build).map((r) => r.poseKey))]
  const out = []
  for (const poseKey of poseKeys) {
    for (const after of afters) {
      const find = (build, round) => results.find((r) => r.poseKey === poseKey && r.build === build && r.round === round && !r.error)
      const rounds = [...new Set(results.filter((r) => r.poseKey === poseKey).map((r) => r.round))]
      const all = rounds.map((round) => [find(before, round), find(after, round)]).filter(([a, b]) => a && b)
      // A pair that rendered differently (tier from a saved choice, dpr,
      // canvas) compares two different frames, not two builds.
      const same = ([a, b]) =>
        a.info?.quality === b.info?.quality && a.info?.dpr === b.info?.dpr && a.info?.canvas?.join('x') === b.info?.canvas?.join('x')
      const pairs = all.filter(same)
      const mismatched = all.length - pairs.length
      const metrics = COMPARED.map(([name, get]) => {
        const deltas = pairs
          .map(([a, b]) => [get(a), get(b)])
          .filter(([a, b]) => typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b))
        const a = median(deltas.map(([x]) => x))
        const b = median(deltas.map(([, y]) => y))
        const diffs = deltas.map(([x, y]) => y - x)
        return {
          name,
          before: a,
          after: b,
          delta: median(diffs),
          deltaMin: diffs.length ? Math.min(...diffs) : null,
          deltaMax: diffs.length ? Math.max(...diffs) : null,
          deltaPct: a ? (median(diffs) / a) * 100 : null,
          pairs: diffs.length,
          diffs,
          // Every paired round moved the same way.
          consistent: diffs.length > 1 && (diffs.every((d) => d < 0) || diffs.every((d) => d > 0)),
        }
      })
      out.push({ poseKey, before, after, pairs: pairs.length, mismatched, metrics })
    }
  }
  return out
}

// The paced dpr controller's log (window.__dprctl.changes): counts by
// reason, how many drops undid the raise before them, and the last ratio.
export function summariseDprTimeline(changes) {
  const byReason = {}
  for (const c of changes) byReason[c.reason] = (byReason[c.reason] ?? 0) + 1
  return {
    changes: changes.length,
    byReason,
    bounced: changes.filter((c) => c.bounced).length,
    finalDpr: changes.length ? changes[changes.length - 1].to : null,
    list: changes,
  }
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
    ...(meta.builds
      ? [`- builds: ${meta.builds.map((b) => `${b.name} = ${b.git} (${b.root})${b.params ? ` ?${b.params}` : ''}`).join('; ')}; per pose the builds ran back to back, order alternating each round`]
      : []),
    `- replay ms = the frame's recorded renders re-run ${meta.config.replayK}x back to back then synced by a 1-pixel readPixels, per frame: CPU submit + GPU, without vsync. The headroom figure where the GPU has no timer`,
    ''
  )
  lines.push(
    '| pose | tier | dpr | canvas | p50 | p95 | p99 | dropped | Hz | main ms/frame | replay ms | GPU ms | GPU-process ms/frame | GPU mem MB (compressed) | p50 noise |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
  )
  for (const r of rows) {
    const info = r.info ?? {}
    const gpuProc = Object.entries(r.gpuThreadsMs)
      .map(([t, ms]) => `${t.replace('VizCompositorThread', 'Viz')} ${f1(ms)}`)
      .join(', ')
    lines.push(
      `| ${r.key} | ${info.quality ?? r.tier} | ${info.dpr ?? '–'} | ${info.canvas?.join('x') ?? '–'} | ${f1(r.p50)} | ${f1(r.p95)} | ${f1(r.p99)} | ${pct(r.dropped)} | ${r.refreshHz ?? '–'} | ${f1(r.mainBusyMs)} | ${f1(r.replayMs)}${r.noiseReplay && r.noiseReplay.runs > 1 ? ` ±${f1(r.noiseReplay.spreadPct / 2)}%` : ''} | ${r.gpuMs !== null ? `${f1(r.gpuMs)} (${r.gpuSource})` : r.gpuDeviceMs !== null ? `${f1(r.gpuDeviceMs)} (trace)` : 'n/a'} | ${gpuProc || '–'} | ${info.vramMB ? `${info.vramMB.total} (${info.vramMB.compressed})` : '–'} | ${r.noise.p50 && r.noise.p50.runs > 1 ? `±${f1(r.noise.p50.spreadPct / 2)}%` : '–'} |`
    )
  }
  const comparisons = compareBuilds(results, meta.builds?.map((b) => b.name))
  if (comparisons.length) {
    lines.push('', '## Before / after (paired by round: median of after - before, with the range over rounds)', '')
    lines.push('| pose | builds | metric | before | after | delta | delta % | range | rounds |', '|---|---|---|---|---|---|---|---|---|')
    for (const c of comparisons) {
      if (c.mismatched) lines.push(`| ${c.poseKey} | ${c.before} → ${c.after} | ${c.mismatched} round(s) left out: tier, dpr or canvas differed | | | | | | |`)
      for (const m of c.metrics) {
        if (m.pairs === 0) continue
        lines.push(
          `| ${c.poseKey} | ${c.before} → ${c.after} | ${m.name} | ${f1(m.before)} | ${f1(m.after)} | ${m.delta > 0 ? '+' : ''}${f1(m.delta)}${m.consistent ? ' *' : ''} | ${m.deltaPct === null ? '–' : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct.toFixed(1)}%`} | ${f1(m.deltaMin)}..${f1(m.deltaMax)} | ${m.pairs} |`
        )
      }
    }
    lines.push('', '`*` every paired round moved the same way.')
  }
  lines.push('', '## Main thread by category (ms per frame, self time)', '')
  for (const r of rows) {
    const parts = Object.entries(r.categoriesMs).map(([c, ms]) => `${c} ${f1(ms)}`)
    const note = r.traceErrors.length ? ` (trace: ${r.traceErrors.join('; ')})` : ''
    lines.push(`- **${r.key}**: busy ${f1(r.mainBusyMs)} ms/frame (${pct(r.mainBusyShare)} of wall); ${parts.join(', ') || '–'}${note}`)
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
      `- **${r.key}**: ${info.render.calls} draws / ${info.render.triangles} tris per frame over ${info.render.passes} render passes, ${info.memory.textures} textures, ${info.memory.geometries} geometries, ${info.programs} programs (${info.programLinks} links); resident GPU memory ${info.vramMB.total} MB (textures ${info.vramMB.textures} in ${info.vramMB.liveTextures}, of which ${info.vramMB.compressed} compressed; renderbuffers ${info.vramMB.renderbuffers}; ${info.vramMB.uploaded} MB uploaded since load; ${formats}); load ${f1(r.loadMs / 1000)} s; ${info.renderer}`
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
  const cold = results.filter((r) => r.startup)
  if (cold.length) {
    lines.push('', '## Cold starts (ms from navigation start)', '')
    for (const r of cold) {
      const s = r.startup
      lines.push(
        `- **${r.key}** round ${r.round + 1}: first frame ${f1(s.firstFrameMs)}, loader gone (first interactive frame) ${f1(s.loaderGoneMs)}, ${s.longTasks} long tasks totalling ${f1(s.longTaskTotalMs)}, longest ${f1(s.longestTaskMs)} (before loader ${f1(s.longestTaskBeforeLoaderMs)}, after ${f1(s.longestTaskAfterLoaderMs)}), longest frame in the ${'6 s'} after the loader ${f1(s.longestFrameAfterLoaderMs)}, ${s.framesOver50AfterLoader} frames over 50`
      )
    }
  }
  const dpr = results.filter((r) => Array.isArray(r.dprTimeline))
  if (dpr.length) {
    lines.push('', '## dpr controller changes (tides-0oi.13)', '')
    for (const r of dpr) {
      const s = summariseDprTimeline(r.dprTimeline)
      const counts = Object.entries(s.byReason).map(([k, n]) => `${k} ${n}`).join(', ')
      lines.push(
        `- **${r.key}** round ${r.round + 1}: ${s.changes} changes${counts ? ` (${counts}${s.bounced ? `; ${s.bounced} bounced` : ''})` : ''}, final dpr ${s.finalDpr ?? r.info?.dpr ?? '–'}, the canvas at ${r.info?.dpr ?? '–'} when sampled`
      )
      for (const c of s.list) {
        lines.push(
          `  - ${f1(c.at / 1000)} s ${c.reason}${c.bounced ? ' (bounced)' : ''} ${c.from}→${c.to}: p50 ${f1(c.p50)}, p95 ${f1(c.p95)}, misses ${c.misses ?? '–'}/${c.n ?? '–'}, cpuShare ${c.cpuShare === null || c.cpuShare === undefined ? '–' : c.cpuShare.toFixed(2)}, cpuMedian ${f1(c.cpuMedian)}, lagMedian ${f1(c.lagMedian)}, budget ${f1(c.budgetMs)}`
        )
      }
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
