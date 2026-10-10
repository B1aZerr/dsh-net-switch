/**
 * The switch itself. One controller owns: the resolved proxy, the two modes, the
 * process-global dispatcher that routes each request by the current mode, the
 * child-process environment, the reachability probe and the remembered choice.
 *
 * The failure posture is fail-open and self-describing: when Clash is selected
 * but the proxy port does not answer, requests are routed direct (so an agent is
 * never bricked by a proxy the user just quit) while the state keeps reporting
 * `mode: clash`, `degraded: true`, so the GUI pill and every tool result say so.
 *
 * @module dsh-net-switch/controller
 */

import { detectProxy, readClashVergeState } from './detect.js'
import { createSwitchDispatcher, hostnameOf } from './dispatcher.js'
import { publishProxyEnv, restoreProxyEnv, snapshotProxyEnv } from './env.js'
import {
  LOOPBACK_NO_PROXY,
  MODE_CLASH,
  MODE_LAN,
  NoProxyMatcher,
  PRIVATE_NO_PROXY,
  dedupe,
  resolveMode,
  splitList,
} from './policy.js'
import { probeProxy } from './probe.js'
import { defaultStatePath, readState, writeState } from './state.js'
import { loadUndici } from './undici-loader.js'

/** Defaults for every config key this plugin understands. */
export const DEFAULT_CONFIG = {
  enabled: true,
  proxy: undefined,
  mode: undefined,
  noProxy: [],
  autoFallback: true,
  probeIntervalMs: 5000,
  probeTimeoutMs: 2000,
  persist: true,
  statePath: undefined,
  publishEnvToChildren: true,
}

const NOOP_LOGGER = { info() {}, warn() {}, error() {} }

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

/**
 * @param {object} [config] - the loader entry's `config`.
 * @param {{ info: Function, warn: Function, error: Function }} [logger]
 */
