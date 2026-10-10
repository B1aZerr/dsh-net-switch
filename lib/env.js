/**
 * Child-process proxy environment. Harness's own requests go through the
 * switchable dispatcher; the shell an agent drives only ever learns about the
 * proxy through these variables, so both halves must be flipped together.
 *
 * Both casings of every name are always written or cleared together: undici
 * reads the lowercase name first, and a stale uppercase value would otherwise
 * shadow a cleared lowercase one.
 *
 * @module dsh-net-switch/env
 */

/** Every environment name that carries proxy configuration. */
export const PROXY_ENV_NAMES = [
  'http_proxy',
  'HTTP_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
]

/**
 * Capture the proxy-relevant environment so a later restore is exact.
 * @param {Record<string, string | undefined>} [env]
 */
export function snapshotProxyEnv(env = process.env) {
  /** @type {Record<string, string | undefined>} */
  const snapshot = {}
  for (const name of PROXY_ENV_NAMES) snapshot[name] = env[name]
  return snapshot
}

/**
 * Publish one proxy route for child processes.
 *
 * `NODE_USE_ENV_PROXY` is what makes a child Node process honour these values in
 * its own `fetch` (Node reads the flag at process start, which is precisely why
 * the in-process half cannot rely on it). Node's matcher only understands host
 * entries, while `curl` also understands CIDR, so the one published list serves
 * both.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ proxy: string, noProxy: readonly string[] }} route
 */
export function publishProxyEnv(env, route) {
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    env[name] = route.proxy
  }
  const list = route.noProxy.join(',')
  env.no_proxy = list
  env.NO_PROXY = list
  env.NODE_USE_ENV_PROXY = '1'
}

/**
 * Put the environment back exactly as {@link snapshotProxyEnv} found it.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, string | undefined>} snapshot
 */
export function restoreProxyEnv(env, snapshot) {
  for (const name of PROXY_ENV_NAMES) {
    const value = snapshot[name]
    if (value === undefined) delete env[name]
    else env[name] = value
  }
}
