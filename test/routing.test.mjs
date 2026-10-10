/**
 * End-to-end routing test. No mocks: a real `http.Server` plays the proxy, and
 * every assertion goes through the process-global `fetch`, which is exactly the
 * surface an LLM SDK uses. That is the property this plugin exists to control.
 *
 * Why these targets:
 *   - `http://8.8.8.8:8080/` is public, so the matcher sends it to the proxy, and a
 *     proxied request never resolves the name locally — no DNS needed. (Port 8080
 *     avoids the Fetch spec's blocked-port list, which rejects 9 outright.)
 *   - `http://127.0.0.1:<origin>` is loopback, so the matcher must bypass the
 *     proxy and reach the origin server directly.
 *   - `http://10.1.2.3:8080/` is RFC1918, so it must bypass the proxy too — which is
 *     observable as a failure, because nothing listens there.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createController } from '../lib/controller.js'
import { readState } from '../lib/state.js'

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

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

function json(server) {
  return `http://127.0.0.1:${server.address().port}`
}

async function body(response) {
  return JSON.parse(await response.text())
}

test('the switch routes global fetch through the proxy or direct, per request', async (t) => {
  const proxied = []
  // undici's ProxyAgent tunnels every target with CONNECT — the same thing Clash
  // Verge's mixed port does — so the fake proxy must answer the tunnel itself:
  // 200 Connection Established, then one HTTP response written straight into it.
  const proxy = await listen((request, response) => {
    proxied.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ via: 'proxy', url: request.url }))
  })
  proxy.on('connect', (request, clientSocket, head) => {
    proxied.push(request.url)
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let buffered = head && head.length > 0 ? head : Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!buffered.includes('\r\n\r\n')) return
      clientSocket.removeListener('data', onData)
      const payload = JSON.stringify({ via: 'proxy', target: request.url })
      clientSocket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\nconnection: close\r\n\r\n${payload}`,
      )
    }
    clientSocket.on('data', onData)
    clientSocket.on('error', () => {})
  })
  const origin = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ via: 'origin' }))
  })

  const proxyUrl = json(proxy)
  const originUrl = json(origin)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-net-switch-e2e-'))
  const statePath = join(dir, 'state.json')

  const controller = createController(
    { proxy: proxyUrl, mode: 'clash', statePath, probeIntervalMs: 60_000, probeTimeoutMs: 1000 },
    SILENT,
  )
  t.after(async () => {
    controller.dispose()
    await close(proxy)
    await close(origin)
    rmSync(dir, { recursive: true, force: true })
  })

  await controller.start()
  const started = controller.status()
  assert.equal(started.inProcessRouting, true, 'undici must resolve for in-process routing')
  assert.equal(started.mode, 'clash')
  assert.equal(started.reachable, true)
  assert.equal(started.effective, 'clash')

  // A public address is tunnelled to the proxy instead of being resolved locally.
  const viaProxy = await body(await fetch('http://8.8.8.8:8080/', { signal: AbortSignal.timeout(5000) }))
  assert.equal(viaProxy.via, 'proxy')
  assert.equal(proxied.length, 1)
  assert.equal(proxied[0], '8.8.8.8:8080', 'the proxy is asked for the CONNECT tunnel')

  // Loopback reaches the origin directly, even while the proxy is selected.
  assert.equal((await body(await fetch(`${originUrl}/loopback`))).via, 'origin')

  // A private address bypasses the proxy as well, so nothing answers it.
  await assert.rejects(fetch('http://10.1.2.3:8080/', { signal: AbortSignal.timeout(3000) }))

  // Child processes were given the same route.
  assert.equal(process.env.HTTPS_PROXY, proxyUrl)
  assert.equal(process.env.HTTP_PROXY, proxyUrl)
  assert.equal(process.env.NODE_USE_ENV_PROXY, '1')
  assert.match(process.env.NO_PROXY, /192\.168\.0\.0\/16/)

  // Flip to direct: the choice is persisted, the environment is restored, and
  // the same public address is now attempted directly (and fails, as it must).
  assert.equal(controller.setMode('lan', 'test'), true)
  await controller.refreshReachability()
  assert.equal(controller.status().mode, 'lan')
  assert.equal(controller.status().effective, 'lan')
  expectEnvRestored()
  await assert.rejects(fetch('http://8.8.8.8:8080/', { signal: AbortSignal.timeout(3000) }))
  assert.equal(proxied.length, 1, 'no further request may reach the proxy')
  assert.equal((await body(await fetch(`${originUrl}/direct`))).via, 'origin')
  assert.equal(readState(statePath).mode, 'lan')

  // Unloading restores the original dispatcher and the original environment.
  controller.dispose()
  await assert.rejects(fetch('http://8.8.8.8:8080/', { signal: AbortSignal.timeout(3000) }))
  assert.equal(proxied.length, 1)
  expectEnvRestored()
})

test('an unreachable proxy fails open and reports itself as degraded', async (t) => {
  const controller = createController(
    { proxy: 'http://127.0.0.1:1', mode: 'clash', persist: false, probeIntervalMs: 60_000, probeTimeoutMs: 700 },
    SILENT,
  )
  t.after(() => controller.dispose())

  await controller.start()
  const status = controller.status()
  assert.equal(status.mode, 'clash', 'the chosen mode is kept, not silently rewritten')
  assert.equal(status.reachable, false)
  assert.equal(status.degraded, true)
  assert.equal(status.effective, 'lan', 'traffic must keep flowing while Clash is down')
  assert.equal(status.envPublished, false, 'no proxy environment may be published while degraded')
  expectEnvRestored()
  assert.match(status.summary, /回退/)
})

test('autoFallback:false keeps the proxy selected even when it is down', async (t) => {
  const controller = createController(
    { proxy: 'http://127.0.0.1:1', mode: 'clash', persist: false, autoFallback: false, probeIntervalMs: 60_000, probeTimeoutMs: 700 },
    SILENT,
  )
  t.after(() => controller.dispose())

  await controller.start()
  const status = controller.status()
  assert.equal(status.degraded, true)
  assert.equal(status.effective, 'clash', 'an explicit "no fallback" must not be overridden')
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:1')
})
