import path from "node:path"
import fetchURLs from "./fetchURLs.js"
import readAbstracts from "./readAbstracts.js"
import readBuffers from "./readBuffers.js"
import readFolders from "./readFolders.js"
import readSources from "./readSources.js"
import writeTargets from "./writeTargets.js"
import { default as createDatabase } from "./createDatabase.js"
import { stopwatch } from "./utils/index.js"
import { styleText } from "node:util"

/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {Database} Database
 */

/**
 * A named action a plugin registers on its top-level `commands` object
 * (sibling to `processors`, not nested under one - a command isn't
 * scoped to a file extension). `notify` pushes a progress update back to
 * whoever triggered the command; a synchronous or single-step command
 * can just never call it. See tasks/deploy-hook.md for the design this
 * came out of.
 * @callback CommandHandler
 * @param {any} payload
 * @param {{ config: VotiveConfig, notify: (message: object) => void }} context
 * @returns {Promise<any> | any}
 */
/**
 * @callback HandlePreviewRequest
 * @param {Buffer} body - the raw file content as read from disk
 * @returns {string | Buffer}
 */
/**
 * Called when the requested target doesn't exist on disk, letting a
 * plugin supply a fallback target to serve instead - e.g. vowel's
 * synthesized 404.html. The returned path is resolved and served through
 * the exact same path a normal request takes (including running that
 * target's own handlePreviewRequest, if it has one), just with a 404
 * status instead of 200. Returning nothing (or a path that also doesn't
 * exist) falls back to an empty 404 body.
 * @callback HandlePreviewError
 * @param {import("node:path").ParsedPath} pathInfo - the route that was requested but not found
 * @returns {string | undefined}
 */

/**
 * @typedef {object} VotivePlugin
 * @property {string} name
 * @property {VotiveProcessor[]} [processors]
 * @property {Record<string, Runner>} [runners]
 * @property {Router} [router]
 * @property {Record<string, CommandHandler>} [commands] - named actions
 *   invocable over the dev server's WebSocket or directly via
 *   runCommand(); not scoped to a file extension.
 */

/**
 * @typedef {object} VotiveProcessorCommon
 * @property {string[]} extensions
 * @property {HandlePreviewRequest} [handlePreviewRequest] - dev server only
 * @property {HandlePreviewError} [handlePreviewError] - dev server only
 * @property {ProcessorWrite} [writeFile]
 * @property {ReadFolder} [readFolder]
 * @property {ReadAbstract} [transformFile]
 * @property {ReadURL} [readURL]
 */



/**
 * `format` decides only whether votive reads the file for you.
 * "text" reads it up front and puts the contents in `source.text`;
 * "buffer" reads nothing and defers the whole hook until after the build
 * (see readBuffers.js), leaving `source.buffer()` for when the plugin
 * wants the bytes. The hook itself is the same either way.
 * @typedef {VotiveProcessorCommon & {
 *  format: "text" | "buffer",
 *  readFile: ProcessorRead | undefined
 * }} VotiveProcessor
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
 * The restricted database surface passed to every plugin callback in
 * place of the full `database` object - see votive/lib/pluginAPI.js.
 * `target()`/`targets()` are read-tracked, and `url.create()` marks its
 * `dependent` stale, all against whichever target/file the callback is
 * currently processing - a plugin author never sets `dependent` itself.
 * @typedef {object} PluginAPI
 * @property {(filePath: string) => import("./createDatabase.js").TargetOutput} target
 * @property {(params?: Omit<import("./createDatabase.js").TargetGetByFolderParams, "dependent">) => import("./createDatabase.js").TargetOutput[]} targets
 * @property {(target: import("./createDatabase.js").TargetInput) => import("./createDatabase.js").SQLiteTarget} createTarget
 * @property {{
 *   get: (url: string) => any,
 *   create: (url: string, data: any, options?: { redirect?: string, canonical?: string }) => void
 * }} url
 */

/**
 * The API surface passed to readFile()/readBuffer() specifically - a
 * strict subset of PluginAPI with the read methods (`target`,
 * `targets`, `url.get`) removed. A read hook processes one source file
 * in isolation: whatever it might want to query (another target, a
 * folder's settings) may not exist yet - possibly because this very
 * file is what creates it - so there's no reliable moment to read
 * anything correctly. Only write actions remain: create a target, or
 * link a fetched URL. Both are fire-and-forget: there's no synchronous
 * return value a caller could rely on.
 * @typedef {object} ReadPluginAPI
 * @property {(target: import("./createDatabase.js").TargetInput) => void} createTarget
 * @property {{
 *   create: (url: string, data: any, options?: { redirect?: string, canonical?: string }) => void
 * }} url
 */

