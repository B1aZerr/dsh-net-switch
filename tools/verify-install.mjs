/**
 * Install verifier: asks the *running* DSH host whether dsh-net-switch is really
 * live, and checks the browser half against the inputs DSH itself composes from.
 *
 * The three things an install can silently get wrong:
 *   1. the host half loaded and owns in-process routing (`inProcessRouting: true`)
 *      — without undici it can only route child processes, not Harness's own fetch;
 *   2. the guest routes answer and the mutating one keeps its loopback fence;
 *   3. the browser half is declared and its bundle exists — DSH composes the client
 *      module table from `dsh.client` + `exports["./client"]`, and rejects a
 *      declared entry whose bundle path is missing.
 *
 * Why the browser bundle is not fetched over HTTP here: DSH serves client bundles
 * as a *combo* resource keyed by a revision, and the web surface is behind a
 * per-process launch token that only the desktop shell receives (over IPC). An
 * unauthenticated fetch therefore cannot distinguish "not composed" from "wrong
 * URL". Confirm the rendered chip through the Inspect bridge instead — ask for the
 * `conversation.session.header.actions` occupants — or simply look at the session
 * header, right of the mode selector.
 *
 * Usage:  node tools/verify-install.mjs [webUrl]        (default http://127.0.0.1:19387)
 *
 * @module dsh-net-switch/tools/verify-install
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = (process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '')
const PLUGIN_ID = 'dsh-net-switch'

let failures = 0
const pass = (message) => console.log(`  ok    ${message}`)
const fail = (message) => {
  failures += 1
  console.log(`  FAIL  ${message}`)
}
const note = (message) => console.log(`  note  ${message}`)

console.log(`${PLUGIN_ID} install check against ${BASE}\n`)

// 1. the host half -----------------------------------------------------------
console.log('host half')
let status
try {
  const response = await fetch(`${BASE}/dsh-net-switch/state`, { signal: AbortSignal.timeout(10_000) })
  if (response.status !== 200) {
    fail(`GET /dsh-net-switch/state -> ${response.status}`)
  } else {
    status = await response.json()
    pass(`GET /dsh-net-switch/state -> 200 (mode=${status.mode}, effective=${status.effective})`)
  }
} catch (error) {
  fail(`GET /dsh-net-switch/state threw: ${error.message}`)
}

if (status !== undefined) {
  if (status.inProcessRouting === true) {
    pass("undici resolved: Harness's own fetch (LLM, web, HTTP MCP) is governed by the switch")
  } else {
    fail(`in-process routing is NOT active: ${status.lastError ?? 'unknown reason'}`)
    note('run `node tools/link-undici.mjs`, then reload the net-switch entry or restart DSH')
  }

  if (status.reachable === true) pass(`proxy ${status.proxy} answered a TCP probe (discovered via ${status.proxySource})`)
  else fail(`proxy ${status.proxy} did not answer (discovered via ${status.proxySource})`)

  const expected = ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']
  const missing = expected.filter((entry) => !status.noProxy.includes(entry))
  if (missing.length === 0) pass('loopback and every private range stay bypassed')
  else fail(`NO_PROXY is missing ${missing.join(', ')}`)

  if (status.mode === 'clash' && status.effective === 'clash') {
    note('the switch is ON: agent shells carry the proxy environment')
  }
}

// 2. the route fence ---------------------------------------------------------
console.log('route fence')
try {
  const forbidden = await fetch(`${BASE}/dsh-net-switch/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ mode: 'clash' }),
  })
  if (forbidden.status === 403) pass('a cross-origin POST is refused (403)')
  else fail(`a foreign POST returned ${forbidden.status}, expected 403`)
} catch (error) {
  fail(`fence check threw: ${error.message}`)
}

// 3. the browser half's composition inputs -----------------------------------
console.log('browser half (composition inputs)')
try {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  const client = manifest.dsh?.client
  if (client?.platform === 'web') pass('package.json declares dsh.client.platform = "web"')
  else fail('package.json does not declare dsh.client.platform = "web"')

  const exported = manifest.exports?.['./client']
  const relative = typeof exported === 'string' ? exported : exported?.default
  if (typeof relative === 'string') pass(`exports["./client"] -> ${relative}`)
  else fail('exports["./client"] is missing, so DSH would never find the browser half')

  if (typeof relative === 'string') {
    const bundlePath = join(pluginRoot, relative)
    if (!existsSync(bundlePath)) {
      fail(`the declared bundle does not exist: ${bundlePath}`)
    } else {
      const source = readFileSync(bundlePath, 'utf8')
      if (source.includes('window.__ModuleLoader__.load')) pass('the bundle uses the module-loader wrapper DSH expects')
      else fail('the bundle does not call window.__ModuleLoader__.load')
      if (source.includes(`id: '${PLUGIN_ID}'`) || source.includes(`id: "${PLUGIN_ID}"`)) {
        pass(`the bundle identifies itself as ${PLUGIN_ID}`)
      } else {
        fail('the bundle id does not match the package name')
      }
      if (source.includes('conversation.session.header.actions')) pass('it registers into the session header action list')
      else fail('the bundle never mentions conversation.session.header.actions')
      if (client?.inject !== undefined && !Array.isArray(client.inject)) fail('dsh.client.inject must be an array')
    }
  }
  note('to confirm it rendered, ask the Inspect bridge for the session header action list')
  note('(cordis_inspect_query client Slots listSubTree root=conversation.session.header.actions -> registrant dsh-net-switch, order -5)')
} catch (error) {
  fail(`browser-half check threw: ${error.message}`)
}

console.log('')
if (failures === 0) {
  console.log('RESULT: all checks passed.')
  process.exit(0)
}
console.log(`RESULT: ${failures} check(s) failed.`)
console.log('If the host half needs a reload: toggle the "net-switch" entry off and on in')
console.log('设置 -> 插件 (or restart DSH Desktop). The browser half needs at most a page refresh.')
process.exit(1)
