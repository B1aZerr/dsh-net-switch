/**
 * Durability for the one fact worth surviving a restart: which mode the user
 * last chose. The file lives under DSH_HOME rather than inside the plugin,
 * because a `link:`-installed plugin directory may be read-only or shared.
 *
 * Every failure here is non-fatal by design: an unwritable state file degrades
 * to "the switch still works, it just does not remember".
 *
 * @module dsh-net-switch/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveMode } from './policy.js'

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultStatePath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-net-switch.json')
}

/**
 * Read the remembered mode. A missing, truncated or hand-edited file is treated
 * as "no preference" rather than as an error.
 *
 * @param {string} path
 * @returns {{ mode: 'clash' | 'lan', updatedAt?: string, proxy?: string } | undefined}
 */
export function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const mode = resolveMode(parsed?.mode)
    if (mode === undefined) return undefined
    return {
      mode,
      updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
      proxy: typeof parsed?.proxy === 'string' ? parsed.proxy : undefined,
    }
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen mode atomically (write beside, then rename).
 *
 * @param {string} path
 * @param {{ mode: string, updatedAt: string, proxy?: string }} value
 * @returns {boolean} whether the write landed.
 */
export function writeState(path, value) {
  const temporary = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
    return true
  } catch {
    return false
  }
}
