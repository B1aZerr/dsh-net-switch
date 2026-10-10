/**
 * One process-global dispatcher whose route is decided per request instead of
 * once at startup — which is the whole point of this plugin, since DSH's own
 * `dsh-http-proxy` resolves its policy before the first plugin loads.
 *
 * Only `dispatch` is intercepted: the proxy agent and the original direct
 * dispatcher each keep ownership of their own connection lifecycle.
 *
 * @module dsh-net-switch/dispatcher
 */

import { stripBrackets } from './policy.js'

/**
 * The hostname a dispatch option is addressed to, or `undefined` when the
 * origin is absent or unparseable.
 * @param {unknown} origin
 */
export function hostnameOf(origin) {
  if (origin === undefined || origin === null) return undefined
  try {
    return stripBrackets(new URL(String(origin)).hostname)
  } catch {
    return undefined
  }
}

/**
 * Build the switchable dispatcher.
 *
 * @param {object} options
 * @param {Function} options.Dispatcher - undici's `Dispatcher` class, injected so
 *   this module never imports a second undici instance.
 * @param {(options: unknown) => object} options.resolveRoute - returns the
 *   dispatcher (proxy or direct) that must carry one request.
 */
export function createSwitchDispatcher({ Dispatcher, resolveRoute }) {
  return new (class SwitchDispatcher extends Dispatcher {
    dispatch(options, handler) {
      const route = resolveRoute(options)
      return route.dispatch(options, handler)
    }
  })()
}
