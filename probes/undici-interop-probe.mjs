/**
 * Core-mechanism probe: does a dispatcher installed through the *npm* `undici`
 * package govern Node's built-in global `fetch`, and does a subclass dispatcher
 * (what this plugin installs) work there too?
 *
 * This is the one assumption the whole plugin rests on, so it is verified
 * against the exact undici copy the DSH desktop profile ships.
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The DSH profile whose undici copy this probe should exercise. */
function profileDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const named = join(home, 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  if (existsSync(join(named, 'node_modules', 'undici', 'package.json'))) return named
  const profiles = join(home, 'profiles')
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(profiles, entry.name)
      if (existsSync(join(candidate, 'node_modules', 'undici', 'package.json'))) return candidate
    }
  } catch {
    // No profiles directory: fall through to the named one.
  }
  return named
}

const PROFILE = profileDir()
const PROXY = 'http://127.0.0.1:7897'
const TARGET = 'https://www.google.com/generate_204'

const require = createRequire(join(PROFILE, 'package.json'))
const undici = require('undici')
console.log('undici version:', require('undici/package.json').version)
console.log('has setGlobalDispatcher:', typeof undici.setGlobalDispatcher, '| ProxyAgent:', typeof undici.ProxyAgent, '| Dispatcher:', typeof undici.Dispatcher)

async function check(label) {
  try {
    const response = await fetch(TARGET, { signal: AbortSignal.timeout(7000) })
    console.log(`${label}: OK ${response.status}`)
    return true
  } catch (error) {
    console.log(`${label}: ERR ${error.message}`)
    return false
  }
}

// The true direct transport is whatever was global before we touch anything.
const original = undici.getGlobalDispatcher()

// 1) plain ProxyAgent installed through the npm package
undici.setGlobalDispatcher(new undici.ProxyAgent(PROXY))
await check('1 npm-undici ProxyAgent -> global fetch')

// 2) a subclass dispatcher that picks its route per request (the plugin's shape)
const direct = original
let mode = 'lan'
class SwitchDispatcher extends undici.Dispatcher {
  dispatch(options, handler) {
    return (mode === 'clash' ? proxyAgent : direct).dispatch(options, handler)
  }
}
const proxyAgent = new undici.ProxyAgent(PROXY)
const switchDispatcher = new SwitchDispatcher()
undici.setGlobalDispatcher(switchDispatcher)

mode = 'clash'
await check('2 subclass dispatcher, mode=clash -> global fetch')
mode = 'lan'
const directWorked = await check('3 subclass dispatcher, mode=lan (expect failure) -> global fetch')
console.log(directWorked ? 'RESULT: LAN mode did NOT bypass (unexpected)' : 'RESULT: LAN mode bypassed the proxy as intended')