/**
 * One source file, as a `readFile` hook sees it. The read-side mirror of
 * the `target` a writeFile hook gets (see ProcessorWrite): a description
 * of the file plus lazy access to its bytes, so a plugin never needs
 * `node:fs` or an absolute path of its own.
 *
 * **Both paths are relative to `config.sourceFolder`** - the same form
 * the router works in and the database stores, so `source.path ===
 * "settings.md"` means the project's root settings file, and
 * `path.parse(source.path).dir` is a folder within the site. Nothing
 * votive hands a plugin is an absolute filesystem path.
 * @typedef {object} SourceInput
 * @property {string} path - e.g. "blog/post.md"
 * @property {string} target - where routing sent it, e.g.
 *   "blog/post.html". A processor cannot move its own target.
 * @property {string} [text] - the file's contents. Present only for
 *   `format: "text"` processors; use `buffer()` otherwise.
 * @property {() => Buffer} buffer - the file's bytes, read on call.
 * @property {() => import("node:fs").ReadStream} stream
 */

/**
 * Turn one source file into a target. No `settings`/read-capable `api` -
 * see ReadPluginAPI.
 * @callback ProcessorRead
 * @param {SourceInput} source
 * @param {ReadPluginAPI} api
 * @param {VotiveConfig} config
 * @returns {ReadResult | undefined}
 */

/**
 * @typedef {object} ReadResult
 * @property {UrlTasks} [urls]
 * @property {object} [metadata]
 * @property {Abstract} [abstract]
 * @property {Settings} [settings]
 * @property {string} [data] - the target's own stored text content -
 *   see TargetOutput.data in createDatabase.js. Optional: omitting it
 *   leaves whatever was there untouched, it doesn't clear it.
 * @property {boolean} [write] - `false` makes this a "virtual" target:
 *   its writeFile still runs normally, but nothing is written to disk -
 *   only readable via api.target()/api.targets(). See TargetOutput.write
 *   in createDatabase.js. Omitting this (or any value but `false`)
 *   writes normally.
 */

/**
 * A folder-scoped settings contribution: each value is spread (array) or
 * pushed (anything else) onto that label's accumulator array for this
 * file/folder's folder - see `queries.setting.accumulate` in
 * createDatabase.js.
 * @typedef {Record<string, any>} Settings
 */

/**
 * @typedef {UrlTask[]} UrlTasks
 */

/**
 * The only registration for this callback is `transformFile`
 * (readAbstracts.js), which always passes `targetFilePath`.
 * @callback ReadAbstract
 * @param {Abstract} abstract
 * @param {Settings} settings
 * @param {PluginAPI} api
 * @param {VotiveConfig} config
 * @param {string} targetFilePath - the target this abstract belongs to,
 *   so a URL task created here can set its own `target` (see
 *   UrlTask) for dependency tracking
 * @returns {{abstract: Abstract, urls: UrlTasks, settings?: Settings}}
 */

/**
 * @typedef {Record<string, any>} Abstract
 */

/**
 * @typedef {Abstract[]} Abstracts
 */

/**
 * @callback ReadFolder
 * @param {string} folder
 * @param {Settings} settings
 * @param {PluginAPI} api
 * @param {VotiveConfig} config
 * @param {boolean} [isRoot]
 * @returns {{ urls?: UrlTasks, targets?: Target[], settings?: Settings }}
 */

/**
 * @typedef {object} Target
 * @property {string} path
 * @property {object} metadata
 * @property {Abstract} abstract
 * @property {string} extension
 * @property {string | null} [source] - the source file path that produced
 *   this target, if any (absent for synthetically generated targets)
 */

/**
 * @typedef {object} Folder
 * @property {string} path
 */

