/**
 * dsh-net-switch — browser half.
 *
 * A status chip inside the Session header, immediately to the right of the
 * agent-preset (mode) chip: green `代理` (through Clash), grey `直连`, amber
 * `代理离线` (Clash selected but unreachable, so the host fell back to direct).
 * Clicking it posts the opposite mode to the host.
 *
 * Why this seat. `conversation.session.header.actions` is the header's own
 * "title-adjacent Session actions" list. The shipped entries there are
 * `subagent-catalog` (-30), `agent-team` (-20), `agent-preset` (-10) and
 * `job-list` (20), so registering at -5 puts this chip directly right of the mode
 * selector without touching any of them, and the header lays it out in normal
 * flow — it reflows with the window instead of hovering over the UI.
 *
 * The earlier revision floated in `shell.overlay`, which is
 * `position: absolute; inset: 0; z-index: 20; pointer-events: none` and sits
 * *under* the desktop shell's window-chrome band (min/max/close across the top
 * ~40px). A fixed pill there was invisible at `top: 10px` and covered the header
 * controls when moved below the band. A native list seat has neither problem.
 *
 * This file is a hand-written CommonJS bundle in the shape the DSH client module
 * loader expects (`window.__ModuleLoader__.load`), which keeps the plugin free of
 * any build step: `react` is the only module it requires, and every colour comes
 * from DSH's own theme tokens so light and dark both work.
 *
 * @module dsh-net-switch/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-net-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/dsh-net-switch/state'
    const MODE_URL = '/dsh-net-switch/mode'
    const POLL_MS = 3000

    /** The header's title-adjacent action list — the row the mode chip lives in. */
    const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'
    /**
     * Between `agent-preset` (order -10, the mode selector) and `job-list`
     * (order 20). Two neighbours are asserted in the client test so a future
     * reordering upstream is caught rather than silently moving this chip.
     */
    const HEADER_ACTIONS_ORDER = -5

    const TOKEN_SUCCESS = 'var(--dsw-alias-state-success-primary)'
    const TOKEN_WARN = 'var(--dsw-alias-state-warn-primary)'
    const TOKEN_IDLE = 'var(--dsw-alias-state-idle-primary)'
    const TOKEN_ERROR = 'var(--dsw-alias-state-error-primary)'

    /** Sized and shaped like the header chips it sits beside. */
    const CHIP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      height: '24px',
      padding: '0 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      userSelect: 'none',
      transition: 'background 120ms ease, opacity 120ms ease',
    }

    function dotStyle(color) {
      return {
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
      }
    }

    /** Derive the chip's presentation from one host status payload. */
    function presentation(status) {
      if (status === null || status === undefined) {
        return { text: '网络…', color: TOKEN_IDLE, title: '正在读取 Harness 出网状态' }
      }
      if (status.inProcessRouting === false) {
        return {
          text: '代理未接管',
          color: TOKEN_ERROR,
          title: 'undici 未解析，进程内请求未被接管；只有 shell 子进程会走代理',
        }
      }
      if (status.mode === 'clash') {
        if (status.degraded === true) {
          return {
            text: '代理离线',
            color: TOKEN_WARN,
            title: `已选择 Clash 代理 ${status.proxy}，但端口不可达，当前自动回退直连。点击切回直连。`,
          }
        }
        return {
          text: '代理',
          color: TOKEN_SUCCESS,
          title: `Harness 出网走 Clash 代理 ${status.proxy}（回环与私网段仍直连）。点击切回直连。`,
        }
      }
      return {
        text: '直连',
        color: TOKEN_IDLE,
        title: 'Harness 出网直连，局域网与本地服务可达。点击切到 Clash 代理。',
      }
    }

    function NetSwitchChip() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [hovered, setHovered] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        const load = () => {
          fetch(STATE_URL, { headers: { accept: 'application/json' } })
            .then((response) => (response.ok ? response.json() : null))
            .then((next) => {
              if (alive && next !== null) setStatus(next)
            })
            .catch(() => {})
        }
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const view = presentation(status)
      const style = Object.assign({}, CHIP_STYLE, {
        background: hovered && !busy ? 'var(--dsw-alias-bg-layer-2)' : CHIP_STYLE.background,
        color: hovered && !busy ? 'var(--dsw-alias-label-primary)' : CHIP_STYLE.color,
        opacity: busy ? 0.6 : 1,
      })

      const onClick = () => {
        if (busy) return
        const next = status !== null && status.mode === 'clash' ? 'lan' : 'clash'
        setBusy(true)
        fetch(MODE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((nextStatus) => {
            if (nextStatus !== null) setStatus(nextStatus)
          })
          .catch(() => {})
          .then(() => setBusy(false))
      }

      return h(
        'button',
        {
          type: 'button',
          style,
          title: view.title,
          onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          'aria-label': view.title,
        },
        h('span', { style: dotStyle(view.color) }),
        h('span', null, view.text),
      )
    }

    exports.name = 'dsh-net-switch'
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ctx.slots.inject(HEADER_ACTIONS_SLOT, () =>
        ctx.slots.register(
          {
            name: HEADER_ACTIONS_SLOT,
            id: 'dsh-net-switch',
            order: HEADER_ACTIONS_ORDER,
            label: () => 'net switch',
          },
          () => h(NetSwitchChip),
        ),
      )
    }

    return module.exports
  },
})
