/**
 * Behavioral test for the browser half. DSH serves this file to the page, so the
 * test loads the real bundle, drives it through a minimal hook runtime standing in
 * for React, and checks the things that break silently in a real GUI: the header
 * seat it registers into and its order relative to the mode selector, that it never
 * positions itself over the UI, and the mode the click actually posts.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

let loadCount = 0

/** Load the bundle the way the DSH module loader does, and hand back its definition. */
async function loadBundle() {
  let captured
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  try {
    await import(`${pathToFileURL(CLIENT_PATH).href}?load=${loadCount++}`)
  } finally {
    delete globalThis.window
  }
  assert.ok(captured, 'the bundle must call window.__ModuleLoader__.load')
  return captured
}

/**
 * A hook runtime small enough to be obviously correct: state slots by hook order,
 * effects run once, and re-rendering reuses the stored state.
 */
function createReactStub() {
  const states = []
  const ranEffects = new Set()
  const cleanups = []
  let cursor = 0
  let renderTarget = null

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [
        states[index],
        (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next
        },
      ]
    },
    useEffect(callback) {
      const index = cursor++
      if (ranEffects.has(index)) return
      ranEffects.add(index)
      const cleanup = callback()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }

  return {
    React,
    /** Render the component the registration returned, and hand back its tree. */
    render(component) {
      const element = component()
      renderTarget = element.type
      cursor = 0
      return renderTarget(element.props)
    },
    rerender() {
      cursor = 0
      return renderTarget({})
    },
    cleanups,
  }
}

/** Every string in the rendered tree, so a label can be asserted without DOM. */
function textsOf(node) {
  if (typeof node === 'string') return [node]
  if (node === null || node === undefined || typeof node !== 'object') return []
  const own = Array.isArray(node.children) ? node.children.flatMap(textsOf) : []
  return own
}

function findByType(node, type) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.type === type) return node
  for (const child of node.children ?? []) {
    const found = findByType(child, type)
    if (found !== undefined) return found
  }
  return undefined
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** Install a fake fetch + timer set, returning a restore function and the call log. */
function stubGlobals(statePayload) {
  const calls = []
  const originals = { fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
  const intervals = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const payload = url === '/dsh-net-switch/state' ? statePayload.current : statePayload.next
    return { ok: true, json: async () => payload }
  }
  globalThis.setInterval = (callback, ms) => {
    const handle = { callback, ms }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = () => {}
  return {
    calls,
    intervals,
    restore() {
      globalThis.fetch = originals.fetch
      globalThis.setInterval = originals.setInterval
      globalThis.clearInterval = originals.clearInterval
    },
  }
}

test('the chip registers into the header action list, right of the mode selector, and posts the opposite mode', async () => {
  const definition = await loadBundle()
  assert.equal(definition.id, 'dsh-net-switch')

  const statePayload = {
    current: {
      mode: 'lan',
      effective: 'lan',
      reachable: true,
      degraded: false,
      proxy: null,
      inProcessRouting: true,
    },
    next: {
      mode: 'clash',
      effective: 'clash',
      reachable: true,
      degraded: false,
      proxy: 'http://127.0.0.1:7897',
      inProcessRouting: true,
    },
  }
  const stub = stubGlobals(statePayload)
  const runtime = createReactStub()

  try {
    const exportsObject = definition.factory((specifier) => {
      assert.equal(specifier, 'react', 'react is the only module the bundle requires')
      return runtime.React
    })

    assert.equal(exportsObject.name, 'dsh-net-switch')
    assert.deepEqual(exportsObject.inject, ['slots'])

    const injections = []
    const registrations = []
    exportsObject.apply({
      slots: {
        inject(key, callback) {
          injections.push(key)
          callback()
        },
        register(options, component) {
          registrations.push({ options, component })
          return () => {}
        },
      },
    })

    assert.deepEqual(
      injections,
      ['conversation.session.header.actions'],
      'the header action list is the seat that reflows with the Session header',
    )
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'conversation.session.header.actions')
    assert.equal(registrations[0].options.id, 'dsh-net-switch')
    // The chip must land immediately right of the mode selector. In this list the
    // shipped entries are subagent-catalog (-30), agent-team (-20),
    // agent-preset (-10, the mode selector) and job-list (20); asserting the
    // window rather than the literal -5 catches an upstream reorder instead of
    // silently drifting to the end of the row.
    assert.ok(
      registrations[0].options.order > -10 && registrations[0].options.order < 20,
      `order ${registrations[0].options.order} must fall between agent-preset (-10) and job-list (20)`,
    )

    // First paint, before the state request settles.
    const first = runtime.render(registrations[0].component)
    const button = findByType(first, 'button')
    assert.ok(button, 'the chip is a button')
    assert.deepEqual(textsOf(first), ['网络…'])
    // Laid out in flow, sized like the chips beside it — never positioned over the
    // UI. That is the whole point of registering into a native header slot.
    assert.equal(button.props.style.position, undefined, 'no fixed/absolute positioning')
    assert.equal(button.props.style.top, undefined)
    assert.equal(button.props.style.right, undefined)
    assert.equal(button.props.style.zIndex, undefined)
    assert.equal(button.props.style.display, 'inline-flex')
    assert.equal(button.props.style.height, '24px')
    assert.equal(stub.intervals.length, 1, 'the chip polls the host route')

    // The poll lands: mode lan reads as direct.
    await flush()
    await flush()
    const second = runtime.rerender()
    assert.deepEqual(textsOf(second), ['直连'])

    // Clicking posts the opposite mode and adopts the response.
    findByType(second, 'button').props.onClick()
    await flush()
    await flush()
    const posted = stub.calls.find((call) => call.url === '/dsh-net-switch/mode')
    assert.ok(posted, 'clicking must POST the mode route')
    assert.equal(posted.init.method, 'POST')
    assert.deepEqual(JSON.parse(posted.init.body), { mode: 'clash' })
    assert.deepEqual(textsOf(runtime.rerender()), ['代理'])

    for (const cleanup of runtime.cleanups) cleanup()
  } finally {
    stub.restore()
  }
})

