/**
 * Dev/`link:`-install shim. Testing and `link:`-installed plugins resolve bare
 * specifiers from the plugin's real path, which has no `node_modules` of its own;
 * a normal `file:` or npm install puts undici there properly.
 *
 * This script junctions the copy DSH already ships in the profile, so no network
 * access is needed. Run it once (or after moving the checkout):
 *
 *     node tools/link-undici.mjs
 *
 * @module dsh-net-switch/tools/link-undici
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const linkPath = join(pluginRoot, 'node_modules', 'undici')

function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
}

/** Every `node_modules/undici` a DSH installation may carry, best version first. */
function findCandidates() {
  const home = dshHome()
  const profilesDir = join(home, 'profiles')
  const roots = [profilesDir]
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(profilesDir, entry.name))
    }
  } catch {
    // No profiles directory: fall through with whatever we have.
  }

  const candidates = []
  for (const root of roots) {
    const candidate = join(root, 'node_modules', 'undici')
    const manifest = join(candidate, 'package.json')
    if (!existsSync(manifest)) continue
    let version = '0.0.0'
    try {
      version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? version
    } catch {
      // A readable directory with an unreadable manifest is still usable.
    }
    candidates.push({ path: candidate, version })
  }
  candidates.sort((left, right) => compareVersions(right.version, left.version))
  return candidates
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number)
  const b = String(right).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

const candidates = findCandidates()
if (candidates.length === 0) {
  console.error(`No DSH-shipped undici found under ${dshHome()}\\profiles.`)
  console.error('Install it instead:  npm install undici@^7     (or let `dsh plugin add` do it)')
  process.exit(1)
}

const chosen = candidates[0]
mkdirSync(join(pluginRoot, 'node_modules'), { recursive: true })

if (existsSync(linkPath)) {
  // Windows reports a directory junction as a plain directory, so `isSymbolicLink()`
  // is not the test: a resolved path that differs from the path itself is.
  const resolvedLink = realpathSync(linkPath)
  const isLink = resolvedLink.toLowerCase() !== resolve(linkPath).toLowerCase()
  if (!isLink) {
    console.log('node_modules/undici already exists as a real directory; leaving it alone.')
    process.exit(0)
  }
  // `rmdir` on a reparse point removes the link itself (unlink would fail: a
  // junction is a directory). A recursive delete would follow the junction and
  // empty the DSH-shipped copy it points at.
  rmdirSync(linkPath)
}

// A directory junction needs no administrator rights on Windows.
symlinkSync(chosen.path, linkPath, 'junction')
console.log(`linked undici@${chosen.version}`)
console.log(`  ${linkPath}`)
console.log(`  -> ${chosen.path}`)
