import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"

/** @import {VotiveConfig, Abstract} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFileResult} from "./readSources.js" */

/**
 * @typedef {object} BufferTask
 * @property {string} sourceFilePath
 * @property {string} targetFilePath
 * @property {string} extension
 * @property {() => Promise<{ abstract: Abstract, metadata: object, settings?: import("./bundle.js").Settings }>} run
 */

/**
 * Sketch of a filesystem cache for parsed buffer results, keyed by source
 * path only (not content or mtime) - per CLAUDE.md, these files are
 * expected to only need processing once, so this is closer to "survive a
 * process restart" than a real invalidation strategy. If that assumption
 * turns out wrong for some plugin, this is the thing to revisit.
 * @param {string} cacheDirectory
 * @param {string} sourceFilePath
 */
function cacheFilePath(cacheDirectory, sourceFilePath) {
  const hash = createHash("sha1").update(sourceFilePath).digest("hex")
  return path.join(cacheDirectory, `${hash}.json`)
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourceFilePath
 */
async function readCached(cacheDirectory, sourceFilePath) {
  try {
    return JSON.parse(await fs.readFile(cacheFilePath(cacheDirectory, sourceFilePath), "utf-8"))
  } catch (e) {
    return null
  }
}

/**
 * @param {string} cacheDirectory
 * @param {string} sourceFilePath
 * @param {{ abstract: Abstract, metadata: object }} result
 */
async function writeCached(cacheDirectory, sourceFilePath, result) {
  const cachePath = cacheFilePath(cacheDirectory, sourceFilePath)
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
    sourceFilePath: source.sourceFilePath,
    targetFilePath: source.targetFilePath,
    extension: source.extension,
    source,
    async run() {
      const cached = await readCached(cacheDirectory, source.sourceFilePath)
      if (cached) return cached

      const result = await source.readBuffer(source.sourceFilePath, database, config)
      await writeCached(cacheDirectory, source.sourceFilePath, result)
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

      const { abstract, metadata, settings } = result
      const created = database.target.create({ path: task.targetFilePath, abstract, metadata, source: task.sourceFilePath })
      // Scoped to the source file's own folder, not the target's - see
      // the identical note in readSources.js.
      if (settings) {
        const sourceFolder = path.relative(config.sourceFolder, path.dirname(task.sourceFilePath))
        database.setting.accumulate(sourceFolder, settings, task.sourceFilePath)
      }
      database.source.create(task.sourceFilePath, task.targetFilePath, task.source.lastModified)
    })))
  }

  return { tasks, runBuffers }
}

export default readBuffers
