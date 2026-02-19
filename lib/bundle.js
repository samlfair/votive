import path from "node:path"
import readAbstracts from "./readAbstracts.js"
import readFolders from "./readFolders.js"
import readSources from "./readSources.js"
import runJobs from "./runJobs.js"
import writeDestinations from "./writeDestinations.js"
import { default as createDatabase } from "./createDatabase.js"

/** @import {Database} from "./createDatabase.js" */
/** @import {ParsedPath} from "node:path" */

/**
 * @typedef {object} VotivePlugin
 * @property {string} name
 * @property {VotiveProcessor[]} [processors]
 * @property {Record<string, Runner>} [runners]
 * @property {Router} [router]
 */

/**
 * @typedef {object} VotiveProcessor
 * @property {ProcessorFilter} [filter]
 * @property {ProcessorSyntax} syntax
 * @property {ProcessorRead} [read]
 * @property {ProcessorWrite} [write]
 */

/**
 * Filter for files that the processor will read from.
 * @typedef {object} ProcessorFilter
 * @property {string[]} extensions
 */

/**
 * A name for the syntax that processors will read-to and write-from (e.g. Unified.js's "hast").
 * @typedef {string} ProcessorSyntax
 */

/**
 * @typedef {object} ProcessorRead
 * @property {ReadPath} [path]
 * @property {ReadURL} [url]
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
 * @returns {Promise<ReadTextResult>}
 */

/**
 * Reads a the response from a URL and returns arbitrary data.
 * @callback ReadURL
 * @param {Response} response
 * @returns {object}
 */

/**
 * @callback ReadText
 * @param {string} text
 * @param {string} filePath
 * @param {string} destinationPath
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {ReadTextResult}
 */

/**
 * @typedef {object} ReadTextResult
 * @property {Jobs} [jobs]
 * @property {object} metadata
 * @property {Abstract} abstract
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
 * @param {object} folder
 * @param {Database} database
 * @param {VotiveConfig} config
 * @param {boolean} isRoot
 * @returns {{ jobs?: Jobs, destinations?: Destination[] }}
 */

/**
 * @typedef {object} Destination
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
 * @returns {{ data: string, buffer: Buffer, encoding?: BufferEncoding = 'utf-8' }}
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
 * @property {"text" | "blob" | "json"} format
 * @property {string} [syntax]
 */

/**
 * @typedef {object} PathInfo
 * @property {string[]} dir
 * @property {ParsedPath["name"]} name
 * @property {ParsedPath["ext"]} ext
 * @property {boolean} [inRootDir]
 */

/**
 * @callback Router
 * @param {PathInfo} path
 * @returns {PathInfo | false | undefined}
 */

/**
 * @typedef {object} VotiveConfig
 * @property {string} sourceFolder
 * @property {string} destinationFolder
 * @property {VotivePlugin[]} plugins
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
  // TODO: Ensure all cached destinations exist as expected

  // Map out all processors
  const processors = config.plugins
    && config.plugins.flatMap(plugin => plugin.processors && plugin.processors.map(processor => ({ plugin, processor })))

  // Create database
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

  // Read folders and source files
  const { folders, sources } = await readSources(config, database, processors)

  // Map out jobs from source files
  const sourcesJobs = sources.flatMap(source => source.jobs) || []

  // Process source file abstracts and map jobs
  const { abstractsJobs } = readAbstracts(sources, config, database, processors)

  // Scan folders and map out jobs
  const foldersJobs = readFolders(folders, config, database, processors) || []

  // Write destination files
  await writeDestinations(config, database)

  // Run all jobs
  await runJobs([
    ...sourcesJobs,
    ...abstractsJobs,
    ...foldersJobs
  ], config, database)


  await writeDestinations(config, database)

  // Back up database (only if in-memory first run)
  await database.saveDB()

  const stale = database.getStaleDestinations()
  if(stale.length > 0) await bundle(config, cache)

  return database
}

export default bundle
