/**
 * Pure routing policy: mode vocabulary, proxy-URL validation and the NO_PROXY
 * matcher. No I/O and no transport import here, so this module is cheap to unit
 * test and safe to load before undici is resolved.
 *
 * @module dsh-net-switch/policy
 */

/** Outbound mode: everything goes through the local proxy. */
export const MODE_CLASH = 'clash'
/** Outbound mode: direct, which is what keeps the LAN and the loopback reachable. */
export const MODE_LAN = 'lan'
/** The two switchable modes, in documentation order. */
export const MODES = [MODE_CLASH, MODE_LAN]

/** Clash Verge Rev's default mixed port. */
export const DEFAULT_PROXY = 'http://127.0.0.1:7897'

/**
 * Loopback entries. These are never optional: a proxy that also serves the
 * harness's own loopback traffic turns the Web UI, the Connection transport and
 * every local test server into a routing loop.
 */
export const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']

/**
 * Private-range entries. DSH's own `dsh-http-proxy` bypasses the loopback only,
 * so the LAN would otherwise be tunnelled through Clash. Note the asymmetry: our
 * in-process matcher understands CIDR, while the same string is published to
 * children because `curl` understands CIDR in `NO_PROXY` — Node's matcher simply
 * ignores the entries it cannot parse.
 */
export const PRIVATE_NO_PROXY = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
]

/** `URL.hostname` keeps the brackets of an IPv6 literal; the matcher does not. */
export function stripBrackets(host) {
  const text = String(host ?? '')
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
}

/** Pack one dotted-quad into an unsigned 32-bit integer. */
export function ipv4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = ((value << 8) | octet) >>> 0
  }
  return value
}

/** Parse an IPv4 CIDR range, or `undefined` when the text is not one. */
export function parseCidr4(text) {
  const [ip, bitsText] = String(text).split('/')
  const bits = Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return undefined
  const base = ipv4ToInt(ip)
  if (base === undefined) return undefined
  return { base, bits }
}

/** `::ffff:10.0.0.5` addresses the same host as the bare IPv4 form. */
function ipv4Mapped(host) {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
  return match === null ? undefined : match[1]
}

function isIpv4Literal(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * Compiles NO_PROXY entries into a reusable matcher. Entries may be `*`, an
 * exact hostname or a suffix (optionally `*.`-prefixed), an IPv4/IPv6 literal,
 * or an IPv4 CIDR range.
 */
export class NoProxyMatcher {
  /** @param {readonly string[]} entries */
  constructor(entries) {
    /** @type {Array<{kind: string, value?: string, base?: number, bits?: number}>} */
    const rules = []
    for (const raw of entries ?? []) {
      const entry = stripBrackets(String(raw).trim().toLowerCase())
      if (entry === '') continue
      if (entry === '*') {
        rules.push({ kind: 'all' })
        continue
      }
      if (entry.includes('/')) {
        const cidr = parseCidr4(entry)
        if (cidr !== undefined) rules.push({ kind: 'cidr4', ...cidr })
        continue
      }
      if (isIpv4Literal(entry) || entry.includes(':')) {
        rules.push({ kind: 'ip', value: entry })
        continue
      }
      rules.push({ kind: 'hostname', value: entry.replace(/^\*\./, '') })
    }
    this.rules = rules
  }

  /**
   * Whether a hostname/IP must skip the proxy.
   * @param {string} hostname
   */
  bypass(hostname) {
    const raw = stripBrackets(String(hostname ?? '')).toLowerCase()
    if (raw === '') return false
    const mapped = ipv4Mapped(raw)
    const literal = isIpv4Literal(raw) ? raw : mapped
    const numeric = literal === undefined ? undefined : ipv4ToInt(literal)
    for (const rule of this.rules) {
      if (rule.kind === 'all') return true
      if (rule.kind === 'hostname' && (raw === rule.value || raw.endsWith('.' + rule.value))) return true
      if (rule.kind === 'ip' && (raw === rule.value || literal === rule.value)) return true
      if (rule.kind === 'cidr4' && numeric !== undefined) {
        const mask = rule.bits === 0 ? 0 : (~0 << (32 - rule.bits)) >>> 0
        if ((numeric & mask) === (rule.base & mask)) return true
      }
    }
    return false
  }
}

/**
 * Validate one proxy URL. Only `http:`/`https:` forward proxies are routed;
 * SOCKS and PAC URLs are rejected rather than silently borrowed by another
 * scheme (the same call DSH's own `dsh-http-proxy` makes).
 *
 * @param {unknown} value
 * @returns {string | undefined} the trimmed URL, or `undefined` when unusable.
 */
export function normalizeProxy(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return trimmed
}

/**
 * Map user-facing vocabulary onto a mode. Deliberately generous, because the
 * same parser serves the config file, the GUI, the tool and the command.
 *
 * @param {unknown} value
 * @returns {'clash' | 'lan' | undefined}
 */
export function resolveMode(value) {
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'clash':
    case 'proxy':
    case 'on':
    case 'clash-on':
      return MODE_CLASH
    case 'lan':
    case 'direct':
    case 'off':
    case 'local':
    case 'clash-off':
      return MODE_LAN
    default:
      return undefined
  }
}

/** Split a comma/whitespace separated NO_PROXY value into entries. */
export function splitList(value) {
  if (typeof value !== 'string') return []
  return value.split(/[,\s]+/).filter((entry) => entry !== '')
}

/** Order-preserving de-duplication, case-insensitive for host entries. */
export function dedupe(entries) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    const text = String(entry ?? '').trim()
    if (text === '') continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}
