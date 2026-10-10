/**
 * dsh-net-switch — runtime network switch for DeepSeek Harness.
 *
 * Harness resolves its outbound proxy policy once, before any plugin loads
 * (that is what `@deepseek-ai/dsh-http-proxy` does), and ignores the Windows
 * system proxy entirely. This plugin replaces the process-global undici
 * dispatcher with one that decides per request, so the whole of Harness's
 * egress — LLM calls, web search/fetch, HTTP MCP traffic — can be flipped
 * between a local Clash Verge proxy and direct/LAN without a restart. The same
 * flip rewrites the child-process proxy environment, so `git`, `curl`, `npm` and
 * the agent's shell follow the same route.
 *
 * Three surfaces drive one controller: the GUI pill (these routes), the
 * `network_mode` agent tool, and the `/net` command.
 *
 * @module dsh-net-switch
 */

import { createController, DEFAULT_CONFIG } from './controller.js'
import { isLoopbackRequest, isSameOriginRequest, readJsonBody, sendJson } from './http.js'
import { MODE_CLASH, MODE_LAN, MODES, resolveMode } from './policy.js'

export const name = 'dsh-net-switch'
export { DEFAULT_CONFIG }

const STATE_ROUTE = '/dsh-net-switch/state'
const MODE_ROUTE = '/dsh-net-switch/mode'

const TOOL_NAME = 'network_mode'
const COMMAND_NAME = 'net'

const TOOL_DESCRIPTION = [
  '切换或查询 Harness 自己的出网方式。',
  'clash：Harness 的 LLM 调用、web 搜索/抓取、HTTP MCP 以及 shell 子进程全部走本地 Clash Verge 代理（回环与私网段始终直连）。',
  'lan：全部直连，局域网设备与本地服务可达（当前默认）。',
  'status：只读查询，不改变任何状态。',
  '当直连访问某个境外站点或服务失败时（例如 git clone、npm、被墙的文档站），先切到 clash 再重试；需要访问 NAS、局域网 IP 或本地服务时切回 lan。',
].join(' ')

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    mode: {
      type: 'string',
      enum: [MODE_CLASH, MODE_LAN, 'status'],
      description: 'clash = 经 Clash 代理出网；lan = 直连（含局域网）；status = 只读查询当前状态。',
    },
  },
  required: ['mode'],
  additionalProperties: false,
}

// Kept strictly inside DSH's `JsonSchemaNode` vocabulary: single-valued `type`,
// `enum`, `required`, `additionalProperties`. The richer status fields (proxy,
// noProxy, clashVerge, …) ride along in the value without being declared, which
// the schema permits because it does not close the object.
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    effective: { type: 'string' },
    reachable: { type: 'boolean' },
    degraded: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['mode', 'effective', 'reachable', 'summary'],
}

/**
 * Log through the host's logger when there is one, and stderr otherwise: this
 * plugin must be able to report a failure before any service is available.
 */
function makeLogger(ctx) {
  const write = (level, message) => {
    const logger = ctx?.logger
    const method = logger?.[level]
    if (typeof method === 'function') {
      try {
        method.call(logger, message)
        return
      } catch {
        // Fall through to stderr.
      }
    }
    process.stderr.write(`[dsh-net-switch] ${message}\n`)
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  if (cfg.enabled === false) return

  const logger = makeLogger(ctx)
  const controller = createController(cfg, logger)

  // The dispatcher and the child environment are this plugin's whole reason to
  // exist: unload must restore the exact previous dispatcher and environment.
  ctx.effect(() => () => controller.dispose(), 'dsh-net-switch: dispatcher')

  void controller.start().catch((error) => {
    logger.error(`startup failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // ---- GUI surface: the pill polls state, and posts a new mode --------------
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer

    const stateHandler = (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(response, 405, { error: 'use GET' })
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { error: 'loopback only' })
        return
      }
      sendJson(response, 200, controller.status())
    }

    const modeHandler = async (request, response) => {
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'use POST' })
        return
      }
      if (!isLoopbackRequest(request) || !isSameOriginRequest(request)) {
        sendJson(response, 403, { error: 'loopback same-origin only' })
        return
      }
      let body
      try {
        body = await readJsonBody(request)
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      const requested = typeof body?.mode === 'string'
        ? body.mode
        : body?.toggle === true
          ? (controller.state.mode === MODE_CLASH ? MODE_LAN : MODE_CLASH)
          : undefined
      const resolved = resolveMode(requested)
      if (resolved === undefined) {
        sendJson(response, 400, { error: `mode must be one of ${MODES.join(', ')}` })
        return
      }
      controller.setMode(resolved, 'gui')
      await controller.refreshReachability()
      sendJson(response, 200, controller.status())
    }

    hostCtx.effect(
      () => webServer.register({ kind: 'exact', path: STATE_ROUTE, handler: stateHandler }),
      'dsh-net-switch: state route',
    )
    hostCtx.effect(
      () => webServer.register({ kind: 'exact', path: MODE_ROUTE, handler: modeHandler }),
      'dsh-net-switch: mode route',
    )
  })

  // ---- Agent surface: the model can flip it while it works ------------------
  ctx.inject(['tools'], (hostCtx) => {
    const definition = {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render(_args, value) {
          return [{ type: 'text', text: String(value?.summary ?? '') }]
        },
      },
      async execute(args) {
        const requested = typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : ''
        if (requested !== 'status') {
          const resolved = resolveMode(requested)
          if (resolved === undefined) {
            throw new Error(`unsupported mode "${requested}"; expected one of: ${MODE_CLASH}, ${MODE_LAN}, status`)
          }
          controller.setMode(resolved, 'tool')
          await controller.refreshReachability()
        }
        return controller.status()
      },
      // Flipping the global route is process-wide, never concurrent with a
      // sibling tool call in the same step.
      isConcurrencySafe() {
        return false
      },
    }
    hostCtx.effect(() => hostCtx.tools.register(definition), 'dsh-net-switch: tool')
  })

  // ---- Human surface: /net clash | /net lan | /net status -------------------
  ctx.inject(['commands'], (hostCtx) => {
    const definition = {
      name: COMMAND_NAME,
      description: '切换 Harness 出网模式：Clash 代理 / 直连局域网',
      input: { hint: `${MODES.join(' | ')} | status` },
      async handler(invocation) {
        const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
        if (argument === '' || argument === 'status') {
          return { kind: 'success', text: controller.describe() }
        }
        const resolved = resolveMode(argument)
        if (resolved === undefined) {
          return {
            kind: 'error',
            text: `未知参数「${argument}」；用法：/${COMMAND_NAME} ${MODES.join(` | /${COMMAND_NAME} `)} | /${COMMAND_NAME} status`,
          }
        }
        controller.setMode(resolved, 'command')
        await controller.refreshReachability()
        return { kind: 'success', text: controller.describe() }
      },
    }
    hostCtx.effect(() => hostCtx.commands.register(definition), 'dsh-net-switch: command')
  })
}
