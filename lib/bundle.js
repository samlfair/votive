import path from "node:path"
import fetchURLs from "./fetchURLs.js"
import transformTargets from "./transformTargets.js"
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
 * @property {Record<string, CommandHandler>} [commands] - named actions
 *   invocable over the dev server's WebSocket or directly via
 *   runCommand(); not scoped to a file extension.
 */

/**
 * Every hook takes `(subject, context)` with this same context.
 * @typedef {object} HookContext
 * @property {PluginAPI | ReadPluginAPI} api
 * @property {Settings | undefined} settings - the folder-scoped view for
 *   the folder the subject lives in. `undefined` for `readFile`, which
 *   stays deliberately isolated: a read hook runs before the things it
 *   might query exist.
 * @property {VotiveConfig} config
 */

/**
 * `extensions`, `router` and `readFile` are the three things that together
 * define "source in, target out", which is why the router lives here
 * rather than on the plugin.
 * @typedef {object} VotiveProcessor
 * @property {string[]} extensions
 * @property {"text" | "buffer"} [format] - decides only whether votive
 *   reads the file for you, not the shape of your hook.
 * @property {Router} [router]
 * @property {ProcessorRead} [readFile]
 * @property {ProcessorRead} [readBuffer]
 * @property {ProcessorTransform} [transformFile]
 * @property {ProcessorReadFolder} [readFolder]
 * @property {ProcessorWrite} [writeFile]
 * @property {ProcessorReadURL} [readURL]
 * @property {HandlePreviewRequest} [handlePreviewRequest] - dev server only
 * @property {HandlePreviewError} [handlePreviewError] - dev server only
 */

/**
 * What `readFile`/`readBuffer` receive. Both paths are relative to
 * `sourceFolder` - the form the router works in and the database stores -
 * so a plugin asking a routing-shaped question gets an answer rather than
 * an absolute path it has to un-resolve.
 * @typedef {object} SourceInput
 * @property {string} path - "blog/post.md"
 * @property {string} target - where routing sent it, "blog/post.html"
 * @property {string} [text] - the contents, for `format: "text"` only
 * @property {() => Promise<Buffer>} buffer
 * @property {() => import("node:stream").Readable} stream
 */

/**
 * What `readFolder` receives.
 * @typedef {object} FolderInput
 * @property {string} path - relative to sourceFolder; the root is "".
 *   Note a non-root folder arrives with a trailing slash ("blog/").
 * @property {boolean} isRoot
 */

/**
 * What `readURL` receives. The body methods are lazy, so a plugin that
 * only reads headers never reads the body.
 * @typedef {object} ResponseInput
 * @property {string} url
 * @property {number} status
 * @property {string | null} redirect
 * @property {() => Promise<string>} text
 * @property {() => Promise<any>} json
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 */

/**
 * @typedef {object} TargetInput
 * @property {string} path
 * @property {object} [metadata]
 * @property {string} [data]
 * @property {string} [source]
 * @property {boolean} [write]
 */

/**
 * What every read-side hook may return. Every key is optional, and a hook
 * may return `undefined` to mean "nothing".
 * @typedef {object} ReadHookResult
 * @property {string | null} [data] - the target's content. Omitting it on
 *   an existing target leaves the stored value untouched.
 * @property {object} [metadata]
 * @property {Settings} [settings]
 * @property {UrlRequest[]} [urls]
 * @property {TargetInput[]} [targets] - additional targets to create
 * @property {boolean} [write] - `false` makes a virtual target
 */

/**
 * What `writeFile` returns. Returning `undefined` marks the target fresh
 * without writing anything.
 * @typedef {object} WriteHookResult
 * @property {string} [data]
 * @property {BufferEncoding} [encoding]
 * @property {boolean} [delete] - removes the target and its file
 */

/**
 * A URL a plugin wants fetched. `target` attributes the result.
 * @typedef {object} UrlRequest
 * @property {string} url
 * @property {string} [target]
 */

/**
 * @callback ProcessorRead
 * @param {SourceInput} source
 * @param {HookContext} context
 * @returns {ReadHookResult | undefined | Promise<ReadHookResult | undefined>}
 */

/**
 * @callback ProcessorTransform
 * @param {TargetOutput} target - the target as stored
 * @param {HookContext} context
 * @returns {ReadHookResult | undefined}
 */

/**
 * @callback ProcessorReadFolder
 * @param {FolderInput} folder
 * @param {HookContext} context
 * @returns {ReadHookResult | undefined}
 */

