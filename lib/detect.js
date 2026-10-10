/**
 * Clash Verge Rev discovery. The proxy URL is read from, in order: explicit
 * plugin config, the launch environment, and finally Clash Verge's own
 * `verge.yaml` — which is how this plugin follows a user who moved the mixed
 * port. Nothing here writes to or controls Clash Verge; its own system-proxy and
 * TUN settings are only reported, because they describe a different layer
 * (Windows-wide) than the one this plugin switches (Harness egress).
 *
 * @module dsh-net-switch/detect
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PROXY, normalizeProxy } from './policy.js'

/** Directories Clash Verge Rev keeps its configuration in, most specific first. */
export function clashVergeConfigDirs(env = process.env) {
  const dirs = []
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev'))
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, 'io.github.clash-verge-rev.clash-verge-rev'))
  return dirs
}

function readVergeYaml(env) {
  for (const dir of clashVergeConfigDirs(env)) {
    try {
      return { dir, text: readFileSync(join(dir, 'verge.yaml'), 'utf8') }
    } catch {
      // Not installed there, or unreadable: try the next candidate.
    }
  }
  return undefined
}

function readNumber(text, key) {
  const match = new RegExp(`^${key}:\\s*['"]?(\\d{1,5})['"]?\\s*$`, 'm').exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return value > 0 && value < 65536 ? value : undefined
}

function readBoolean(text, key) {
  const match = new RegExp(`^${key}:\\s*(true|false)\\s*$`, 'm').exec(text)
  return match === null ? undefined : match[1] === 'true'
}

/**
 * What Clash Verge reports about itself, for display only.
 * @returns {{ configDir: string, mixedPort?: number, systemProxy?: boolean, tunMode?: boolean } | undefined}
 */
export function readClashVergeState(env = process.env) {
  const found = readVergeYaml(env)
  if (found === undefined) return undefined
  return {
    configDir: found.dir,
    mixedPort: readNumber(found.text, 'verge_mixed_port'),
    systemProxy: readBoolean(found.text, 'enable_system_proxy'),
    tunMode: readBoolean(found.text, 'enable_tun_mode'),
  }
}

/**
 * Resolve the proxy this plugin will switch to.
 *
 * @param {unknown} explicit - `config.proxy`, if the user set one.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ proxy: string, source: string, clashVerge?: object }}
 */
export function detectProxy(explicit, env = process.env) {
  const fromConfig = normalizeProxy(explicit)
  if (fromConfig !== undefined) return { proxy: fromConfig, source: 'config.proxy' }

  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = normalizeProxy(env[name])
    if (value !== undefined) return { proxy: value, source: `env:${name}` }
  }

  const verge = readClashVergeState(env)
  if (verge?.mixedPort !== undefined) {
    return { proxy: `http://127.0.0.1:${verge.mixedPort}`, source: 'clash-verge:verge.yaml', clashVerge: verge }
  }

  return { proxy: DEFAULT_PROXY, source: 'default', clashVerge: verge }
}
