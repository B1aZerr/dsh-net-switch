/**
 * One-shot reachability probe of a proxy's host:port. A raw TCP connect is the
 * right instrument here: it tests the proxy itself rather than a request routed
 * through it, so a probe can never be answered by the direct path.
 *
 * @module dsh-net-switch/probe
 */

import net from 'node:net'

/**
 * @param {string} proxyUrl
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probeProxy(proxyUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(proxyUrl)
    } catch {
      resolve(false)
      return
    }
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    const socket = net.connect({ host: target.hostname, port })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
    socket.on('timeout', () => done(false))
  })
}
