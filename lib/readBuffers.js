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
 * @property {string} syntax
 * @property {() => Promise<{ abstract: Abstract, metadata: object }>} run
 */

/**
 * Sketch of a filesystem cache for parsed buffer results, keyed by source
 * path only (not content or mtime) - per CLAUDE.md, these files are
 * expected to only need processing once, so this is closer to "survive a
 * process restart" than a real invalidation strategy. If that assumption
 * turns out wrong for some plugin, this is the thing to revisit.
 * @param {string} sourceFolder
 * @param {string} sourceFilePath
 */
function cacheFilePath(sourceFolder, sourceFilePath) {
  const hash = createHash("sha1").update(sourceFilePath).digest("hex")
  return path.join(sourceFolder, ".cache", `${hash}.json`)
}

/**
 * @param {string} sourceFolder
 * @param {string} sourceFilePath
 */
async function readCached(sourceFolder, sourceFilePath) {
  try {
    return JSON.parse(await fs.readFile(cacheFilePath(sourceFolder, sourceFilePath), "utf-8"))
  } catch (e) {
    return null
  }
}

/**
 * @param {string} sourceFolder
 * @param {string} sourceFilePath
 * @param {{ abstract: Abstract, metadata: object }} result
 */
async function writeCached(sourceFolder, sourceFilePath, result) {
  const cachePath = cacheFilePath(sourceFolder, sourceFilePath)
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

  const tasks = pending.map(source => ({
    sourceFilePath: source.sourceFilePath,
    targetFilePath: source.targetFilePath,
    syntax: source.syntax,
    source,
    async run() {
      const cached = await readCached(config.sourceFolder, source.sourceFilePath)
      if (cached) return cached

      const result = await source.readBuffer(source.sourceFilePath, database, config)
      await writeCached(config.sourceFolder, source.sourceFilePath, result)
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

      const { abstract, metadata } = result
      const created = database.target.create({ path: task.targetFilePath, abstract, metadata })
      database.source.create(task.sourceFilePath, task.targetFilePath, task.source.lastModified)
    })))
  }

  return { tasks, runBuffers }
}

export default readBuffers
