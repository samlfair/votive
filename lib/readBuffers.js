import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"
import createPluginAPI from "./pluginAPI.js"
import applyReadResult from "./applyReadResult.js"
import { canonicalTargetPath } from "./createDatabase.js"
import { withSourceHelpers } from "./assetHelpers.js"

/** @import {VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFileResult} from "./readSources.js" */

/**
 * @typedef {object} BufferTask
 * @property {string} sourcePath
 * @property {string} targetFilePath
 * @property {string} extension
 * @property {() => Promise<import("./bundle.js").ReadHookResult>} run
 */

/**
 * Sketch of a filesystem cache for parsed buffer results, keyed by source
 * path only (not content or mtime) - per CLAUDE.md, these files are
 * expected to only need processing once, so this is closer to "survive a
 * process restart" than a real invalidation strategy. If that assumption
 * turns out wrong for some plugin, this is the thing to revisit.
 *
 * Hashed over the *project-relative* path, so the cache survives the
 * project moving - which is the whole reason it is a file on disk rather
 * than a database row.
 * @param {string} cacheDirectory
 * @param {string} sourcePath
 */
function cacheFilePath(cacheDirectory, sourcePath) {
  const hash = createHash("sha1").update(sourcePath).digest("hex")
  return path.join(cacheDirectory, `${hash}.json`)
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourcePath
 */
async function readCached(cacheDirectory, sourcePath) {
  try {
    return JSON.parse(await fs.readFile(cacheFilePath(cacheDirectory, sourcePath), "utf-8"))
  } catch (e) {
    return null
  }
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourcePath
 * @param {import("./bundle.js").ReadHookResult} result
 */
async function writeCached(cacheDirectory, sourcePath, result) {
  const cachePath = cacheFilePath(cacheDirectory, sourcePath)
  await fs.mkdir(path.dirname(cachePath), { recursive: true })
  await fs.writeFile(cachePath, JSON.stringify(result), "utf-8")
}

/**
 * Turns the pending-buffer descriptors readSources() produced (see the
 * format === "buffer" branch there) into deferred tasks: nothing here
 * reads a file or touches the database up front. The caller decides when
 * runBuffers() actually runs them - that's the "outside the build process"
 * part CLAUDE.md asked for; see bundle.js, which returns this alongside
 * (not merged into) its normal build queue.
 *
 * @param {ReadSourceFileResult[]} sources
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {{ tasks: BufferTask[], runBuffers: () => Promise<void> }}
 */
function readBuffers(sources, config, database) {
  const pending = sources.filter(source => source && source.readBuffer)
  const cacheDirectory = config.cacheDirectory || path.join(config.sourceFolder, ".cache")

  const tasks = pending.map(source => ({
    sourcePath: source.sourcePath,
    targetFilePath: source.targetFilePath,
    extension: source.extension,
    source,
    async run() {
      const cached = await readCached(cacheDirectory, source.sourcePath)
      if (cached) return cached

      // Same reasoning as readSources.js's text-format branch: readBuffer()
      // processes one source file in isolation, so it only gets the
      // write-only api (see ReadPluginAPI in bundle.js) - nothing it
      // might read (another target, folder settings) is guaranteed to
      // exist yet. It's the real api, bound up front to the routed
      // target path, which readBuffer() cannot move.
      //
      // Note the cache above short-circuits before this: on a cache hit
      // readBuffer() doesn't run, so any api.* call it would have made
      // doesn't happen either. Only its returned result is replayed
      // (below, in runBuffers). No buffer plugin uses the api today; if
      // one does, this is the thing to revisit, along with the rest of
      // the cache's stated limits.
      const readAPI = createPluginAPI(database, source.targetFilePath ? canonicalTargetPath(source.targetFilePath) : "", source.processor)

      // The same `source` shape readSources.js builds for a text
      // processor, so one readFile hook works for either format - the
      // only difference is that nothing was read for us, and the bytes
      // are behind source.buffer().
      const input = withSourceHelpers(
        { path: source.sourcePath, target: source.targetFilePath },
        config.sourceFolder
      )

      const result = await source.readBuffer(input, { api: readAPI, settings: undefined, config })
      await writeCached(cacheDirectory, source.sourcePath, result)
      return result
    }
  }))

  if(!tasks.length) return { runBuffers: null }

  const limit = pLimit(5)

  async function runBuffers() {
    await Promise.all(tasks.map(task => limit(async () => {
      let result
      try {
        result = await task.run()
      } catch (e) {
        console.error(e)
        return
      }

      const targetFilePath = task.targetFilePath
      const sourcePath = task.sourcePath

      // Scoped to the source file's own folder, not the target's - see
      // the identical note in readSources.js.
      // dirname() of a root-level file is ".", which is not how the root
      // folder is spelled anywhere else - it is "".
      const sourceFolder = path.dirname(sourcePath).replace(/^\.$/, "")

      applyReadResult(result, {
        database,
        targetPath: targetFilePath,
        sourcePath,
        settingsFolder: sourceFolder
      })

      const created = targetFilePath ? database.target.get(targetFilePath) : undefined
      database.source.create(sourcePath, created?.path ?? targetFilePath, task.source.lastModified)
    })))
  }

  return { tasks, runBuffers }
}

export default readBuffers
