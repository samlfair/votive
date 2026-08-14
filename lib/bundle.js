import path from "node:path"
import fetchURLs from "./fetchURLs.js"
import readAbstracts from "./readAbstracts.js"
import readBuffers from "./readBuffers.js"
import readFolders from "./readFolders.js"
import readSources from "./readSources.js"
import writeDestinations from "./writeDestinations.js"
import { default as createDatabase } from "./createDatabase.js"
import { stopwatch } from "./utils/index.js"
import { styleText } from "node:util"

/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {Database} Database
 */

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
 * @property {ReadURL} [readURL]
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
 * A file extension (e.g. ".html", ".md"), used to match a target/URL task
 * against a processor's registered `extensions`.
 * @typedef {string} ProcessorExtension
 */

/**
 * Parses a fetched URL's response body into whatever a plugin wants
 * cached for it (see fetchURLs.js: `task.runner` picks which Response
 * method produces `data` - "text", "json", "arrayBuffer", ...). The
 * return value is passed straight to `database.url.create()` and is
 * later readable via `database.url.get(url)`.
 * @callback ReadURL
 * @param {any} data
 * @returns {any}
 */

/**
 * Read a file buffer by its path.
 * @callback ReadPath
 * @param {string} filePath
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {{ abstract: Abstract, metadata: object, urls?: UrlTasks }}
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
 * @property {UrlTasks} [urls]
 * @property {object} [metadata]
 * @property {Abstract} [abstract]
 */

/**
 * @typedef {UrlTask[]} UrlTasks
 */

/**
 * The only registration for this callback is `transformFile`
 * (readAbstracts.js), which always passes `targetFilePath`.
 * @callback ReadAbstract
 * @param {Abstract} abstract
 * @param {Database} database
 * @param {VotiveConfig} config
 * @param {string} targetFilePath - the target this abstract belongs to,
 *   so a URL task created here can set its own `destination` (see
 *   UrlTask) for dependency tracking
 * @returns {{abstract: Abstract, urls: UrlTasks}}
 */

/**
 * @typedef {Record<string, any>} Abstract
 */

/**
 * @typedef {Abstract[]} Abstracts
 */

/**
 * @callback ReadFolder
 * @param {object} Folder
 * @param {Database} database
 * @param {VotiveConfig} config
 * @returns {{ urls?: UrlTasks, targets?: Target[] }}
 */

/**
 * @typedef {object} Target
 * @property {string} path
 * @property {object} metadata
 * @property {Abstract} abstract
 * @property {string} extension
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

/*
  @CLAUDE: I want you to show me an example of how a `UrlTask` would
  work, as described here.
*/

/**
 * A URL-fetching task.
 * @typedef {object} UrlTask
 * @property {string} data - the URL to fetch
 * @property {string} runner - a Response method to call on the fetched
 *   result, e.g. "text", "json", "arrayBuffer"
 * @property {string} [destination] - the target whose content depends on
 *   this URL, tracked via a type='url' dependency once fetched
 * @property {ProcessorExtension} [extension] - set after the fact (see
 *   readSources.js/readAbstracts.js/readFolders.js) to whichever
 *   processor's extensions produced this task, so fetchURLs.js can match
 *   it against a plugin's registered readURL handler
 */

