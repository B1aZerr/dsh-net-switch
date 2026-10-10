/**
 * Unit tests for the pure halves: NO_PROXY matching, proxy/mode resolution, the
 * child-process environment, and the persisted state file.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LOOPBACK_NO_PROXY,
  MODE_CLASH,
  MODE_LAN,
  NoProxyMatcher,
  PRIVATE_NO_PROXY,
  dedupe,
  normalizeProxy,
  parseCidr4,
  resolveMode,
  splitList,
  stripBrackets,
} from '../lib/policy.js'
import { PROXY_ENV_NAMES, publishProxyEnv, restoreProxyEnv, snapshotProxyEnv } from '../lib/env.js'
import { defaultStatePath, readState, writeState } from '../lib/state.js'

const matcher = new NoProxyMatcher([...LOOPBACK_NO_PROXY, ...PRIVATE_NO_PROXY])

test('loopback is always bypassed', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.53', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(matcher.bypass(host), true, host)
  }
})

test('private ranges are bypassed, public addresses are not', () => {
  for (const host of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.10', '169.254.1.1']) {
    assert.equal(matcher.bypass(host), true, host)
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '192.167.1.1', '11.0.0.1', 'example.com', 'api.deepseek.com']) {
    assert.equal(matcher.bypass(host), false, host)
  }
})

test('hostname entries match the name and its subdomains, but not lookalikes', () => {
  const scoped = new NoProxyMatcher(['example.com', '*.internal.test'])
  assert.equal(scoped.bypass('example.com'), true)
  assert.equal(scoped.bypass('api.example.com'), true)
  assert.equal(scoped.bypass('notexample.com'), false)
  assert.equal(scoped.bypass('internal.test'), true)
  assert.equal(scoped.bypass('nas.internal.test'), true)
  assert.equal(scoped.bypass('internal.test.evil.com'), false)
})

test('the wildcard entry bypasses everything', () => {
  assert.equal(new NoProxyMatcher(['*']).bypass('api.deepseek.com'), true)
})

test('CIDR parsing rejects what it cannot express', () => {
  assert.deepEqual(parseCidr4('10.0.0.0/8'), { base: 167772160, bits: 8 })
  assert.equal(parseCidr4('10.0.0.0/33'), undefined)
  assert.equal(parseCidr4('10.0.0.0'), undefined)
  assert.equal(parseCidr4('300.0.0.0/8'), undefined)
  assert.equal(parseCidr4('::1/8'), undefined)
})

test('brackets are stripped from IPv6 literals', () => {
  assert.equal(stripBrackets('[::1]'), '::1')
  assert.equal(stripBrackets('::1'), '::1')
  assert.equal(stripBrackets('127.0.0.1'), '127.0.0.1')
})

test('proxy URLs are validated, and SOCKS/PAC are rejected rather than borrowed', () => {
  assert.equal(normalizeProxy('http://127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.equal(normalizeProxy('  https://proxy.local:8443  '), 'https://proxy.local:8443')
  assert.equal(normalizeProxy('socks5://127.0.0.1:7898'), undefined)
  assert.equal(normalizeProxy('pac+http://x/proxy.pac'), undefined)
  assert.equal(normalizeProxy('not a url'), undefined)
  assert.equal(normalizeProxy(''), undefined)
  assert.equal(normalizeProxy(undefined), undefined)
})

test('mode vocabulary maps onto the two states', () => {
  assert.equal(resolveMode('clash'), MODE_CLASH)
  assert.equal(resolveMode('ON'), MODE_CLASH)
  assert.equal(resolveMode('proxy'), MODE_CLASH)
  assert.equal(resolveMode('lan'), MODE_LAN)
  assert.equal(resolveMode('off'), MODE_LAN)
  assert.equal(resolveMode('direct'), MODE_LAN)
  assert.equal(resolveMode('status'), undefined)
  assert.equal(resolveMode(''), undefined)
})

test('list helpers split, trim and de-duplicate', () => {
  assert.deepEqual(splitList('a, b  c\n\n'), ['a', 'b', 'c'])
  assert.deepEqual(splitList(undefined), [])
  assert.deepEqual(dedupe(['A', 'a', ' b ', '']), ['A', 'b'])
})

test('publishing and restoring the child environment is exact', () => {
  const env = { PATH: 'keep', HTTPS_PROXY: 'http://old:1', NO_PROXY: 'old.local' }
  const snapshot = snapshotProxyEnv(env)
  assert.equal(snapshot.HTTPS_PROXY, 'http://old:1')

  publishProxyEnv(env, { proxy: 'http://127.0.0.1:7897', noProxy: ['localhost', '10.0.0.0/8'] })
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    assert.equal(env[name], 'http://127.0.0.1:7897', name)
  }
  assert.equal(env.NO_PROXY, 'localhost,10.0.0.0/8')
  assert.equal(env.no_proxy, env.NO_PROXY)
  assert.equal(env.NODE_USE_ENV_PROXY, '1')

  restoreProxyEnv(env, snapshot)
  assert.deepEqual(env, { PATH: 'keep', HTTPS_PROXY: 'http://old:1', NO_PROXY: 'old.local' })
  for (const name of PROXY_ENV_NAMES) {
    if (name === 'HTTPS_PROXY' || name === 'NO_PROXY') continue
    assert.equal(name in env, false, `${name} must be removed, not set to undefined`)
  }
})

test('the remembered mode survives a round trip and tolerates junk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-net-switch-'))
  try {
    const path = join(dir, 'nested', 'state.json')
    assert.equal(readState(path), undefined, 'a missing file is not a preference')
    assert.equal(writeState(path, { mode: MODE_CLASH, updatedAt: '2026-01-01T00:00:00.000Z' }), true)
    assert.equal(readState(path).mode, MODE_CLASH)
    assert.equal(writeState(path, { mode: MODE_LAN, updatedAt: '2026-01-02T00:00:00.000Z' }), true)
    assert.equal(readState(path).mode, MODE_LAN)
    assert.equal(readState(path).updatedAt, '2026-01-02T00:00:00.000Z')

    const corrupt = join(dir, 'corrupt.json')
    writeState(corrupt, { mode: 'nonsense', updatedAt: 'x' })
    assert.equal(readState(corrupt), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default state path lives under DSH_HOME', () => {
  assert.equal(
    defaultStatePath({ DSH_HOME: 'C:\\Users\\x\\.dsh' }),
    join('C:\\Users\\x\\.dsh', 'storages', 'dsh-net-switch.json'),
  )
})
