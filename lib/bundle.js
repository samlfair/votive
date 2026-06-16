import path from "node:path"
import readAbstracts from "./readAbstracts.js"
import readFolders from "./readFolders.js"
import readSources from "./readSources.js"
import runJobs from "./runJobs.js"
import writeDestinations from "./writeDestinations.js"
import { default as createDatabase } from "./createDatabase.js"
import { stopwatch } from "./utils/index.js"
import { styleText } from "node:util"

/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {object} VotivePlugin
 * @property {string} name
 * @property {VotiveProcessor[]} [processors]
 * @property {Record<string, Runner>} [runners]
 * @property {Router} [router]
 */

/**
 * @typedef {object} VotiveProcessorCommon
 * @property {string[]} extensions
 * @property {ReadResource} [readResource]
 * @property {ProcessorWrite} [writeFile]
 * @property {ReadFolder} [readFolder]
 * @property {ReadAbstract} [transformFile]
 */

/**
 * @typedef {VotiveProcessorCommon & {
 *  format: "buffer",
 *  readFile: ReadPath | undefined
 * }} VotiveProcessorBuffer
 */

/**
 * @typedef {VotiveProcessorCommon & {
 *  format: "text",
 *  readFile: ReadText | undefined
 * }} VotiveProcessorText
 */

/**
 * @typedef {VotiveProcessorBuffer | VotiveProcessorText} VotiveProcessor
 */

/**
 * @typedef {object} ReadResource
 */

/**
 * Filter for files that the processor will read from.
 * @typedef {object} ProcessorFilter
 * @property {string} extensions
 */

/**
 * A name for the syntax that processors will read-to and write-from (e.g. Unified.js's "hast").
 * @typedef {string} ProcessorSyntax
 */

/**
 * @typedef {object} ProcessorRead
 * @property {ReadPath} [path]
 * @property {ReadText} [text]
 * @property {ReadAbstract} [abstract]
 * @property {ReadFolder} [folder]
 */

/**
 * Read a file path and return any necessary jobs.
 * @callback ReadPath
 * @param {string} filePath
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {Job[] | undefined}
 */

/**
 * @callback ReadText
 * @param {string} text
 * @param {string} filePath
 * @param {string} destinationPath
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {ReadTextResult | undefined}
 */

/**
 * @typedef {object} ReadTextResult
 * @property {Jobs} [jobs]
 * @property {object} [metadata]
 * @property {Abstract} [abstract]
 */

/**
 * @typedef {Job[]} Jobs
 */

/**
 * @callback ReadAbstract
 * @param {Abstract} abstract
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {{abstract: Abstract, jobs: Jobs}}
 */

/**
 * @typedef {Record<string, any>} Abstract
 */

/**
 * @typedef {Abstract[]} Abstracts
 */

/**
 * @typedef {AbstractWithSyntax[]} AbstractsWithSyntax
 */

/**
 * @typedef {object} AbstractWithSyntax
 * @property {Abstract} abstract
 * @property {ProcessorSyntax} syntax
 */

/**
 * @callback ReadFolder
 * @param {object} Folder
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {{ jobs?: Jobs, targets?: Target[] }}
 */

/**
 * @typedef {object} Target
 * @property {string} path
 * @property {object} metadata
 * @property {Abstract} abstract
 * @property {string} syntax
 */

/**
 * @typedef {object} Folder
 * @property {string} path
 */

/**
 * Build and write destination files.
 * @callback ProcessorWrite
 * @param {object} destination
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {{ data: string, encoding?: BufferEncoding = 'utf-8' }}
 */

/**
 * A function that runs a job, suggest as fetching data or formatting an image.
 * @callback Runner
 * @param {string} file
 * @param {Database} database
 * @returns {Promise<any>}
 */

/**
 * Run a job.
 * @typedef {object} Job
 * @property {object} data
 * @property {string} runner
 * @property {string} [plugin]
 */

/**
 * @typedef {(Pick<path.ParsedPath, "root" | "base" | "ext" | "name") & { dir: string[] | string }} RouteInfo
 */

/**
 * @callback Router
 * @param {RouteInfo} path
 * @returns {Partial<RouteInfo> | path.ParsedPath | false}
 */

/**
 * @typedef {object} VotiveConfig
 * @property {string} sourceFolder
 * @property {string} destinationFolder
 * @property {VotivePlugin[]} plugins
 * @property {boolean} verbose
 */

/**
 * @typedef {object} FlatProcessor
 * @property {VotivePlugin} plugin
 * @property {VotiveProcessor} processor
 */

/**
 * @typedef {FlatProcessor[]} FlatProcessors
 */

/**
 * @param {VotiveConfig} config
 * @param {Database | undefined} [cache]
 */
async function bundle(config, cache) {

  // Map out all processors
  const processors = config.plugins
    && config.plugins.flatMap(plugin => plugin.processors && plugin.processors.map(processor => ({ plugin, processor })))

  const database = cache || createDatabase(path.join(config.sourceFolder, ".votive.db"))

  /*
    Note: If no cache is provided or located, the database
    will automatically run in memory, based on the assumption
    that Votive is running for the first time. The in-
    memory database will run much faster and then back up
    to the file system. When Votive next launches from the
    cached disk database, the read/writes will be a little
    slower, but startup will be much faster, so it should
    even out.
  */

  // database.begin()

  const sourceTime = stopwatch("build", "read sources in", config.verbose)
  // Read folders and source files
  const { folders, sources } = await readSources(config, database, processors)

  sourceTime()

  if(config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", `found ${sources.length} stale files`)}`)

  if (sources.length) {
    // Map out jobs from source files
    const sourcesJobs = sources.flatMap(source => source.jobs) || []

    // Process source file abstracts and map jobs
    const { abstractsJobs } = readAbstracts(sources, config, database, processors)

    // Scan folders and map out jobs
    const foldersJobs = readFolders(folders, config, database, processors) || []

    const writeTime = stopwatch("build", "wrote files in", config.verbose)
    // Write destination files
    await writeDestinations(config, database)

    writeTime()

    // database.commit()

    await database.saveDB(sources)
  }
  // Run all jobs
  // await runJobs([
  //   ...sourcesJobs,
  //   ...abstractsJobs,
  //   ...foldersJobs
  // ], config, database)

  // Back up database (only if in-memory first run)

  return database
}

/**
 * @param {VotiveConfig} config
 */
async function bundler(config) {
  let queue = []
  let cache

  async function step() {
    if (queue.length === 0) {
      if(config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "starting build")}`)
      /*
        If queue is empty, bundle.
      */
      if (!cache) {
        queue.push(bundle(config))
        cache = await queue[0]
      } else {
        "cache"
        queue.push(bundle(config, cache))
        await queue[0]
      }
      queue.shift()
      return cache
    } else if (queue.length === 1) {
      /*
        If currently bundling, prepare another
        bundle as cleanup.
      */
      if(config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "queueing build")}`)

      let bundling
      queue.push(bundling)
      bundling = await bundle(config, cache)
      queue.shift()
      return cache
    } else {
      /*
        If cleanup is already queued, do nothing.
      */
      if(config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "already queued")}`)
      await Promise.all(queue)
      return cache
    }
  }

  return step
}

export default bundler