/**
 * Build and write target files. `target` is a stale target (see Target)
 * augmented with `buffer()`/`stream()` - lazy reads of its `source` file
 * path, for a copy-through processor (PDF, video, fonts, ...) that just
 * needs the original bytes without touching `node:fs` itself.
 * @callback ProcessorWrite
 * @param {Target & { buffer: () => Buffer, stream: () => import("node:fs").ReadStream }} target
 * @param {Settings} settings
 * @param {PluginAPI} api
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
 * A URL-fetching task.
 * @typedef {object} UrlTask
 * @property {string} data - the URL to fetch
 * @property {string} runner - a Response method to call on the fetched
 *   result, e.g. "text", "json", "arrayBuffer"
 * @property {string} [target] - the target whose content depends on
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
 * @property {string} targetFolder
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

  // sourceFolder anchors every relative path stored in the database
  // (see readSources.js/readBuffers.js/readAbstracts.js) - a relative
  // value here would silently resolve against process.cwd() instead of
  // the caller's intended project folder, which is exactly the class of
  // bug that motivated this check (see tasks/desktop-app-architecture.md).
  // Fail loudly at the boundary instead: resolveProjectFolder() (exported
  // alongside this, from votive) is what a caller should run first.
  if (!path.isAbsolute(config.sourceFolder)) {
    throw new Error(`sourceFolder must be an absolute, resolved path. Received "${config.sourceFolder}" - use resolveProjectFolder() first.`)
  }

  // Map out all processors
  const processors = config.plugins
    && config.plugins.flatMap(plugin => plugin.processors && plugin.processors.map(processor => ({ plugin, processor }))).filter(a => a)

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

  // Necessary, not unnecessary: both stay null unless the `if
  // (sources.length)` block below reassigns them, and callers (see
  // bundler()'s wrapRunner) rely on `null` meaning "nothing pending" -
  // that contract needs a real value here even when nothing runs.
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
  const written = await writeTargets(config, database)
  writeTime()


  await database.saveDB(sources.length > 0 || written > 0)

  return { database, runBuffers, runFetches }
}

/**
 * @param {VotiveConfig} config
 */
async function bundler(config) {
  let cache
  // The latest build's deferred handles, reassigned on every bundle().
  let runBuffers
  let runFetches

  // Single-flight with trailing coalescing: at most one bundle() runs at
  // a time (bundle()/saveDB() aren't safe to run concurrently against
  // the same database - see tasks/3-in-review/voot-unawaited-deferred-race.md), and
  // a step() call that arrives while one is already running doesn't
  // start a second one - it just marks that one more pass is needed and
  // waits for it. `running` is the in-progress loop()'s promise (or
  // null when idle); `queued` is whether anyone has asked for another
  // pass since the current one started. Every caller that arrives while
  // `running` is set awaits that same promise, so nobody's request gets
  // silently dropped and nobody triggers a redundant concurrent build.
  let running = null
  let queued = false

  /*
    runBuffers()/runFetches() only fetch/parse and mark the right things
    stale (see queries.url.create) - staling alone doesn't produce fresh
    output. Wrapping them to call step() again once they're done closes
    that loop: run the deferred work, then immediately rebuild so
    whatever just got staled is written out, rather than leaving it
    stale until something else happens to trigger another build.
    null passes through unchanged - readBuffers.js/fetchURLs.js return
    that when there was nothing to run, and there's nothing to chain.

    Crucially, `runner()` itself (the slow part - reading a video file,
    fetching a URL) runs here, outside `running`/`queued` entirely - it
    never touches the queue, so it can never delay a concurrent step()
    call from an unrelated foreground edit. Only the fast "rebuild to
    reflect what just got staled" step() call at the end is subject to
    the same single-flight coalescing as everything else.
  */
  function wrapRunner(runner) {
    if (!runner) return null
    return async () => {
      await runner()
      await step()
    }
  }

  async function runOnce() {
    if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "starting build")}`)
    const result = await bundle(config, cache)
    cache = result.database
    runBuffers = result.runBuffers
    runFetches = result.runFetches
  }

  async function loop() {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      running = null
    }
  }

  async function step() {
    if (running) {
      if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", "queueing build")}`)
      queued = true
    } else {
      running = loop()
    }
    await running
    return { cache, runBuffers: wrapRunner(runBuffers), runFetches: wrapRunner(runFetches) }
  }

  return step
}

export default bundler

// Callers have to resolve their project folder before bundle() will accept
// a config - bundle() throws otherwise, naming resolveProjectFolder - and an
// embedder needs systemDirectoryFor to place the database and cache. Both
// are part of using votive at all, so they belong on the main entry rather
// than behind a separate "internals" specifier.
export { default as startServer, runCommand } from "./serve.js"
export { resolveProjectFolder } from "./utils/resolveProjectFolder.js"
export { systemDirectoryFor } from "./utils/systemPaths.js"
