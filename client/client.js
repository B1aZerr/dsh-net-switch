/**
 * dsh-net-switch — browser half.
 *
 * A status pill in the top-right of the window chrome: green `代理` (through
 * Clash), grey `直连`, amber `代理离线` (Clash selected but unreachable, so the
 * host fell back to direct). Clicking it posts the opposite mode to the host.
 *
 * Placement is deliberate. `shell.overlay` is
 * `position: absolute; inset: 0; z-index: 20; pointer-events: none`, and the
 * desktop shell's own window-chrome band owns min/max/close across the top ~40px
 * and paints over it. A pill at `top: 10px` was therefore completely invisible
 * under those buttons, so the offset follows the band: the shell marks
 * `document.documentElement[data-windows-titlebar]` when the band exists, and the
 * pill starts below it. `top: 10px` remains correct for a shell without the band.
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

    /** Roughly the height of the desktop window-chrome band. */
    const TITLEBAR_CLEARANCE_PX = 48

    const TOKEN_SUCCESS = 'var(--dsw-alias-state-success-primary)'
    const TOKEN_WARN = 'var(--dsw-alias-state-warn-primary)'
    const TOKEN_IDLE = 'var(--dsw-alias-state-idle-primary)'
    const TOKEN_ERROR = 'var(--dsw-alias-state-error-primary)'

    const BASE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '3px 10px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 1px 4px rgba(0, 0, 0, 0.12)',
      transition: 'opacity 120ms ease',
      position: 'fixed',
      right: '12px',
      zIndex: 60,
    }

    function hasWindowTitlebar() {
      return typeof document !== 'undefined'
        && document.documentElement !== null
        && document.documentElement.hasAttribute('data-windows-titlebar')
    }

    function dotStyle(color) {
      return {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
      }
    }

    /** Derive the pill's presentation from one host status payload. */
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

    function NetSwitchPill() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

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
      const style = Object.assign({}, BASE_STYLE, {
        top: hasWindowTitlebar() ? `${TITLEBAR_CLEARANCE_PX}px` : '10px',
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
          'aria-label': view.title,
        },
        h('span', { style: dotStyle(view.color) }),
        h('span', null, view.text),
      )
    }

    exports.name = 'dsh-net-switch'
    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'dsh-net-switch', order: 50, label: () => 'net switch' },
          () => h(NetSwitchPill),
        ),
      )
    }

    return module.exports
  },
})
