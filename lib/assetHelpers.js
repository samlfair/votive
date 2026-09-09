import fs from "node:fs"
import path from "node:path"

/** @import {TargetOutput} from "./createDatabase.js" */
/** @import {SourceInput} from "./bundle.js" */

/**
 * Every path votive stores or hands to a plugin is relative to
 * `sourceFolder`. This module is the one place that resolves one back to
 * a real filesystem path, and it does it lazily, at the moment bytes are
 * actually read - so a plugin never touches `node:fs` and an absolute
 * path never reaches the database or the cache.
 *
 * @param {string} sourceFolder
 * @param {string | null} relativePath
 */
function readers(sourceFolder, relativePath) {
  const resolve = () => path.resolve(sourceFolder, relativePath)
  return {
    buffer: () => fs.readFileSync(resolve()),
    stream: () => fs.createReadStream(resolve())
  }
}

/**
 * Wraps a target with lazy `buffer()`/`stream()` reads of its recorded
 * source file, so a copy-through `writeFile` hook (PDF, video, fonts,
 * ...) is one line:
 *
 *   function writeFile(target) {
 *     return { data: target.buffer() }
 *   }
 *
 * @param {TargetOutput} target
 * @param {string} sourceFolder
 * @returns {TargetOutput & { buffer: () => Buffer, stream: () => import("node:fs").ReadStream }}
 */
function withAssetHelpers(target, sourceFolder) {
  return { ...target, ...readers(sourceFolder, target.source) }
}

/**
 * Builds the `source` a `readFile` hook receives - the read-side mirror
 * of withAssetHelpers. `path` and `target` are both project-relative, so
 * a plugin can answer routing-shaped questions ("is this the root
 * settings file", "which folder is this in") directly, and `buffer()`
 * covers the case where it wants the raw bytes instead.
 *
 * @param {{path: string, target: string, text?: string}} source
 * @param {string} sourceFolder
 * @returns {SourceInput}
 */
function withSourceHelpers(source, sourceFolder) {
  return { ...source, ...readers(sourceFolder, source.path) }
}

export default withAssetHelpers
export { withAssetHelpers, withSourceHelpers }
