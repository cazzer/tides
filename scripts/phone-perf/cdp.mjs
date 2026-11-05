// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket
// (Node >= 22), so the harness needs no browser-automation dependency and
// talks to desktop Chrome and Android Chrome the same way.

export async function browserWsUrl(port, host = '127.0.0.1', timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/json/version`)
      if (res.ok) {
        const info = await res.json()
        if (info.webSocketDebuggerUrl) return { url: info.webSocketDebuggerUrl, info }
      }
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `No DevTools endpoint on ${host}:${port} after ${timeoutMs} ms` +
      (lastError ? ` (${lastError.message})` : '')
  )
}

export class CdpConnection {
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error(`CDP socket failed: ${wsUrl}`)), {
        once: true,
      })
    })
    return new CdpConnection(ws)
  }

  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => this.onMessage(event.data))
    ws.addEventListener('close', () => {
      this.closed = true
      for (const { reject, method } of this.pending.values()) {
        reject(new Error(`CDP socket closed during ${method}`))
      }
      this.pending.clear()
    })
  }

  onMessage(raw) {
    const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    const key = `${message.sessionId ?? ''}:${message.method}`
    for (const handler of this.listeners.get(key) ?? []) handler(message.params)
  }

  // Every call is raced against a timer: Runtime.evaluate's own timeout does
  // not cover an awaited promise, and a page whose rAF stops (screen covered,
  // app backgrounded, wireless adb half-dropped) would otherwise hang the run.
  send(method, params = {}, sessionId, timeoutMs = 120000) {
    if (this.closed) return Promise.reject(new Error(`CDP socket closed before ${method}`))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} got no answer in ${timeoutMs} ms`))
      }, timeoutMs)
      const settle = (fn) => (value) => {
        clearTimeout(timer)
        fn(value)
      }
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method })
      this.ws.send(JSON.stringify(payload))
    })
  }

  on(method, handler, sessionId) {
    const key = `${sessionId ?? ''}:${method}`
    if (!this.listeners.has(key)) this.listeners.set(key, new Set())
    this.listeners.get(key).add(handler)
    return () => this.listeners.get(key)?.delete(handler)
  }

  waitFor(method, sessionId, timeoutMs = 30000, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${method}`))
      }, timeoutMs)
      const off = this.on(
        method,
        (params) => {
          if (!predicate(params)) return
          clearTimeout(timer)
          off()
          resolve(params)
        },
        sessionId
      )
    })
  }

  close() {
    if (!this.closed) this.ws.close()
  }
}

// One page target driven through a flattened session on the browser socket.
export class CdpPage {
  static async create(connection, url = 'about:blank') {
    const { targetId } = await connection.send('Target.createTarget', { url })
    const { sessionId } = await connection.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const page = new CdpPage(connection, targetId, sessionId)
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    return page
  }

  constructor(connection, targetId, sessionId) {
    this.connection = connection
    this.targetId = targetId
    this.sessionId = sessionId
  }

  send(method, params = {}, timeoutMs) {
    return this.connection.send(method, params, this.sessionId, timeoutMs)
  }

  on(method, handler) {
    return this.connection.on(method, handler, this.sessionId)
  }

  waitFor(method, timeoutMs, predicate) {
    return this.connection.waitFor(method, this.sessionId, timeoutMs, predicate)
  }

  async navigate(url, timeoutMs = 60000) {
    const loaded = this.waitFor('Page.loadEventFired', timeoutMs)
    const result = await this.send('Page.navigate', { url })
    if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`)
    await loaded
  }

  // Evaluates an expression (or an async function body as a string) in the page
  // and returns its JSON value; a thrown error in the page throws here.
  async evaluate(expression, { timeoutMs = 60000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      timeoutMs + 5000
    )
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails
      const message = detail.exception?.description ?? detail.text
      throw new Error(`Page evaluation failed: ${message}`)
    }
    return result.result.value
  }

  // Polls a page expression until it is truthy and returns its value.
  async waitForExpression(expression, { timeoutMs = 60000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await this.evaluate(expression).catch(() => undefined)
      if (value) return value
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${expression}`)
      }
      await sleep(intervalMs)
    }
  }

  async close() {
    await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {})
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