export function createController(config = {}, logger = NOOP_LOGGER) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  const detected = detectProxy(cfg.proxy)
  const proxy = detected.proxy
  const statePath = typeof cfg.statePath === 'string' && cfg.statePath !== '' ? cfg.statePath : defaultStatePath()
  const persisted = cfg.persist === false ? undefined : readState(statePath)
  const intervalMs = positiveNumber(cfg.probeIntervalMs, DEFAULT_CONFIG.probeIntervalMs)
  const probeTimeoutMs = positiveNumber(cfg.probeTimeoutMs, DEFAULT_CONFIG.probeTimeoutMs)

  const noProxy = dedupe([
    ...LOOPBACK_NO_PROXY,
    ...PRIVATE_NO_PROXY,
    ...(Array.isArray(cfg.noProxy) ? cfg.noProxy : []),
    ...splitList(process.env.NO_PROXY ?? process.env.no_proxy ?? ''),
  ])
  const matcher = new NoProxyMatcher(noProxy)
  const envSnapshot = snapshotProxyEnv()

  /** @type {any} */
  let undici
  /** @type {any} */
  let direct
  /** @type {any} */
  let switchDispatcher
  /** @type {any} */
  let proxyAgent
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer
  let disposed = false
  let envPublished = false
  let reachable = false
  /** @type {Promise<boolean> | undefined} */
  let inFlightProbe

  const state = {
    mode: resolveMode(cfg.mode) ?? persisted?.mode ?? MODE_LAN,
    effective: MODE_LAN,
    reachable: false,
    degraded: false,
    proxy,
    proxySource: detected.source,
    clashVerge: detected.clashVerge ?? readClashVergeState() ?? null,
    noProxy,
    inProcessRouting: false,
    envPublished: false,
    childEnv: cfg.publishEnvToChildren !== false,
    persist: cfg.persist !== false,
    statePath: cfg.persist === false ? null : statePath,
    autoFallback: cfg.autoFallback !== false,
    since: persisted?.updatedAt ?? new Date().toISOString(),
    switches: 0,
    lastChangeSource: persisted !== undefined ? 'state-file' : 'startup',
    lastError: null,
  }

  /** The dispatcher one request must use, decided now rather than at startup. */
  function resolveRoute(options) {
    if (state.effective !== MODE_CLASH || direct === undefined) return direct
    const hostname = hostnameOf(options?.origin)
    // An origin we cannot parse keeps the pre-existing behaviour instead of
    // being tunnelled on a guess.
    if (hostname === undefined) return direct
    return matcher.bypass(hostname) ? direct : proxyDispatcher()
  }

  function proxyDispatcher() {
    if (proxyAgent === undefined) proxyAgent = new undici.ProxyAgent({ uri: proxy })
    return proxyAgent
  }

  /** Recompute the derived fields, then make the child environment agree. */
  function sync() {
    state.reachable = reachable
    state.degraded = state.mode === MODE_CLASH && !reachable
    state.effective = state.mode === MODE_CLASH && (reachable || state.autoFallback === false)
      ? MODE_CLASH
      : MODE_LAN

    if (state.childEnv) {
      const wantProxy = state.effective === MODE_CLASH
      if (wantProxy && !envPublished) {
        publishProxyEnv(process.env, { proxy, noProxy })
        envPublished = true
      } else if (!wantProxy && envPublished) {
        restoreProxyEnv(process.env, envSnapshot)
        envPublished = false
      }
    }
    state.envPublished = envPublished
    return state
  }

  function persist() {
    if (cfg.persist === false) return false
    const written = writeState(statePath, { mode: state.mode, updatedAt: state.since, proxy })
    if (!written) state.lastError = `state file is not writable: ${statePath}`
    return written
  }

  /** Probe once; concurrent callers share the same in-flight probe. */
  function refreshReachability() {
    if (disposed) return Promise.resolve(reachable)
    if (inFlightProbe !== undefined) return inFlightProbe
    inFlightProbe = probeProxy(proxy, probeTimeoutMs)
      .catch(() => false)
      .then((up) => {
        inFlightProbe = undefined
        if (disposed) return up
        reachable = up
        const verge = readClashVergeState()
        if (verge !== undefined) state.clashVerge = verge
        sync()
        return up
      })
    return inFlightProbe
  }

  /**
   * Change the mode.
   * @param {unknown} next
   * @param {string} source - who asked, for the status surface.
   */
  function setMode(next, source = 'api') {
    const resolved = resolveMode(next)
    if (resolved === undefined) return false
    if (state.mode === resolved) return true
    state.mode = resolved
    state.since = new Date().toISOString()
    state.switches += 1
    state.lastChangeSource = source
    sync()
    persist()
    return true
  }

  /** Resolve undici and replace the process-global dispatcher. */
  async function install() {
    try {
      undici = loadUndici()
    } catch (error) {
      state.inProcessRouting = false
      state.lastError = error instanceof Error ? error.message : String(error)
      logger.warn(`in-process routing unavailable: ${state.lastError}`)
      sync()
      return false
    }
    if (disposed) return false
    direct = undici.getGlobalDispatcher()
    switchDispatcher = createSwitchDispatcher({ Dispatcher: undici.Dispatcher, resolveRoute })
    undici.setGlobalDispatcher(switchDispatcher)
    state.inProcessRouting = true
    sync()
    return true
  }

  function startProbing() {
    if (timer !== undefined || disposed) return
    timer = setInterval(() => { void refreshReachability() }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function start() {
    sync()
    await install()
    await refreshReachability()
    startProbing()
    logger.info(`mode=${state.mode} effective=${state.effective} proxy=${proxy} (${state.proxySource})`)
    return state
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (envPublished) {
      restoreProxyEnv(process.env, envSnapshot)
      envPublished = false
    }
    if (undici !== undefined && switchDispatcher !== undefined && undici.getGlobalDispatcher() === switchDispatcher) {
      undici.setGlobalDispatcher(direct)
    }
    const agent = proxyAgent
    proxyAgent = undefined
    if (agent !== undefined && typeof agent.close === 'function') {
      try {
        void Promise.resolve(agent.close()).catch(() => {})
      } catch {
        // Closing proxy sockets is best-effort on unload.
      }
    }
    state.envPublished = false
  }

  /** Human/agent-readable one-liner describing the current route. */
  function describe() {
    const parts = []
    if (state.mode === MODE_LAN) {
      parts.push('出网：直连（局域网与回环可达）')
    } else if (state.effective === MODE_CLASH) {
      parts.push(`出网：Clash 代理 ${proxy}（可达）`)
    } else {
      parts.push(`出网：Clash 代理 ${proxy} 不可达，已自动回退直连`)
    }
    parts.push(`绕过 ${noProxy.length} 条（回环 + 私网段）`)
    if (state.childEnv) parts.push(state.envPublished ? '子进程已同步代理环境' : '子进程为直连')
    if (!state.inProcessRouting) parts.push('警告：undici 未解析，进程内请求未被接管')
    if (state.lastError !== null) parts.push(`注意：${state.lastError}`)
    return parts.join('；')
  }

  /** JSON-safe snapshot for the route, the tool and the command. */
  function status() {
    return {
      mode: state.mode,
      effective: state.effective,
      reachable: state.reachable,
      degraded: state.degraded,
      // Always reported: "which proxy would this switch use" is worth knowing in
      // both modes, and the verifier/tool text reads it while direct too.
      proxy,
      proxySource: state.proxySource,
      clashVerge: state.clashVerge,
      noProxy,
      inProcessRouting: state.inProcessRouting,
      envPublished: state.envPublished,
      persist: state.persist,
      statePath: state.statePath,
      autoFallback: state.autoFallback,
      since: state.since,
      switches: state.switches,
      lastChangeSource: state.lastChangeSource,
      lastError: state.lastError,
      summary: describe(),
    }
  }

  return {
    config: cfg,
    state,
    proxy,
    noProxy,
    describe,
    status,
    setMode,
    refreshReachability,
    start,
    dispose,
    get disposed() { return disposed },
  }
}
