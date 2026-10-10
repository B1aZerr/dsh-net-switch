/**
 * Diagnostic: how are client bundles actually served, and is dsh-net-switch's
 * composed? Compares against client plugins that are known to render here.
 *
 * Reproduced from @deepseek-ai/dsh-client-modules:
 *   artifactRev = framedHash("plugin-artifact", [mtimeMs, ctimeMs, size])
 *   comboRev    = framedHash("combo", [id, artifactRev, ...])
 *   url         = /plugins/??<id>/client.js&rev=<comboRev>
 *
 * @module dsh-net-switch/probes/bundle-url-probe
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = (process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '')
const PROFILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop')

function framedHash(domain, parts) {
  const hash = createHash('sha1').update(domain).update('\0')
  for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part)
  return hash.digest('hex').slice(0, 12)
}

function artifactRevision(path) {
  const stats = statSync(path)
  return framedHash('plugin-artifact', [String(stats.mtimeMs), String(stats.ctimeMs), String(stats.size)])
}

function clientExportOf(exportsField) {
  const client = exportsField?.['./client']
  if (typeof client === 'string') return client
  if (client !== null && typeof client === 'object' && typeof client.default === 'string') return client.default
  return undefined
}

const candidates = [
  'dsh-net-switch',
  '@linxin666/dsh-client-ui-task-board',
  'dshmarket',
]

for (const id of candidates) {
  const packageDir = join(PROFILE, 'node_modules', id)
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    console.log(`${id}: not installed\n`)
    continue
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const relative = clientExportOf(manifest.exports)
  if (relative === undefined) {
    console.log(`${id}: no exports["./client"]\n`)
    continue
  }
  const absolute = join(packageDir, relative)
  const revision = artifactRevision(absolute)
  const combo = framedHash('combo', [id, revision])
  const fileName = relative.replace(/^\.\//, '').replace(/^.*\//, '')

  const urls = [
    `/plugins/??${id}/${fileName}&rev=${combo}`,
    `/plugins/??${id}/${fileName}&rev=${combo}&map`,
    `/plugins/${id}/${fileName}?rev=${revision}`,
  ]
  console.log(`${id}\n  file: ${absolute}\n  artifactRev=${revision} comboRev=${combo}`)
  for (const url of urls) {
    try {
      const response = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(8000) })
      const body = response.status === 200 ? await response.text() : ''
      const says = body.includes(id) ? ', identifies itself' : ''
      console.log(`  ${response.status}  ${url}${body === '' ? '' : `  (${body.length}B${says})`}`)
    } catch (error) {
      console.log(`  ERR ${url} (${error.message})`)
    }
  }
  console.log('')
}
