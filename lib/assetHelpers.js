import fs from "node:fs"
import path from "node:path"

/** @import {TargetOutput} from "./createDatabase.js" */

/**
 * Wraps a target with lazy `buffer()`/`stream()` methods reading from its
 * recorded `source` file path, so a copy-through `writeFile` hook (PDF,
 * video, fonts, ...) never needs to touch `node:fs` itself:
 *
 *   async function writeFile(target) {
 *     return { data: target.buffer() }
 *   }
 *
 * `target.source` is stored relative to `sourceFolder` (portable across
 * machines/absolute locations, like every other path in the database) -
 * `sourceFolder` is only ever consulted here, to resolve back to a real
 * fs path right at the point of reading bytes.
 * @param {TargetOutput} target
 * @param {string} sourceFolder
 * @returns {TargetOutput & { buffer: () => Buffer, stream: () => import("node:fs").ReadStream }}
 */
function withAssetHelpers(target, sourceFolder) {
  const resolveSource = () => path.resolve(sourceFolder, target.source)
  return {
    ...target,
    buffer: () => fs.readFileSync(resolveSource()),
    stream: () => fs.createReadStream(resolveSource())
  }
}

export default withAssetHelpers
export { withAssetHelpers }
