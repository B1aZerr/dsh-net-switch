/**
 * dsh-net-switch — host half.
 *
 * This module exists so the loader has a *stable, versioned* entry: DSH caches an
 * imported plugin module by its resolved URL, so replacing the implementation
 * under a new file name is what lets a `link:`-installed plugin pick up host-side
 * changes without restarting the whole application.
 *
 * The implementation lives in [./plugin.js](plugin.js).
 *
 * @module dsh-net-switch
 */

export { apply, name, DEFAULT_CONFIG } from './plugin.js'
