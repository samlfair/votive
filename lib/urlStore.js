import { readFile, writeFile, readdir, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import YAML from "yaml"

/** @import {VotiveConfig} from "./bundle.js" */

/**
 * The URL store: fetched results, kept in the project as one YAML file
 * per host.
 *
 *   <store>/
 *     example.com.yaml
 *     friendly-blog.net.yaml
 *
 * Every other row in the database is a pure function of the source folder
 * and the software, which is why the database is a cache and wiping it is
 * safe. A fetched URL is the one thing that is not: it is a snapshot of
 * someone else's page at the moment the author added the link, and it is
 * what the author saw and published. Keeping it in the disposable layer
 * meant a new machine, a coworker, or a temporary environment refetched
 * every link - and a refetch is an unreviewed edit to a live page, since
 * the page at the other end may have changed hands since.
 *
 * So the durable copy lives here, inside the project, and the `urls`
 * table is a derived index of it: seeded from these files when the
 * database opens, written through on every successful fetch. The model
 * this gives an author is simple - **the file is what the site shows**.
 * Edit an entry and the edit wins forever. Delete one and the link is
 * refetched. Commit the folder and coworkers never fetch at all.
 *
 * One file per host rather than one per URL or one for everything: a
 * host file is browsable, needs no encoding of the URL (it is the key
 * inside), bounds the damage of a bad hand-edit to one site's links, and
 * conflicts in git only when two people add links to the same host. The
 * only thing encoded is the host in the filename.
 *
 * The shape of `data` is the plugin's, the same way an abstract is - the
 * store keeps it verbatim under a `data` key and never looks inside.
 * Failure state (cooldowns) deliberately stays in the database: it is
 * per-machine, and its timestamps would churn in a shared repo.
 */

/**
 * @typedef {object} URLEntry
 * @property {unknown} data - what the asking processor's readURL produced
 * @property {string} [redirect]
 * @property {string} [canonical]
 * @property {string} [fetched] - ISO date of the fetch that produced it
 */

const EXTENSION = ".yaml"

/**
 * The store's folder, absolute. `config.urlStore` may be absolute or
 * relative to sourceFolder; the default is a hidden folder, which the
 * source scan already ignores. Vowel points it at a visible one.
 * @param {VotiveConfig} config
 */
function storeFolder(config) {
  const configured = config.urlStore || ".urls"
  return path.isAbsolute(configured) ? configured : path.join(config.sourceFolder, configured)
}

/**
 * The filename a URL's host maps to. Lowercased, because hosts are
 * case-insensitive; a port's colon becomes an underscore, because a
 * colon is illegal in a Windows filename.
 *
 * This is the seam for a future non-HTTP scheme: `new URL` parses the
 * authority of any scheme it knows, and one that it doesn't would need
 * its own case here and its own fetcher in fetchURLs.js.
 * @param {string} url
 * @returns {string} a filename, without the folder
 */
function hostFile(url) {
  const { host } = new URL(url)
  return host.toLowerCase().replaceAll(":", "_") + EXTENSION
}

/**
 * Loads one host file. A missing file is an empty map; a malformed one
 * is an error naming the file, because silently treating it as empty
 * would refetch every link in it and overwrite the author's edits.
 * @param {string} filePath
 * @returns {Promise<Map<string, URLEntry>>}
 */
async function loadHostFile(filePath) {
  let text
  try {
    text = await readFile(filePath, "utf-8")
  } catch (error) {
    if (error.code === "ENOENT") return new Map()
    throw error
  }

  const parsed = YAML.parse(text)
  if (parsed === null || parsed === undefined) return new Map()
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: expected a map of url -> entry at the top level.`)
  }

  return new Map(Object.entries(parsed))
}

/**
 * Every entry in the store, keyed by URL.
 * @param {VotiveConfig} config
 * @returns {Promise<Map<string, URLEntry>>}
 */
async function loadStore(config) {
  const folder = storeFolder(config)
  let names
  try {
    names = await readdir(folder)
  } catch (error) {
    if (error.code === "ENOENT") return new Map()
    throw error
  }

  const all = new Map()
  for (const name of names.filter(n => n.endsWith(EXTENSION)).sort()) {
    const entries = await loadHostFile(path.join(folder, name))
    entries.forEach((entry, url) => all.set(url, entry))
  }
  return all
}

/**
 * Writes one host file, keys sorted so the diff in git is the entry that
 * changed and nothing else. Written to a temp file and renamed, so a
 * crash mid-write cannot leave a half-written file that fails to parse.
 * @param {string} filePath
 * @param {Map<string, URLEntry>} entries
 */
async function saveHostFile(filePath, entries) {
  await mkdir(path.dirname(filePath), { recursive: true })

  if (entries.size === 0) {
    await rm(filePath, { force: true })
    return
  }

  const sorted = Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  const text = YAML.stringify(sorted, { lineWidth: 0 })
  const temp = `${filePath}.${process.pid}.tmp`
  await writeFile(temp, text, "utf-8")
  await rename(temp, filePath)
}

/**
 * Records one fetched result.
 * @param {VotiveConfig} config
 * @param {string} url
 * @param {URLEntry} entry
 */
async function saveEntry(config, url, entry) {
  const filePath = path.join(storeFolder(config), hostFile(url))
  const entries = await loadHostFile(filePath)
  entries.set(url, entry)
  await saveHostFile(filePath, entries)
}

/**
 * Is this path inside the store? readSources uses it to keep the store
 * out of the source scan, and the dev server uses it to route a change
 * there to the store's own reload rather than to a build.
 * @param {VotiveConfig} config
 * @param {string} absolutePath
 */
function isStorePath(config, absolutePath) {
  const folder = storeFolder(config)
  return absolutePath === folder || absolutePath.startsWith(folder + path.sep)
}

export { storeFolder, hostFile, loadHostFile, loadStore, saveEntry, saveHostFile, isStorePath, EXTENSION }