test('a selected-but-unreachable proxy is presented as degraded', async () => {
  const definition = await loadBundle()
  const statePayload = {
    current: {
      mode: 'clash',
      effective: 'lan',
      reachable: false,
      degraded: true,
      proxy: 'http://127.0.0.1:7897',
      inProcessRouting: true,
    },
    next: null,
  }
  const stub = stubGlobals(statePayload)
  const runtime = createReactStub()

  try {
    const exportsObject = definition.factory(() => runtime.React)
    const registrations = []
    exportsObject.apply({
      slots: {
        inject(_key, callback) { callback() },
        register(options, component) { registrations.push({ options, component }); return () => {} },
      },
    })

    runtime.render(registrations[0].component)
    await flush()
    await flush()
    const tree = runtime.rerender()
    assert.deepEqual(textsOf(tree), ['代理离线'])
    assert.match(findByType(tree, 'button').props.title, /不可达/)

    for (const cleanup of runtime.cleanups) cleanup()
  } finally {
    stub.restore()
  }
})

test('hover restyles the chip without moving it', async () => {
  const definition = await loadBundle()
  const stub = stubGlobals({
    current: {
      mode: 'clash',
      effective: 'clash',
      reachable: true,
      degraded: false,
      proxy: 'http://127.0.0.1:7897',
      inProcessRouting: true,
    },
    next: null,
  })
  const runtime = createReactStub()
  try {
    const exportsObject = definition.factory(() => runtime.React)
    let registration
    exportsObject.apply({
      slots: {
        inject(_key, callback) { callback() },
        register(options, component) { registration = { options, component }; return () => {} },
      },
    })

    const rest = findByType(runtime.render(registration.component), 'button')
    const restBackground = rest.props.style.background

    rest.props.onMouseEnter()
    const hovered = findByType(runtime.rerender(), 'button')
    assert.notEqual(hovered.props.style.background, restBackground, 'hover changes the surface')
    assert.equal(hovered.props.style.position, undefined, 'and never becomes positioned')
    assert.equal(hovered.props.style.top, undefined)

    hovered.props.onMouseLeave()
    const left = findByType(runtime.rerender(), 'button')
    assert.equal(left.props.style.background, restBackground, 'leaving restores it')

    for (const cleanup of runtime.cleanups) cleanup()
  } finally {
    stub.restore()
  }
})

test('the bundle is what DSH expects to serve', () => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  // The loader wrapper must be the file's only executable construct: no bare ESM
  // imports (which the loader cannot resolve) and no stray top-level statements
  // outside the factory.
  assert.match(source, /window\.__ModuleLoader__\.load\(\{\n\s+id: 'dsh-net-switch',/)
  assert.doesNotMatch(source, /^\s*import\s/m, 'a client bundle must not use bare ESM imports')
  assert.doesNotMatch(source, /^\s*export\s/m, 'a client bundle must not use ESM exports')
})