/**
 * @callback ProcessorWrite
 * @param {TargetOutput} target - plus buffer()/stream() helpers
 * @param {HookContext} context
 * @returns {WriteHookResult | undefined | Promise<WriteHookResult | undefined>}
 */

/**
 * Returns whatever the plugin wants cached against the URL.
 * @callback ProcessorReadURL
 * @param {ResponseInput} response
 * @param {HookContext} context
 * @returns {any | Promise<any>}
 */

/**
 * @typedef {object} PluginAPI
 * @property {(path: string) => TargetOutput | undefined} target
 * @property {(query?: object) => TargetOutput[]} targets
 * @property {(path: string) => TargetOutput | undefined} targetBySource
 * @property {(target: TargetInput) => void} createTarget
 * @property {(url: string) => any} url
 */

/**
 * `readFile`/`readBuffer` get this restricted api: write-only, because
 * anything they might read may not exist yet - this file might be what
 * creates it.
 * @typedef {object} ReadPluginAPI
 * @property {(target: TargetInput) => void} createTarget
 */

/**
 * @typedef {Record<string, any>} Settings
 */

/**
 * @typedef {(Pick<path.ParsedPath, "root" | "base" | "ext" | "name">) & { dir: string[] | string }} RouteInfo
 */

/**
 * @callback Router
 * @param {RouteInfo & { inRootDir: boolean, dir: string[] }} pathInfo
 * @returns {RouteInfo | false}
 */

/**
 * @typedef {object} VotiveConfig
 * @property {string} sourceFolder - absolute and resolved; bundle() throws otherwise
 * @property {string} targetFolder
 * @property {string} [databasePath]
 * @property {string} [cacheDirectory]
 * @property {VotivePlugin[]} [plugins]
 * @property {boolean} [verbose] - shorthand for a console logger
 * @property {(level: string, message: string) => void} [log] - stages call
 *   this instead of console.info; defaults to writing to the console when
 *   `verbose` is set
 * @property {string} [userAgent]
 * @property {number} [urlFetchTimeout]
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
/**
 * Stages call this instead of console.info. The default writes to the
 * console when `config.verbose` is set, so the existing behaviour is the
 * default; a host with its own levels maps onto it by supplying
 * `config.log`.
 * @param {VotiveConfig} config
 * @returns {(level: string, message: string) => void}
 */
function loggerFor(config) {
  return config.log ?? ((level, message) => {
    if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", message)}`)
  })
}

async function bundle(config, cache, scope) {
  const log = loggerFor(config)


  // sourceFolder anchors every relative path stored in the database
  // (see readSources.js/readBuffers.js/transformTargets.js) - a relative
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
    A fresh run with no database on disk builds in memory and is backed
    up to the file system once at the end by saveDB. An existing
    database is opened on disk in WAL mode (see loadDB), and every build
    is one transaction - without it each statement autocommits with an
    fsync, and an edit costs hundreds of them.
  */

  const runPasses = async () => {
    const sourceTime = stopwatch("build", "read sources in", config.verbose)
    // Read folders and source files
    const { folders, sources, deleted } = await readSources(config, database, processors, scope)

    sourceTime()

    if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", `found ${sources.length} stale files`)}`)

    // Necessary, not unnecessary: both stay null unless the `if
    // (sources.length)` block below reassigns them, and callers (see
    // bundler()'s wrapRunner) rely on `null` meaning "nothing pending" -
    // that contract needs a real value here even when nothing runs.
    let runBuffers = null
    let runFetches = null

    if (sources.length || deleted.length) {
      // Map out URL tasks from source files
      const sourcesURLs = sources.flatMap(source => source.urls) || []

      // Process source file abstracts and map URL tasks
      const { transformURLs } = transformTargets(sources, config, database, processors)

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
      runFetches = (await fetchURLs([...sourcesURLs, ...transformURLs, ...foldersURLs], config, database)).runFetches

      fetchTime()
    }


    const writeTime = stopwatch("build", "wrote files in", config.verbose)
    const written = await writeTargets(config, database)
    writeTime()

    log("info", `wrote ${written} stale targets`)

    return { sources, deleted, runBuffers, runFetches, written }
  }

  // Everything from readSources through writeTargets is one transaction.
  // On a throw we ROLLBACK and rethrow, so a failed build leaves the
  // database as it was rather than half-applied.
  database.begin()
  const passes = await runPasses().catch(error => {
    database.rollback()
    throw error
  })
  database.commit()

  // Outside the transaction: for an on-disk database saveDB is a no-op,
  // and for an in-memory one it is the backup to the file system.
  await database.saveDB(passes.sources.length > 0 || passes.deleted.length > 0 || passes.written > 0)

  return { database, runBuffers: passes.runBuffers, runFetches: passes.runFetches }
}

