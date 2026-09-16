import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"
import createPluginAPI from "./pluginAPI.js"
import applyReadResult from "./applyReadResult.js"
import { settingsFolderFor } from "./router.js"
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
function cacheFilePath(cacheDirectory, sourcePath, stub) {
  // A stub has no mtime and no bytes on disk, so its params are the only
  // thing that can say "this is different now". Folding them into the key
  // makes a changed payload a cache miss. This is the one place a digest
  // is still used, because a filename needs a fixed length - and it runs
  // once per changed stub, not once per stub per pass.
  const key = stub === undefined || stub === null ? sourcePath : `${sourcePath}\u0000${stub}`
  const hash = createHash("sha1").update(key).digest("hex")
  return path.join(cacheDirectory, `${hash}.json`)
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourcePath
 */
async function readCached(cacheDirectory, sourcePath, stub) {
  try {
    return JSON.parse(await fs.readFile(cacheFilePath(cacheDirectory, sourcePath, stub), "utf-8"))
  } catch (e) {
    return null
  }
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourcePath
 * @param {import("./bundle.js").ReadHookResult} result
 */
async function writeCached(cacheDirectory, sourcePath, result, stub) {
  const cachePath = cacheFilePath(cacheDirectory, sourcePath, stub)
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
    stub: source.stub,
    source,
    async run() {
      const cached = await readCached(cacheDirectory, source.sourcePath, source.stub)
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
      // A stub has no file, so its bytes are whatever expand() produced
      // rather than a lazy read of a path that does not exist.
      const input = source.stubBuffer !== undefined
        ? {
            path: source.sourcePath,
            target: source.targetFilePath,
            buffer: () => source.stubBuffer,
            stream: () => {
              throw new Error(`"${source.sourcePath}" is a stub and has no file to stream.`)
            }
          }
        : withSourceHelpers(
            { path: source.sourcePath, target: source.targetFilePath },
            config.sourceFolder
          )

      const result = await source.readBuffer(input, { api: readAPI, settings: undefined, config })
      await writeCached(cacheDirectory, source.sourcePath, result, source.stub)
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

      const sourceFolder = settingsFolderFor(config, sourcePath, targetFilePath)

      applyReadResult(result, {
        database,
        targetPath: targetFilePath,
        sourcePath,
        settingsFolder: sourceFolder
      })

      const created = targetFilePath ? database.target.get(targetFilePath) : undefined

      // `path` is not unique, so re-inserting would leave two rows for
      // one source. A stub's row is written at enumeration; a buffer file
      // may already have one from an earlier pass.
      const existing = database.source.get(sourcePath)
      if (existing) {
        database.source.updateTimestamp(sourcePath, task.source.lastModified)
        if (task.source.stub !== undefined) database.source.updateStub(sourcePath, task.source.stub)
      } else {
        database.source.create(sourcePath, created?.path ?? targetFilePath, task.source.lastModified, task.source.stub ?? null)
      }
    })))
  }

  return { tasks, runBuffers }
}

export default readBuffers
