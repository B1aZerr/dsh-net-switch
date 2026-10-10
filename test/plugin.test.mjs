/**
 * Host-half integration test. DSH cannot be restarted from inside a test, so this
 * drives `apply()` against a fake Cordis context that implements exactly the
 * contracts this plugin consumes — `effect`, `inject`, `webServer.register`,
 * `tools.register`, `commands.register` — and then exercises every registered
 * surface directly: the dispatcher (through the process-global `fetch`), both
 * routes, the agent tool, the `/net` command, and unload restoration.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { apply } from '../lib/index.js'

const SILENT = { info() {}, warn() {}, error() {} }

// A running dsh-net-switch in the parent process legitimately exports proxy
// variables into this child shell, so "direct" means "whatever the test process
// started with", not "undefined". Asserting against the baseline keeps `npm test`
// working while the switch is ON in the Harness that launched it.
const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']
const BASELINE = Object.fromEntries(PROXY_ENV_NAMES.map((name) => [name, process.env[name]]))

function expectEnvRestored() {
  for (const name of PROXY_ENV_NAMES) {
    assert.equal(process.env[name], BASELINE[name], `${name} must be restored to the starting value`)
  }
}

/** A fake HTTP proxy that answers CONNECT tunnels, like Clash Verge's mixed port. */
function createFakeProxy() {
  const seen = []
  const server = http.createServer((request, response) => {
    seen.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ via: 'proxy' }))
  })
  server.on('connect', (request, socket, head) => {
    seen.push(request.url)
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let buffered = head && head.length > 0 ? head : Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!buffered.includes('\r\n\r\n')) return
      socket.removeListener('data', onData)
      const payload = JSON.stringify({ via: 'proxy' })
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      )
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  return {
    seen,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** The fake context: registrations recorded, effects collected for unload. */
function createFakeContext() {
  const recorded = { routes: [], tools: [], commands: [] }
  const disposers = []
  const host = {
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
    webServer: {
      register(route) {
        recorded.routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        recorded.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        recorded.commands.push(definition)
        return () => {}
      },
    },
  }
  const ctx = {
    logger: SILENT,
    effect(callback, label) {
      const dispose = callback()
      disposers.push({ label, dispose })
      return dispose
    },
    inject(_dependencies, callback) {
      callback(host)
      return () => {}
    },
  }
  return { ctx, host, recorded, disposers }
}

function fakeRequest({ method = 'GET', host = '127.0.0.1:19387', origin, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    headers: { host, ...(origin === undefined ? {} : { origin }) },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(body) {
      state.body = body ?? ''
    },
    json() {
      return JSON.parse(state.body)
    },
  }
}

async function waitForRoute(proxy, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://8.8.8.8:8080/', { signal: AbortSignal.timeout(1000) })
      if (response.ok && proxy.seen.length > 0) return true
    } catch {
      // Not installed yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

test('apply() wires the dispatcher, the routes, the tool and the command, and unload restores everything', async (t) => {
  const proxy = createFakeProxy()
  const server = await proxy.listen()
  const proxyUrl = `http://127.0.0.1:${server.address().port}`
  const { ctx, recorded, disposers } = createFakeContext()

  apply(ctx, { proxy: proxyUrl, mode: 'clash', persist: false, probeIntervalMs: 60_000, probeTimeoutMs: 1000 })
  t.after(async () => {
    await proxy.close()
  })

  // --- the dispatcher actually governs process-global fetch ------------------
  assert.equal(await waitForRoute(proxy), true, 'the switchable dispatcher must serve global fetch')
  assert.equal(process.env.HTTPS_PROXY, proxyUrl, 'children get the same route')

  // --- the routes, the tool and the command are registered exactly -----------
  assert.deepEqual(
    recorded.routes.map((route) => [route.kind, route.path]).sort(),
    [['exact', '/dsh-net-switch/mode'], ['exact', '/dsh-net-switch/state']].sort(),
  )
  assert.equal(recorded.tools.length, 1)
  assert.equal(recorded.tools[0].name, 'network_mode')
  assert.deepEqual(recorded.tools[0].parameters.properties.mode.enum, ['clash', 'lan', 'status'])
  assert.equal(recorded.commands.length, 1)
  assert.equal(recorded.commands[0].name, 'net')

  const stateRoute = recorded.routes.find((route) => route.path === '/dsh-net-switch/state')
  const modeRoute = recorded.routes.find((route) => route.path === '/dsh-net-switch/mode')

  // --- GET state ------------------------------------------------------------
  const stateResponse = fakeResponse()
  await stateRoute.handler(fakeRequest(), stateResponse)
  assert.equal(stateResponse.state.status, 200)
  const status = stateResponse.json()
  assert.equal(status.mode, 'clash')
  assert.equal(status.effective, 'clash')
  assert.equal(status.reachable, true)
  assert.equal(status.proxy, proxyUrl)
  assert.equal(status.inProcessRouting, true)
  assert.ok(status.noProxy.includes('192.168.0.0/16'), 'the LAN must be bypassed')
  assert.ok(status.noProxy.includes('10.0.0.0/8'))

  // --- the fence in front of the mutating route -----------------------------
  const foreignHost = fakeResponse()
  await modeRoute.handler(fakeRequest({ method: 'POST', host: 'evil.example', body: { mode: 'lan' } }), foreignHost)
  assert.equal(foreignHost.state.status, 403)

  const foreignOrigin = fakeResponse()
  await modeRoute.handler(
    fakeRequest({ method: 'POST', origin: 'https://evil.example', body: { mode: 'lan' } }),
    foreignOrigin,
  )
  assert.equal(foreignOrigin.state.status, 403)

  const wrongMethod = fakeResponse()
  await stateRoute.handler(fakeRequest({ method: 'POST' }), wrongMethod)
  assert.equal(wrongMethod.state.status, 405)

  const badJson = fakeResponse()
  await modeRoute.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: 'not json' }), badJson)
  assert.equal(badJson.state.status, 400)

  const badMode = fakeResponse()
  await modeRoute.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { mode: 'nope' } }), badMode)
  assert.equal(badMode.state.status, 400)

  // --- the tool -------------------------------------------------------------
  const tool = recorded.tools[0]
  const queried = await tool.execute({ mode: 'status' })
  assert.equal(queried.mode, 'clash')
  assert.match(queried.summary, /Clash/)
  assert.deepEqual(tool.output.render({ mode: 'status' }, queried), [{ type: 'text', text: queried.summary }])

  const flipped = await tool.execute({ mode: 'lan' })
  assert.equal(flipped.mode, 'lan')
  assert.equal(flipped.effective, 'lan')
  expectEnvRestored()
  await assert.rejects(() => tool.execute({ mode: 'nope' }), /unsupported mode/)

  await tool.execute({ mode: 'clash' })
  assert.equal(process.env.HTTPS_PROXY, proxyUrl)

  // --- the command ----------------------------------------------------------
  const command = recorded.commands[0]
  const statusText = await command.handler({ rawInput: 'status' })
  assert.equal(statusText.kind, 'success')
  assert.match(statusText.text, /出网/)

  assert.equal((await command.handler({ rawInput: 'lan' })).kind, 'success')
  expectEnvRestored()
  assert.equal((await command.handler({ rawInput: 'on' })).kind, 'success')
  assert.equal(process.env.HTTPS_PROXY, proxyUrl)

  const badArgument = await command.handler({ rawInput: 'wat' })
  assert.equal(badArgument.kind, 'error')
  assert.match(badArgument.text, /\/net clash \| \/net lan \| \/net status/)

  // --- a mode change is visible to the next state request -------------------
  await modeRoute.handler(fakeRequest({ method: 'POST', origin: 'http://127.0.0.1:19387', body: { mode: 'lan' } }), fakeResponse())
  const afterRoute = fakeResponse()
  await stateRoute.handler(fakeRequest(), afterRoute)
  assert.equal(afterRoute.json().mode, 'lan')

  // --- unload ---------------------------------------------------------------
  for (const { dispose } of disposers.reverse()) dispose()
  expectEnvRestored()
  await assert.rejects(fetch('http://8.8.8.8:8080/', { signal: AbortSignal.timeout(3000) }), 'the original dispatcher is back')
  const seenAtUnload = proxy.seen.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(proxy.seen.length, seenAtUnload)
})
