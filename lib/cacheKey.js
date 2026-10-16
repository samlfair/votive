import { readFileSync } from "node:fs"
import { readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/** @import {VotiveConfig} from "./bundle.js" */

/**
 * What a build's cache was made by. Everything votive keeps between runs
 * - the database, the buffer cache - is derived from the source folder
 * *and the software*, and a warm start reuses it on the strength of the
 * files alone: an upgrade that changes a stylesheet vowel bundles, or how
 * a page is rendered, was never seen until someone cleared the cache.
 * So the cache records which software made it, and a different key
 * starts it over.
 *
 * The key is votive's own version plus the caller's `config.cacheKey`
 * (vowel passes its version), so upgrading either is enough. The output
 * folder isn't touched: a build from a fresh database writes every
 * target again.
 */

const VOTIVE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

/** @param {VotiveConfig} config */
function cacheKeyFor(config) {
  return [`votive@${VOTIVE_VERSION}`, config.cacheKey].filter(Boolean).join(" ")
}

const KEY_FILE = "cache-key"

/**
 * The buffer cache is a folder of `<hash>.json` results, outside the
 * database (readBuffers.js), so it keeps its own key: a file beside
 * them. A different key - or none, from a version before keys - empties
 * it. Checked on its own, not only when the database is discarded: after
 * `--clear` the database is new but the folder is the old one. A folder
 * that doesn't exist yet is left that way: nothing is cached in it, and
 * the first key is written on the next start that finds it.
 * @param {string} cacheDirectory
 * @param {string} key
 * @returns {Promise<boolean>} whether it was emptied
 */
async function syncBufferCache(cacheDirectory, key) {
  const entries = await readdir(cacheDirectory).catch(() => null)
  if (!entries) return false
  const stored = await readFile(path.join(cacheDirectory, KEY_FILE), "utf8").catch(() => undefined)
  if (stored === key) return false
  await Promise.all(entries.filter(name => name.endsWith(".json")).map(name => rm(path.join(cacheDirectory, name), { force: true })))
  await writeFile(path.join(cacheDirectory, KEY_FILE), key)
  return stored !== undefined || entries.some(name => name.endsWith(".json"))
}

export { VOTIVE_VERSION, cacheKeyFor, syncBufferCache }