/**
 * @typedef {(Pick<path.ParsedPath, "root" | "base" | "ext" | "name">) & { dir: string[] | string }} RouteInfo
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
 * @property {string} [databasePath] - where `.votive.db` is read/written.
 *   Defaults to `<sourceFolder>/.votive.db` when omitted. A caller
 *   wanting to keep this out of the project directory (e.g. an OS
 *   system directory - see `systemDirectoryFor` in
 *   `lib/utils/systemPaths.js`) sets this explicitly; votive itself has
 *   no opinion on where it lives.
 * @property {string} [cacheDirectory] - where `readBuffers.js`'s
 *   filesystem cache for deferred buffer results is written. Defaults
 *   to `<sourceFolder>/.cache` when omitted, same reasoning as
 *   `databasePath`.
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

  const database = cache || createDatabase(config.databasePath || path.join(config.sourceFolder, ".votive.db"))

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

  if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", `found ${sources.length} stale files`)}`)

  /*
    @CLAUDE: This `let` declaration seems completely unnecessary.
    Please either correct me or correct it.
  */
  let runBuffers = null
  let runFetches = null

  if (sources.length) {
    // Map out URL tasks from source files
    const sourcesURLs = sources.flatMap(source => source.urls) || []

    // Process source file abstracts and map URL tasks
    const { abstractsURLs } = readAbstracts(sources, config, database, processors)

    // Scan folders and map out URL tasks
    const foldersURLs = readFolders(folders, config, database, processors) || []

    // Buffer files (images, video, ...) found in this pass - deferred,
    // not run as part of this build. See readBuffers.js and the
    // `runBuffers` this function returns alongside `database`.
    runBuffers = readBuffers(sources, config, database).runBuffers

    const fetchTime = stopwatch("build", "fetched URLs in", config.verbose)
    // Fetch and parse any URLs found while reading sources/abstracts/folders.
    // URL tasks a plugin has claimed are deferred the same way buffers are -
    // see `runFetches`, also returned alongside `database`.
    runFetches = (await fetchURLs([...sourcesURLs, ...abstractsURLs, ...foldersURLs], config, database)).runFetches

    fetchTime()

    // database.commit()
  }


  const writeTime = stopwatch("build", "wrote files in", config.verbose)
  const written = await writeDestinations(config, database)
  writeTime()


  await database.saveDB(sources.length > 0 || written > 0)

  return { database, runBuffers, runFetches }
}

/**
 * @param {VotiveConfig} config
 */
async function bundler(config) {
  let queue = []
  let cache
  // The latest build's deferred handles, reassigned on every bundle().
  let runBuffers
  let runFetches

  /*
    runBuffers()/runFetches() only fetch/parse and mark the right things
    stale (see queries.url.create) - staling alone doesn't produce fresh
    output. Wrapping them to call step() again once they're done closes
    that loop: run the deferred work, then immediately rebuild so
    whatever just got staled is written out, rather than leaving it
    stale until something else happens to trigger another build.
    null passes through unchanged - readBuffers.js/fetchURLs.js return
    that when there was nothing to run, and there's nothing to chain.
  */
  function wrapRunner(runner) {
    if (!runner) return null
    return async () => {
      await runner()
      await step()
    }
  }

  async function step() {
    if (queue.length === 0) {
      if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "starting build")}`)
      /*
        If queue is empty, bundle.
      */
      if (!cache) {
        queue.push(bundle(config))
        const result = await queue[0]
        cache = result.database
        runBuffers = result.runBuffers
        runFetches = result.runFetches
      } else {
        queue.push(bundle(config, cache))
        const result = await queue[0]
        runBuffers = result.runBuffers
        runFetches = result.runFetches
      }
      queue.shift()
      return { cache, runBuffers: wrapRunner(runBuffers), runFetches: wrapRunner(runFetches) }
    } else if (queue.length === 1) {
      /*
        If currently bundling, prepare another
        bundle as cleanup.
      */
      if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "queueing build")}`)

      let bundling
      queue.push(bundling)
      const result = await bundle(config, cache)
      runBuffers = result.runBuffers
      runFetches = result.runFetches
      queue.shift()
      return { cache, runBuffers: wrapRunner(runBuffers), runFetches: wrapRunner(runFetches) }
    } else {
      /*
        If cleanup is already queued, do nothing.
      */
      if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "already queued")}`)
      await Promise.all(queue)
      return { cache, runBuffers: wrapRunner(runBuffers), runFetches: wrapRunner(runFetches) }
    }
  }

  return step
}

export default bundler
