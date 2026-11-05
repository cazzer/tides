// In-page glow helpers (window.__G), from the tides-0oi.2 glow audit: page.evaluate(fs.readFileSync(this file)) after
// H.hook(). __H.replay/ab/breakdown are INVALID on a glow=1 frame (FullScreenQuad state gives feedback-loop GL errors
// and the glow target's clear isn't recorded): time the glow with __G.passOnly / __G.makePass by wall clock instead.
async () => {
  const H = window.__H, T = H.T, gl = H.gl, ctx = H.ctx
  const names = performance.getEntriesByType('resource').map((e) => e.name)
  const find = (re) => names.find((n) => re.test(n))
  const G = (window.__G = {})
  G.glowSources = find(/\/src\/renderers\/glow\/glowSources\.ts/) ? await import(find(/\/src\/renderers\/glow\/glowSources\.ts/)) : null
  G.glowMod = find(/\/src\/renderers\/glow\/glow\.ts/) ? await import(find(/\/src\/renderers\/glow\/glow\.ts/)) : null
  G.on = () => (G.glowSources ? G.glowSources.glowOn() : 'module-not-loaded')
  // Objects on GLOW_LAYER (30) per scene drawn this frame; what stand-ins exist.
  G.layer30 = () => {
    const out = [], seen = new Set()
    for (const c of H.frame) {
      if (!c.scene.isScene || seen.has(c.scene)) continue
      seen.add(c.scene)
      const objs = []
      c.scene.traverse((o) => { if (o.layers.mask === (1 << 30)) objs.push((o.type) + ':' + (o.material?.type || '') + '/' + (o.geometry?.attributes?.position?.count || 0) + 'v' + (o.visible ? '' : '/hidden')) })
      out.push({ srcs: G.glowSources ? G.glowSources.glowSourcesOf(c.scene).length : null, n: objs.length, objs })
    }
    return out
  }
  G.passes = () => H.frame.map((c) => {
    const t = c.target
    return (t ? t.width + 'x' + t.height + (t.depthTexture ? '+Dtex' : t.depthBuffer ? '+D' : '') + (t.texture.type === T.HalfFloatType ? 'h' : t.texture.type === T.UnsignedByteType ? 'u8' : '?') : 'canvas') +
      (c.scene.isScene ? ' SCENE' : ' ' + (c.scene.type) + (c.scene.name ? ':' + c.scene.name : '') + (c.scene.material ? ':' + (c.scene.material.type) : '')) + ' vp' + [c.vp.x, c.vp.y, c.vp.z, c.vp.w].join(',')
  })
  G.viewCalls = () => H.frame.filter((c) => c.scene.isScene)
  // Replay of the recorded frame with the glow target's per-frame clear (which gl.clear, unrecorded, did).
  G.replayFull = (calls) => {
    H.recording = false
    let cleared = false
    for (const c of calls) {
      if (!cleared && c.target && c.target.depthBuffer) {
        gl.setRenderTarget(c.target); const a = gl.autoClear; gl.autoClear = false
        gl.setClearColor(0, 0); gl.clear(true, true, false); gl.autoClear = a; cleared = true
      }
      gl.setRenderTarget(c.target); gl.setViewport(c.vp); gl.setScissor(c.sc); gl.setScissorTest(c.scissorTest)
      const ac = gl.autoClear; gl.autoClear = c.autoClear
      H.origRender.call(gl, c.scene, c.camera)
      gl.autoClear = ac
    }
    gl.setRenderTarget(null)
    H.recording = true
  }
  // ---- in-page port of glow-pass.ts with knobs ----
  const quadVertex = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
  const downFragment = `uniform sampler2D tSource; uniform vec2 uTexel; varying vec2 vUv;
    void main(){ vec3 s = texture2D(tSource, vUv).rgb * 4.0;
      s += texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb; s += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0)).rgb;
      s += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb; s += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0)).rgb;
      gl_FragColor = vec4(s * 0.125, 1.0); }`
  const upFragment = `uniform sampler2D tSource; uniform vec2 uTexel; uniform float uSpread; varying vec2 vUv;
    void main(){ vec3 s = texture2D(tSource, vUv + uTexel * vec2(-2.0, 0.0)).rgb; s += texture2D(tSource, vUv + uTexel * vec2(2.0, 0.0)).rgb;
      s += texture2D(tSource, vUv + uTexel * vec2(0.0, -2.0)).rgb; s += texture2D(tSource, vUv + uTexel * vec2(0.0, 2.0)).rgb;
      s += texture2D(tSource, vUv + uTexel * vec2(-1.0, 1.0)).rgb * 2.0; s += texture2D(tSource, vUv + uTexel * vec2(1.0, 1.0)).rgb * 2.0;
      s += texture2D(tSource, vUv + uTexel * vec2(-1.0, -1.0)).rgb * 2.0; s += texture2D(tSource, vUv + uTexel * vec2(1.0, -1.0)).rgb * 2.0;
      gl_FragColor = vec4(s * (uSpread / 12.0), 1.0); }`
  const compositeFragment = `uniform sampler2D tGlow; uniform sampler2D tSharp; uniform float uStrength; uniform float uNorm; varying vec2 vUv;
    void main(){ vec3 halo = texture2D(tGlow, vUv).rgb * uNorm - texture2D(tSharp, vUv).rgb; vec3 g = max(halo, vec3(0.0)) * uStrength;
      gl_FragColor = vec4(pow(1.0 - exp(-g), vec3(0.800)), 1.0); }`
  const SPREAD = 0.55, STRENGTH = 1.6
  const weight = (levels) => { let s = 0; for (let i = 0, w = 1; i < levels; i++, w *= SPREAD) s += w; return Math.max(s, 1) }
  const qm = (frag, uniforms, extra = {}) => new T.ShaderMaterial({ vertexShader: quadVertex, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra })
  const levelSizes = (target, levels, minPx = 4) => { const s = []; let w = Math.ceil(target.width / 2), h = Math.ceil(target.height / 2); while (s.length < levels && w >= minPx && h >= minPx) { s.push({ width: w, height: h }); w = Math.ceil(w / 2); h = Math.ceil(h / 2) } return s }
  const clearColor = new T.Color()
  // opts: scale(0.5), levels(5), type('half'|'u8'|'r11'), depth('tex'|'rb'|'none'), blur(true), composite(true), sources(true), mediump(false)
  G.makePass = (opts = {}) => {
    const o = { scale: 0.5, levels: 5, type: 'half', depth: 'tex', blur: true, composite: true, sources: true, bbox: false, margin: 100, ...opts }
    let box = null
    let target = null, levels = [], ready = null, calls = 0
    const texOpts = () => ({
      type: o.type === 'u8' ? T.UnsignedByteType : T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false, depthBuffer: false,
    })
    const mk = (w, h, extra = {}) => { const rt = new T.WebGLRenderTarget(w, h, { ...texOpts(), ...(o.type === 'r11' ? { format: T.RGBFormat } : {}), ...extra }); if (o.type === 'r11') rt.texture.internalFormat = 'R11F_G11F_B10F'; return rt }
    const down = qm(downFragment, { tSource: { value: null }, uTexel: { value: new T.Vector2() } })
    const up = qm(upFragment, { tSource: { value: null }, uTexel: { value: new T.Vector2() }, uSpread: { value: SPREAD } }, { blending: T.AdditiveBlending, transparent: true })
    const composite = qm(compositeFragment, { tGlow: { value: null }, tSharp: { value: null }, uStrength: { value: STRENGTH }, uNorm: { value: 1 } },
      { transparent: true, blending: T.CustomBlending, blendEquation: T.AddEquation, blendSrc: T.OneMinusDstColorFactor, blendDst: T.OneFactor })
    const quadMesh = new T.Mesh(new T.PlaneGeometry(2, 2), down)
    quadMesh.frustumCulled = false
    const quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const drawQuad = (mat) => { quadMesh.material = mat; H.origRender.call(gl, quadMesh, quadCam) }
    const size = (view) => {
      const want = { width: Math.max(1, Math.ceil(view.width * o.scale)), height: Math.max(1, Math.ceil(view.height * o.scale)) }
      if (target && target.width === want.width && target.height === want.height) return
      target?.depthTexture?.dispose(); target?.dispose(); levels.forEach((l) => l.dispose())
      target = mk(want.width, want.height, { depthBuffer: o.depth !== 'none' })
      if (o.depth === 'tex') target.depthTexture = new T.DepthTexture(want.width, want.height, T.FloatType)
      levels = levelSizes(want, o.levels).map((s) => mk(s.width, s.height))
    }
    const blur = (source) => {
      let from = source
      for (const level of levels) {
        down.uniforms.tSource.value = from.texture; down.uniforms.uTexel.value.set(1 / from.width, 1 / from.height)
        gl.setRenderTarget(level); drawQuad(down); from = level
      }
      for (let i = levels.length - 1; i > 0; i--) {
        up.uniforms.tSource.value = levels[i].texture; up.uniforms.uTexel.value.set(0.5 / levels[i].width, 0.5 / levels[i].height)
        gl.setRenderTarget(levels[i - 1]); drawQuad(up)
      }
      return levels.length ? levels[0].texture : source.texture
    }
    const pass = {
      opts: o, calls: () => calls,
      prepare(scene, camera, viewport) {
        ready = null
        const sources = G.glowSources.glowSourcesOf(scene)
        if (!sources.length) return
        const ratio = gl.getPixelRatio()
        size({ width: Math.round(viewport.width * ratio), height: Math.round(viewport.height * ratio) })
        const autoClear = gl.autoClear, alpha = gl.getClearAlpha(); gl.getClearColor(clearColor)
        const mask = camera.layers.mask
        gl.autoClear = false
        gl.setRenderTarget(target); gl.setClearColor(0x000000, 0); gl.clear(true, true, false)
        camera.updateWorldMatrix(true, false)
        camera.layers.set(30)
        calls = 0
        if (o.sources) for (const { object } of sources) {
          if (!G.glowSources.shownInWorld(object)) continue
          object.parent?.updateWorldMatrix(true, false)
          H.origRender.call(gl, object, camera); calls++
        }
        camera.layers.mask = mask
        box = o.tiny ? { left: viewport.left, bottom: viewport.bottom, width: 1, height: 1, frac: 0 } : o.bbox ? G.sourceBox(sources, camera, viewport, o.margin) : null
        const glow = o.blur ? blur(target) : target.texture
        gl.setRenderTarget(null); gl.setClearColor(clearColor, alpha); gl.autoClear = autoClear
        composite.uniforms.tGlow.value = glow; composite.uniforms.tSharp.value = target.texture
        composite.uniforms.uNorm.value = 1 / weight(o.blur ? levels.length : 0)
        ready = viewport
      },
      composite() {
        const viewport = ready; ready = null
        if (!viewport || !o.composite) return
        const autoClear = gl.autoClear; gl.autoClear = false
        gl.setRenderTarget(null)
        gl.setViewport(viewport.left, viewport.bottom, viewport.width, viewport.height)
        const b = box || viewport
        gl.setScissor(b.left, b.bottom, b.width, b.height); gl.setScissorTest(true)
        drawQuad(composite)
        gl.setScissorTest(false); gl.autoClear = autoClear
      },
      vramMB() { const px = (rt) => rt.width * rt.height; const bpp = o.type === 'u8' ? 4 : o.type === 'r11' ? 4 : 8; let b = target ? px(target) * bpp + (o.depth === 'tex' ? px(target) * 4 : o.depth === 'rb' ? px(target) * 4 : 0) : 0; for (const l of levels) b += px(l) * bpp; return +(b / 1048576).toFixed(2) },
      box() { return box },
      sizes() { return { target: target && target.width + 'x' + target.height, levels: levels.map((l) => l.width + 'x' + l.height) } },
      dispose() { target?.depthTexture?.dispose(); target?.dispose(); levels.forEach((l) => l.dispose()); down.dispose(); up.dispose(); composite.dispose(); quadMesh.geometry.dispose() },
    }
    return pass
  }
  const _c = new T.Vector3(), _e = new T.Vector3(), _s = new T.Vector3()
  G.sourceBox = (sources, camera, vp, margin) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, full = false
    camera.getWorldPosition(_e)
    const pyy = camera.projectionMatrix.elements[5], pxx = camera.projectionMatrix.elements[0]
    for (const { object } of sources) {
      if (!G.glowSources.shownInWorld(object)) continue
      object.traverse((m) => {
        if (!m.isMesh || !m.visible) return
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere()
        const bs = m.geometry.boundingSphere
        _c.copy(bs.center).applyMatrix4(m.matrixWorld); m.getWorldScale(_s)
        const R = bs.radius * Math.max(_s.x, _s.y, _s.z)
        const d = _c.distanceTo(_e)
        if (!(d > R)) { full = true; return }
        const ndc = _c.clone().project(camera)
        if (ndc.z > 1 || ndc.z < -1) { /* behind: still may be partly visible; be safe */ }
        const t = R / Math.sqrt(d * d - R * R)
        const rx = t * pxx * 0.5 * vp.width, ry = t * pyy * 0.5 * vp.height
        const cx = (ndc.x * 0.5 + 0.5) * vp.width, cy = (ndc.y * 0.5 + 0.5) * vp.height
        // Behind the camera the projection flips: take the whole View then.
        const view = _c.clone().applyMatrix4(camera.matrixWorldInverse)
        if (view.z > -1e-9 + R) { full = true; return }
        x0 = Math.min(x0, cx - rx); x1 = Math.max(x1, cx + rx); y0 = Math.min(y0, cy - ry); y1 = Math.max(y1, cy + ry)
      })
    }
    if (full || !isFinite(x0)) return { left: vp.left, bottom: vp.bottom, width: vp.width, height: vp.height, frac: 1 }
    x0 = Math.max(0, Math.floor(x0 - margin)); y0 = Math.max(0, Math.floor(y0 - margin))
    x1 = Math.min(vp.width, Math.ceil(x1 + margin)); y1 = Math.min(vp.height, Math.ceil(y1 + margin))
    if (x1 <= x0 || y1 <= y0) return { left: vp.left, bottom: vp.bottom, width: 0, height: 0, frac: 0 }
    return { left: vp.left + x0, bottom: vp.bottom + y0, width: x1 - x0, height: y1 - y0, frac: +(((x1 - x0) * (y1 - y0)) / (vp.width * vp.height)).toFixed(3) }
  }
  // The main View's draw call (largest viewport scene draw), its scene/camera and CSS viewport.
  G.mainView = () => {
    const views = G.viewCalls()
    const c = views.reduce((a, b) => (b.vp.z * b.vp.w > a.vp.z * a.vp.w ? b : a))
    return { call: c, scene: c.scene, camera: c.camera, viewport: { left: c.vp.x, bottom: c.vp.y, width: c.vp.z, height: c.vp.w } }
  }
  // One synthetic frame: pass.prepare, the recorded View draws, pass.composite.
  G.frameWith = (pass) => {
    const mv = G.mainView()
    H.recording = false
    if (pass) pass.prepare(mv.scene, mv.camera, mv.viewport)
    for (const c of G.viewCalls()) {
      gl.setRenderTarget(c.target); gl.setViewport(c.vp); gl.setScissor(c.sc); gl.setScissorTest(c.scissorTest)
      const ac = gl.autoClear; gl.autoClear = c.autoClear; H.origRender.call(gl, c.scene, c.camera); gl.autoClear = ac
    }
    if (pass) pass.composite()
    gl.setRenderTarget(null)
    H.recording = true
  }
  // The pass alone (prepare + composite over whatever the canvas holds), no View draws.
  G.passOnly = (pass) => { const mv = G.mainView(); H.recording = false; pass.prepare(mv.scene, mv.camera, mv.viewport); pass.composite(); gl.setRenderTarget(null); H.recording = true }
  G.timeFrames = async (fn, K) => {
    fn(); H.sync()
    const ext = H.ext
    const q = ext ? ctx.createQuery() : null
    if (q) ctx.beginQuery(ext.TIME_ELAPSED_EXT, q)
    const t0 = performance.now()
    for (let i = 0; i < K; i++) fn()
    if (q) ctx.endQuery(ext.TIME_ELAPSED_EXT)
    H.sync()
    const wall = (performance.now() - t0) / K
    let gpu = null
    if (q) { for (let i = 0; i < 400; i++) { await new Promise((r) => setTimeout(r, 4)); if (ctx.getQueryParameter(q, ctx.QUERY_RESULT_AVAILABLE)) { if (!ctx.getParameter(ext.GPU_DISJOINT_EXT)) gpu = ctx.getQueryParameter(q, ctx.QUERY_RESULT) / 1e6 / K; break } } ctx.deleteQuery(q) }
    return { wall, gpu }
  }
  // Interleaved paired A/B over named frame functions {name: fn}; dWall/dGpu = median paired diff vs first.
  G.ab = async (fns, K = 8, N = 10) => {
    const names = Object.keys(fns), rows = []
    for (let n = 0; n < N; n++) {
      const order = names.map((_, i) => names[(i + n) % names.length])
      const row = {}
      for (const nm of order) row[nm] = await G.timeFrames(fns[nm], K)
      rows.push(row)
    }
    const med = H.med, f3 = (x) => (x == null ? null : +x.toFixed(3))
    const b = names[0], out = {}
    for (const nm of names) {
      const dW = rows.map((r) => r[nm].wall - r[b].wall).sort((a, c) => a - c)
      out[nm] = { wallMed: f3(med(rows.map((r) => r[nm].wall))), gpuMed: f3(med(rows.map((r) => r[nm].gpu))),
        dWall: nm === b ? 0 : f3(med(dW)), dWallIqr: nm === b ? 0 : f3(dW[Math.floor(dW.length * 0.75)] - dW[Math.floor(dW.length * 0.25)]),
        dGpu: nm === b ? 0 : f3(med(rows.map((r) => (r[nm].gpu == null || r[b].gpu == null ? null : r[nm].gpu - r[b].gpu)))) }
    }
    return out
  }
  // CPU-only cost of pass.prepare (JS submit), ms per call.
  G.cpuPrepare = (pass, K = 30) => {
    const mv = G.mainView(); H.recording = false
    pass.prepare(mv.scene, mv.camera, mv.viewport); pass.composite()
    const t0 = performance.now()
    for (let i = 0; i < K; i++) { pass.prepare(mv.scene, mv.camera, mv.viewport); pass.composite() }
    const dt = (performance.now() - t0) / K
    gl.setRenderTarget(null); H.recording = true
    return +dt.toFixed(3)
  }
  // Pixel diff of the canvas between two frame fns (A, B, A again): counts of differing px and max |d|.
  G.pixelDiff = (fa, fb) => {
    const w = gl.domElement.width, h = gl.domElement.height
    const rd = () => { gl.setRenderTarget(null); const px = new Uint8Array(w * h * 4); ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px); return px }
    fa(); const a = rd(); fb(); const b = rd(); fa(); const a2 = rd()
    const cmp = (x, y) => { let n = 0, mx = 0, sum = 0; for (let i = 0; i < x.length; i++) { if ((i & 3) === 3) continue; const d = Math.abs(x[i] - y[i]); if (d) { n++; sum += d; if (d > mx) mx = d } } return { diffCh: n, maxAbs: mx, meanAbs: n ? +(sum / n).toFixed(2) : 0, pxTotal: w * h } }
    return { AvsA2: cmp(a, a2), AvsB: cmp(a, b) }
  }
  return 'ok'
}
