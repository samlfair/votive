import { writeFile, mkdir, rename } from "node:fs/promises"
import { hash } from "node:crypto"
import path from "node:path"
import YAML from "yaml"

/** @import {VotiveConfig} from "./bundle.js" */

/**
 * The URL store: fetched results, kept in the project as one YAML file
 * per URL, and read back as ordinary sources.
 *
 *   <store>/example.com/helpful-blog-post-3f9a2c1d.yaml
 *
 *     url: https://example.com/blog/post
 *     data:
 *       title: Helpful Blog Post
 *       description: A genuinely useful article.
 *
 * Every other row in the database is a pure function of the source
 * folder and the software, which is why the database is a cache and
 * wiping it is safe. A fetched URL is the one thing that is not: it is a
 * snapshot of someone else's page at the moment the author added the
 * link, and it is what the author saw and published. So the durable copy
 * lives here, in the project, and the `urls` table is a derived index of
 * these files - built by reading them, the way every other row is.
 *
 * **Votive owns the envelope and nothing inside it.** Two keys, `url` and
 * `data`, plus `redirect`/`canonical` for lookup and `fetched` for a
 * future refresh. `data` is whatever the processor's readURL returned,
 * kept verbatim, the way an abstract is. Owning the envelope is what
 * lets votive read a file back without the plugin's help, which is what
 * makes a cold start rebuild the index from files alone - and it is why
 * the files are sources: readSources parses them natively and hands each
 * entry to url.accumulate, attributed to the file, so editing one is an
 * ordinary edit and deleting one prunes it through source.delete.
 *
 * The model an author gets: the file is what the site shows. Edit it and
 * the edit wins forever. Delete it and the link is refetched. Commit the
 * folder and coworkers never fetch at all.
 *
 * The filename is *not* the identity - the URL inside the file is - so
 * it only has to be readable and deterministic. The processor names the
 * path (relative to the store, no extension); votive appends a short
 * tiebreaker from the full URL, because two URLs can slug identically
 * and a case-insensitive filesystem collides on case-only differences,
 * then the extension. Rename a file and nothing breaks.
 */

const EXTENSION = ".yaml"

/**
 * The store's folder, absolute. `config.urlStore` may be absolute or
 * relative to sourceFolder.
 * @param {VotiveConfig} config
 */
function storeFolder(config) {
  const configured = config.urlStore || ".urls"
  return path.isAbsolute(configured) ? configured : path.join(config.sourceFolder, configured)
}

/**
 * Eight hex characters of SHA-256 over the full URL: the suffix that
 * makes a readable name unique.
 * @param {string} url
 */
function tiebreaker(url) {
  return hash("sha256", url).slice(0, 8)
}

/**
 * Where a URL's file goes, relative to sourceFolder, from the path the
 * processor chose. Refuses a path that escapes the store.
 * @param {VotiveConfig} config
 * @param {string} chosen - from readURL: relative to the store, no extension
 * @param {string} url
 * @returns {string} relative to sourceFolder
 */
function entryPath(config, chosen, url) {
  if (typeof chosen !== "string" || !chosen || path.isAbsolute(chosen) || chosen.split(/[\\/]/).includes("..")) {
    throw new Error(`readURL for ${url} returned an unusable path: ${JSON.stringify(chosen)}. It must be relative to the URL store, without an extension.`)
  }
  // Refused on every platform, not just the one where it breaks: a path
  // that only fails on Windows is a bug someone else finds.
  if (/[<>:"|?*\u0000-\u001f]/.test(chosen)) {
    throw new Error(`readURL for ${url} returned a path with a character that is not portable: ${JSON.stringify(chosen)}. See hostSlug().`)
  }
  const folder = storeFolder(config)
  const absolute = path.join(folder, `${chosen}-${tiebreaker(url)}${EXTENSION}`)
  if (!absolute.startsWith(folder + path.sep)) {
    throw new Error(`readURL for ${url} returned a path outside the URL store: ${chosen}`)
  }
  return path.relative(config.sourceFolder, absolute)
}

/**
 * Parses one file's text. Throws naming the file on anything but the
 * envelope: silently treating a malformed file as empty would refetch
 * the link and overwrite the author's edits.
 * @param {string} text
 * @param {string} filePath - for the error
 * @returns {{ url: string, data: unknown, redirect?: string, canonical?: string, fetched?: string }}
 */
function parseEntry(text, filePath) {
  const parsed = YAML.parse(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.url !== "string" || !parsed.url) {
    throw new Error(`${filePath}: a URL file is YAML with a \`url\` string and a \`data\` value.`)
  }
  return parsed
}

/**
 * Writes one entry, to a temp file and renamed, so a crash mid-write
 * cannot leave a half-written file that fails to parse.
 * @param {VotiveConfig} config
 * @param {string} relativePath - from entryPath
 * @param {{ url: string, data: unknown, redirect?: string, canonical?: string, fetched?: string }} entry
 */
async function writeEntry(config, relativePath, entry) {
  const absolute = path.join(config.sourceFolder, relativePath)
  await mkdir(path.dirname(absolute), { recursive: true })
  // Key order is the envelope's, so every file reads the same way.
  const ordered = {
    url: entry.url,
    ...(entry.redirect ? { redirect: entry.redirect } : {}),
    ...(entry.canonical ? { canonical: entry.canonical } : {}),
    ...(entry.fetched ? { fetched: entry.fetched } : {}),
    data: entry.data ?? null
  }
  const temp = `${absolute}.${process.pid}.tmp`
  await writeFile(temp, YAML.stringify(ordered, { lineWidth: 0 }), "utf-8")
  await rename(temp, absolute)
}

/**
 * Is this path inside the store?
 * @param {VotiveConfig} config
 * @param {string} absolutePath
 */
function isStorePath(config, absolutePath) {
  const folder = storeFolder(config)
  return absolutePath === folder || absolutePath.startsWith(folder + path.sep)
}

/**
 * A url's host as a portable path segment: lowercased, a port's colon
 * turned into an underscore. The usual first segment of a readURL path.
 * @param {URL | string} url
 */
function hostSlug(url) {
  const { host } = url instanceof URL ? url : new URL(url)
  return host.toLowerCase().replaceAll(":", "_")
}

/** The URL's pathname extension, "" when it has none - what a `format: "url"` processor's extensions match. */
function urlExtension(url) {
  return path.extname(new URL(url).pathname)
}

export { storeFolder, tiebreaker, entryPath, parseEntry, writeEntry, isStorePath, urlExtension, hostSlug, EXTENSION }
