import fs from "node:fs"

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
 * @param {TargetOutput} target
 * @returns {TargetOutput & { buffer: () => Buffer, stream: () => import("node:fs").ReadStream }}
 */
function withAssetHelpers(target) {
  return {
    ...target,
    buffer: () => fs.readFileSync(target.source),
    stream: () => fs.createReadStream(target.source)
  }
}

export default withAssetHelpers
export { withAssetHelpers }
