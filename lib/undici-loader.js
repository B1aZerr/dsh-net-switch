/**
 * Resolve the `undici` instance whose global dispatcher this plugin replaces.
 *
 * This is the most environment-sensitive part of the plugin, and the reason it has
 * four sources instead of one `import('undici')`:
 *
 *  - The host process (the Electron main process of DSH Desktop) does **not**
 *    necessarily export `DSH_HOME` / `DSH_PROFILE`; those are injected into agent
 *    subprocesses, not into the app itself. So the profile path cannot be the only
 *    candidate.
 *  - A `link:`-installed plugin resolves to its real path in the checkout, where
 *    there is no `node_modules` to walk up to.
 *
 * Order matters and is deliberate: the instance already in the require cache is
 * DSH's own (its `@deepseek-ai/dsh-http-proxy` imports undici), and sharing it is
 * what guarantees that our `setGlobalDispatcher` lands on the same module registry
 * the rest of the host reads from. Everything else is a fallback.
 *
 * @module dsh-net-switch/undici-loader
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A CJS `require` bound to this module; also exposes the shared require cache. */
function binder() {
  return createRequire(import.meta.url)
}

/** The undici that the host process already loaded, if any. */
function fromRequireCache(require) {
  const cache = require.cache
  if (cache === null || typeof cache !== 'object') return undefined
  const pattern = /[\\/]node_modules[\\/]undici[\\/](?:index|dist[\\/]undici)\.(?:js|cjs)$/
  for (const key of Object.keys(cache)) {
    if (!pattern.test(key)) continue
    try {
      const loaded = require(key)
      if (typeof loaded?.setGlobalDispatcher === 'function' && typeof loaded?.ProxyAgent === 'function') return loaded
    } catch {
      // A cache entry we cannot re-require is simply skipped.
    }
  }
  return undefined
}

/** `$DSH_HOME` when the host exports it, plus the conventional location. */
function dshHomes(env) {
  const homes = []
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') homes.push(env.DSH_HOME.trim())
  const fallback = join(homedir(), '.dsh')
  if (!homes.includes(fallback)) homes.push(fallback)
  return homes
}

/** Every profile directory worth probing, whether or not `DSH_PROFILE` is set. */
function profileDirs(env) {
  const dirs = []
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.trim() !== ''
    ? env.DSH_PROFILE.trim()
    : undefined
  for (const home of dshHomes(env)) {
    const profilesDir = join(home, 'profiles')
    if (profile !== undefined) dirs.push(join(profilesDir, profile))
    dirs.push(profilesDir)
    try {
      for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(join(profilesDir, entry.name))
      }
    } catch {
      // No profiles directory in this home.
    }
  }
  return dirs
}

/** Copies shipped inside the application itself (Electron's `process.resourcesPath`). */
function bundledPaths() {
  const paths = []
  const resources = process.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    paths.push(join(resources, 'app.asar', 'dsh', 'node_modules', 'undici'))
    paths.push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', 'undici'))
  }
  return paths
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {any} the resolved undici module namespace.
 * @throws when no candidate can provide undici.
 */
export function loadUndici(env = process.env) {
  const require = binder()

  const cached = fromRequireCache(require)
  if (cached !== undefined) return cached

  const attempts = []
  const specifiers = ['undici']
  for (const dir of profileDirs(env)) specifiers.push(join(dir, 'node_modules', 'undici'))
  for (const path of bundledPaths()) specifiers.push(path)

  const seen = new Set()
  for (const specifier of specifiers) {
    if (seen.has(specifier)) continue
    seen.add(specifier)
    if (specifier !== 'undici' && !existsSync(specifier)) continue
    try {
      const loaded = require(specifier)
      if (typeof loaded?.setGlobalDispatcher === 'function' && typeof loaded?.ProxyAgent === 'function') return loaded
      attempts.push(`${specifier}: resolved but exposes no setGlobalDispatcher/ProxyAgent`)
    } catch (error) {
      attempts.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`undici could not be resolved, so in-process routing is unavailable (${attempts.join(' | ')})`)
}
