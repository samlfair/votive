import { default as createDatabase } from "./createDatabase.js"
import readSources from "./readSources.js"
import readAbstracts from "./readAbstracts.js"
import readFolders from "./readFolders.js"
import writeDestinations from "./writeDestinations.js"
import runJobs from "./runJobs.js"

/** @import {Database} from "./createDatabase.js" */

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
 * @callback Router
 * @param {string} path
 * @returns {string | false | undefined}
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
 */
async function bundle(config) {
  const processors = config.plugins
    && config.plugins.flatMap(plugin => plugin.processors && plugin.processors.map(processor => ({ plugin, processor })))

  const database = createDatabase()
  const { folders, sources } = await readSources(config, database, processors)

  const sourcesJobs = sources.flatMap(source => source.jobs) || []
  const { processedAbstracts, abstractsJobs } = readAbstracts(sources, config, database, processors)
  const foldersJobs = readFolders(folders, config, database, processors) || []
  await writeDestinations(config, database)

  const jobs = [...sourcesJobs, ...abstractsJobs, ...foldersJobs]
  await runJobs(jobs, config, database)
}

export default bundle
