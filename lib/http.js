/**
 * HTTP plumbing for the plugin's own routes, and the request fence in front of
 * them. The routes can change where every byte the harness sends actually goes,
 * so they are loopback-only and — for the mutating one — carry a same-origin
 * tripwire: a browser on another page cannot POST to them, because it would have
 * to forge an `Origin` that already matches the loopback `Host`.
 *
 * @module dsh-net-switch/http
 */

import { stripBrackets } from './policy.js'

/** Write one JSON response. */
export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** The `Host` header's hostname, without port or IPv6 brackets. */
function hostHeaderName(request) {
  const host = String(request?.headers?.host ?? '')
  if (host === '') return ''
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return stripBrackets(name).toLowerCase()
}

/** Whether the request arrived on a loopback authority. */
export function isLoopbackRequest(request) {
  const name = hostHeaderName(request)
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/**
 * Whether a mutating request carries a browser same-origin marker. A missing
 * `Origin` (curl, a host-side caller) passes: the loopback fence already applies.
 */
export function isSameOriginRequest(request) {
  const origin = request?.headers?.origin
  if (origin === undefined || origin === '') return true
  try {
    return new URL(String(origin)).host.toLowerCase() === String(request?.headers?.host ?? '').toLowerCase()
  } catch {
    return false
  }
}

/** Read a small JSON request body. */
export async function readJsonBody(request, limit = 8192) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('request body must be JSON')
  }
}