/**
 * The entry point. Returns a site: the thing you build, listen to, and
 * close.
 *
 * ```js
 * const site = await votive(config)
 * const result = await site.build()
 * site.database
 * site.on("built", handler)
 * await site.close()
 * ```
 * @param {VotiveConfig} config
 */
async function votive(config) {
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

  // A build() that arrives while one is running doesn't start a second -
  // but its paths must not be dropped either, so they accumulate here and
  // are merged into the trailing pass. `null` means "a full scan is
  // needed", which any un-scoped call forces and which the first build
  // after startup always is.
  /** @type {{changed: Set<string>, deleted: Set<string>} | null} */
  let pendingScope = null

  function mergeScope(scope) {
    if (!scope || !scope.changed) {
      pendingScope = null
      return
    }
    if (pendingScope === null && queued) return
    const changed = new Set(pendingScope?.changed ?? [])
    const deleted = new Set(pendingScope?.deleted ?? [])
    scope.changed.forEach(entry => changed.add(entry))
    ;(scope.deleted ?? []).forEach(entry => deleted.add(entry))
    pendingScope = { changed, deleted }
  }

  function takeScope() {
    if (pendingScope === null) return undefined
    const scope = { changed: [...pendingScope.changed], deleted: [...pendingScope.deleted] }
    pendingScope = null
    return scope
  }

  // The first build after startup is always a full scan, whatever it is
  // asked for: there is no database state to scope against yet.
  let firstBuildDone = false

  /** @type {Map<string, ((payload?: any) => void)[]>} */
  const listeners = new Map()

  /**
   * @param {string} event - "built" after each build (including the
   *   rebuild a deferred runner triggers), "deferred" when a runner
   *   finishes.
   * @param {(payload?: any) => void} handler
   */
  function on(event, handler) {
    const existing = listeners.get(event) ?? []
    listeners.set(event, [...existing, handler])
  }

  function emit(event, payload) {
    const handlers = listeners.get(event) ?? []
    handlers.forEach(handler => handler(payload))
  }

  // Stages call this instead of console.info. The default writes to the
  // console when config.verbose is set, so the existing behaviour is the
  // default; a host with its own levels (the dev server) maps onto it.
  const log = loggerFor(config)

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
  function wrapRunner(runner, kind) {
    if (!runner) return null
    return async () => {
      await runner()
      emit("deferred", kind)
      await build({ defer: false })
    }
  }

  async function runOnce() {
    log("info", "starting build")
    const result = await bundle(config, cache, firstBuildDone ? takeScope() : undefined)
    firstBuildDone = true
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

  /**
   * @param {{ defer?: boolean, changed?: string[], deleted?: string[] }} [options]
   *   `changed`/`deleted` are paths relative to sourceFolder. Given them,
   *   readSources skips the recursive scan entirely. Omit them for a full
   *   pass, which is what any caller that doesn't know gets.
   */
  async function build(options = {}) {
    mergeScope(options.changed ? { changed: options.changed, deleted: options.deleted } : null)
    if (running) {
      log("info", "queueing build")
      queued = true
    } else {
      running = loop()
    }
    await running

    const buffers = wrapRunner(runBuffers, "buffers")
    const fetches = wrapRunner(runFetches, "fetches")
    emit("built")

    // Deferred work runs by default. It used to be the caller's job to
    // remember two nullable functions, which was the easiest thing in the
    // API to forget - and forgetting it meant a fetched link preview or a
    // processed image never reached the page.
    const deferred = options.defer === false
      ? Promise.resolve()
      : Promise.all([buffers?.(), fetches?.()]).then(() => undefined)

    return { database: cache, deferred, runBuffers: buffers, runFetches: fetches }
  }

  /**
   * Flushes a pending in-memory backup and closes the database, so the
   * file is released. A host that switches projects in-process (the
   * desktop app) needs this.
   */
  async function close() {
    if (!cache) return
    await cache.saveDB(false)
    cache.close?.()
    cache = undefined
  }

  return {
    build,
    close,
    on,
    get database() { return cache }
  }
}

export default votive

// Callers have to resolve their project folder before bundle() will accept
// a config - bundle() throws otherwise, naming resolveProjectFolder - and an
// embedder needs systemDirectoryFor to place the database and cache. Both
// are part of using votive at all, so they belong on the main entry rather
// than behind a separate "internals" specifier.
export { default as startServer, runCommand } from "./serve.js"
export { resolveProjectFolder } from "./utils/resolveProjectFolder.js"
export { systemDirectoryFor } from "./utils/systemPaths.js"
