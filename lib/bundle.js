import path from "node:path"
import { rm } from "node:fs/promises"
import fetchURLs from "./fetchURLs.js"
import transformTargets from "./transformTargets.js"
import readBuffers from "./readBuffers.js"
import readSources from "./readSources.js"
import readStubs from "./stubs.js"
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
 * Runs on every served file of the processor's extension, before it is
 * sent. `target` is the row behind the file and `settings` the view its
 * folder sees, both untracked - a preview is not a build. This is how an
 * in-page editor learns a page's source path and text: the plugin puts
 * what it needs into the page. Nothing here is written to disk.
 * @callback HandlePreviewRequest
 * @param {Buffer} body - the raw file content as read from disk
 * @param {{ target?: TargetOutput, settings?: object, config: VotiveConfig }} context
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
 * @property {PluginAPI} api
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
 * @property {"text" | "buffer" | "url"} [format] - how votive obtains the
 *   input: reads the file as text, hands you its bytes lazily and
 *   deferred, or - "url" - fetches it. A `format: "url"` processor is
 *   chosen for a fetched response by its `mediaTypes` (what the server
 *   said it sent - "text/html"), falling back to its `extensions`
 *   (the url's pathname extension, "" for none) when the response has no
 *   usable type. Its one hook is readURL.
 * @property {string[]} [mediaTypes] - `format: "url"` only: media types
 *   this processor parses, without parameters. Exact matches, one
 *   claimant per type.
 * @property {Router} [router]
 * @property {ProcessorRead} [readFile]
 * @property {ProcessorRead} [readBuffer]
 * @property {ProcessorTransform} [transformFile]
 * @property {ProcessorStubs} [createStubs] - declares sources this processor
 *   synthesizes rather than finds on disk (see ProcessorStubs)
 * @property {ProcessorExpand} [expandStubs] - produces a declared stub's
 *   content, on demand (see ProcessorExpand)
 * @property {ProcessorWrite} [writeFile]
 * @property {ProcessorReadURL} [readURL]
 * @property {HandlePreviewRequest} [handlePreviewRequest] - dev server only
 * @property {HandlePreviewError} [handlePreviewError] - dev server only
 */

/**
 * @typedef {object} Stub
 * @property {string} path - project-relative, in the same space as a
 *   file's source path. Its extension decides which processor reads it,
 *   and that processor's router routes it. The declaring processor need
 *   not be the one that reads it.
 * @property {object} [params] - JSON-serializable. Canonically
 *   serialized (object keys sorted at every depth, arrays left in order)
 *   and stored where a file's mtime goes; a stub re-expands when that
 *   string changes. Keep it to what expandStubs() needs and nothing more.
 */

/**
 * Declares the sources this processor synthesizes. Called on **every
 * pass**, for every processor, after the file sources have been read and
 * outside the "any stale source" gate - the follow-up build a deferred
 * runner triggers has no stale file source and must still enumerate.
 * Expected to be cheap: a query and a map.
 *
 * `api` is read-only and **untracked** - nothing depends on an
 * enumerator, so its reads register no dependency rows. It offers
 * `target`, `targetBySource`, `targets`, `metadataValues(label)` and
 * `settingValues(label)` (every distinct value written for a label at
 * any folder - the per-folder view an enumerator otherwise lacks), and
 * deliberately no `url()`: a fetch is attributed to a dependent so that
 * landing it can stale something, and an enumerator has none.
 * `settings` is the root folder's view.
 *
 * A stub whose path a real file claims is dropped, which is what makes
 * an author's own `404.md` an override rather than a conflict. Two
 * processors declaring one path is an error.
 * @callback ProcessorStubs
 * @param {{ api: object, settings: object, config: VotiveConfig }} context
 * @returns {Stub[]}
 */

/**
 * Produces a stub's content, called **only** when the stub is new or its
 * params changed. Runs on the processor that declared the stub. Its
 * output enters the ordinary read of whichever processor claims the
 * extension, with `text` or `buffer()` set, exactly as if the bytes had
 * come from disk - so `readFile`/`readBuffer` stay parsers and never
 * learn about params.
 * @callback ProcessorExpand
 * @param {Stub} stub
 * @param {{ config: VotiveConfig }} context
 * @returns {{ text: string } | { buffer: Buffer } | Promise<{ text: string } | { buffer: Buffer }>}
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
 * What `readURL` receives. The body methods are lazy, so a plugin that
 * only reads headers never reads the body. `url` is a URL instance -
 * protocol, host, pathname and searchParams are all there for a
 * processor deciding where to file the result; String(url) is the
 * requested url.
 * @typedef {object} ResponseInput
 * @property {URL} url
 * @property {number} status
 * @property {string | null} redirect
 * @property {() => Promise<string>} text
 * @property {() => Promise<any>} json
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 */

/**
 * What `readURL` returns.
 *
 * `path` is where the result is filed, relative to `config.urlStore` and
 * without an extension - votive appends a short tiebreaker from the full
 * url and `.yaml`. The filename is not the identity (the url inside the
 * file is), so it only has to be readable: `<host>/<slug>` is the usual
 * shape. `data` is yours and votive never looks inside it; the file is
 * `{url, data}` and it is what a page gets back from api.url(). `url`,
 * if returned and different from the requested one, is recorded as the
 * canonical url - the requested one stays the key, and lookups match
 * either.
 * @typedef {object} ReadURLResult
 * @property {string} path
 * @property {unknown} data
 * @property {string} [url]
 */

/**
 * @typedef {object} TargetInput
 * @property {string} path
 * @property {object} [metadata]
 * @property {boolean} [merge] - keep the metadata keys this call does not
 *   name (a transform's partial result); the default replaces the set
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
 * @property {object} [metadata] - a value written as exactly
 *   `{ $type, $value }` declares its type: `$value` is stored and read
 *   back as the value, `$type` (a lowercase name - `date`, `url`) is
 *   recorded beside it and read back as `target.types[label]`. Nothing
 *   downstream ever sees the wrapper. Anything else is a plain value
 *   whose type is JSON's.
 * @property {Settings} [settings]
 * @property {boolean} [write] - `false` makes a virtual target
 * @property {{path: string, metadata?: object, data?: string | null, write?: boolean}[]} [targets] -
 *   the source's **owned** targets beside its routed one (an image's
 *   derivatives). `path` is a target path, used verbatim. Each is
 *   stored with this source as its `source`, so at write its
 *   `target.buffer()` reads the owner's file, and a read replaces the
 *   set it owns: what it stops returning is deleted with its file, and
 *   a deleted source takes everything it owned. A path another source
 *   produces throws. For what has no single owner - a tag page, a
 *   folder index - use stubs.
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
 * @callback ProcessorRead
 * @param {SourceInput} source
 * @param {HookContext} context
 * @returns {ReadHookResult | undefined | Promise<ReadHookResult | undefined>}
 */

/**
 * Rewrites a stored target once every target from the pass exists - so
 * it is where cross-page resolution belongs. Synchronous. Its result is
 * **merged**: return only what changed (`{ metadata: { links } }`), and
 * every key not named keeps its value and its declared type. A read
 * hook's result replaces the set; a transform's never deletes.
 * @callback ProcessorTransform
 * @param {TargetOutput} target - the target as stored
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
 * @returns {ReadURLResult | Promise<ReadURLResult>}
 */

/**
 * @typedef {object} PluginAPI
 * @property {(path: string) => TargetOutput | undefined} target
 * @property {(query?: object) => TargetOutput[]} targets
 * @property {(path: string) => TargetOutput | undefined} targetBySource
 * @property {{ (url: string): any, (request: Request): Promise<any> }} url -
 *   a string answers synchronously; a `Request` answers with a promise,
 *   because its body is read at ask time (see lib/urlRequest.js)
 */

/**
 * @typedef {Record<string, any>} Settings
 */

/**
 * @typedef {(Pick<path.ParsedPath, "root" | "base" | "ext" | "name">) & { dir: string[] | string }} RouteInfo
 */

/**
 * Where a source lands. The returned path is used **verbatim**: stored,
 * looked up and written exactly as spelled, case included. A processor
 * that wants lowercase urls lowercases them itself (or the project does
 * it once, for every processor, in `config.router`).
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
 * @property {(level: "error" | "warn" | "info", message: string) => void} [log] -
 *   where the stages and the hooks report. Defaults to the console:
 *   errors and warnings always, info under `verbose`. Always present on
 *   the config a hook receives (see attempt.js for what is reported).
 * @property {(sourcePath: string) => string | undefined} [router] - the
 *   config-level router cascade: rewrites a source path before any
 *   processor's router sees it, so a rewrite that is not a processor's
 *   business (vowel hashes a leading-"-" segment to make a folder secret)
 *   applies to every extension at once. It changes only where the target
 *   lands; the source keeps its original path everywhere it is stored,
 *   diffed or looked up. Return nothing to leave the path unchanged. It
 *   cannot suppress a target - that stays the processor router's job.
 * @property {string} [userAgent]
 * @property {number} [urlFetchTimeout]
 * @property {string} [urlStore] - where fetched URL results are kept as
 *   one YAML file per url, absolute or relative to sourceFolder. The
 *   files are sources: read natively by readSources, the urls table is
 *   an index of them. Default ".urls". See urlStore.js.
 * @property {number} [urlConcurrency] - fetches in flight at once across
 *   all hosts. Default 5.
 * @property {number} [urlHostInterval] - milliseconds between two
 *   requests to the same host, which are always sequential. Default 500.
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
    // An error or a warning is never silent - a file that was skipped
    // (see attempt.js) has to be visible to whoever ran the build.
    // Info is the stopwatch chatter, and only under verbose.
    if (level === "error") return console.error(`${styleText("dim", "build:")} ${styleText("red", message)}`)
    if (level === "warn") return console.warn(`${styleText("dim", "build:")} ${styleText("yellow", message)}`)
    if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", message)}`)
  })
}

/**
 * @param {VotiveConfig} config
 * @param {Database | undefined} cache
 * @param {{ changed?: string[], deleted?: string[] } | undefined} scope
 * @param {{ shouldYield?: () => boolean }} [options] - `shouldYield` is
 *   asked before each dependent write (see writeTargets); votive() passes
 *   "is another build queued", so a waiting edit is never behind a feed.
 */
async function bundle(config, cache, scope, { shouldYield } = {}) {
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

  // Removed hooks fail loudly. A readFolder that is silently never called
  // is a plugin whose pages simply never appear, with nothing to say why.
  processors?.forEach(({ plugin, processor }) => {
    if (processor.readFolder) {
      throw new Error(`Plugin "${plugin.name}" declares readFolder, which no longer exists. Declare what the folder produced as stubs: createStubs() and expandStubs().`)
    }
  })

  const database = cache || createDatabase(config.databasePath || path.join(config.sourceFolder, ".votive.db"), { log })


  /*
    A fresh run with no database on disk builds in memory and is backed
    up to the file system once at the end by saveDB. An existing
    database is opened on disk in WAL mode (see loadDB), and every build
    is one transaction - without it each statement autocommits with an
    fsync, and an edit costs hundreds of them.
  */

  const runPasses = async () => {
    const sourceTime = stopwatch("build", "read sources in", config.verbose)
    const { sources: fileSources, deleted: fileDeletions } = await readSources(config, database, processors, scope)

    sourceTime()

    /*
      Stub enumeration runs *after* the file sources have been read, so
      settings.md has contributed this pass's settings and shadowing sees
      this pass's files - and *outside* the `if (sources.length ||
      deleted.length)` gate below, which is load-bearing. The follow-up
      build a deferred runner triggers has no stale file source, so gating
      enumeration on one would silently stop stubs updating after any
      deferred work - a very hard bug to trace back. It is cheap by
      contract: a couple of indexed queries and one string compare per
      stub. See tasks/2-in-progress/synthetic-sources.md.
    */
    const stubTime = stopwatch("build", "enumerated stubs in", config.verbose)
    const stubs = await readStubs(config, database, processors)
    stubTime()

    // Merged, not kept separate: downstream a stub is an ordinary source.
    const sources = [...fileSources, ...stubs.sources]
    const deleted = [...fileDeletions, ...stubs.deleted]

    // A deleted source's target file goes with it. source.delete()
    // removes the rows only - the database layer never touches the
    // filesystem - so without this a renamed or deleted page left its
    // old .html at the old URL until something swept the folder.
    // `force`: a virtual target never had a file. A source that routed
    // nowhere has no target at all.
    // Targets retracted this pass - an owned target a re-read no longer
    // returned, everything a deleted source owned - lose their files too,
    // unless a new row claims the path.
    await Promise.all(database.target.takeRetracted().map(targetPath => {
      if (database.target.get(targetPath)) return null
      return rm(path.join(config.targetFolder, targetPath), { force: true })
    }))

    await Promise.all(deleted.map(source => {
      if (!source.target) return null
      // Only remove the file if no target row claims that path any more.
      // Two sources can briefly route to one path - a stub standing down
      // as the author's own file takes over - and the row survives on
      // purpose in that case (see source.delete). Removing the file
      // anyway would delete the page the surviving source just produced.
      if (database.target.get(source.target)) return null
      return rm(path.join(config.targetFolder, source.target), { force: true })
    }))

    if (config.verbose) console.info(`${styleText("dim", "build:")} ${styleText("magenta", `found ${sources.length} stale files`)}`)

    // Necessary, not unnecessary: both stay null unless the `if
    // (sources.length)` block below reassigns them, and callers (see
    // bundler()'s wrapRunner) rely on `null` meaning "nothing pending" -
    // that contract needs a real value here even when nothing runs.
    let runBuffers = null
    let runFetches = null

    if (sources.length || deleted.length) {
      // Process source file abstracts
      transformTargets(sources, config, database, processors)

      // Buffer files (images, video, ...) found in this pass - deferred,
      // not run as part of this build. See readBuffers.js and the
      // `runBuffers` this function returns alongside `database`.
      runBuffers = readBuffers(sources, config, database).runBuffers

      // Every url a hook asked for through api.url() is fetched when
      // this runs, deferred the same way buffers are. It drains the
      // queue at run time, so a request made in writeFile (below) is
      // included too.
      runFetches = fetchURLs(config, database, processors).runFetches
    }


    const writeTime = stopwatch("build", "wrote files in", config.verbose)
    // The edited files' own targets first, then everyone else's - and
    // those only while no other edit is waiting.
    const written = await writeTargets(config, database, { first: fileSources.filter(a => a).map(source => source.sourcePath), shouldYield })
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
async function votive(userConfig) {
  // The config every stage and hook sees carries the logger, so a
  // plugin reports a bad value the same way votive reports a skipped
  // file: `config.log("error", …)` (see attempt.js). A caller's own
  // `log` is kept; otherwise the default one, which never drops an
  // error or a warning.
  const config = userConfig.log ? userConfig : { ...userConfig, log: loggerFor(userConfig) }
  let cache
  // Every pass's deferred handles since a public build() last took
  // them - a list, not "the latest": with trailing coalescing one
  // build() call can run two passes, and keeping only the second's
  // runners dropped the first's. A buffer read that was dropped was an
  // edit lost until the next full scan, and every caller waiting on
  // the loop ran the surviving runner once each - the same image
  // decoded twice, concurrently, into the same database.
  /** @type {{ runBuffers: (() => Promise<any>) | null, runFetches: (() => Promise<any>) | null }[]} */
  const pendingRunners = []
  // Deferred work runs one pass's batch at a time, chained here. It is
  // still outside the foreground queue - a runner never delays an
  // edit's build - but two passes' runners no longer overlap: three
  // large images edited in a row are decoded one after another, each
  // batch bounded by its own pLimit, not all at once.
  let deferredChain = Promise.resolve()

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
    the same single-flight coalescing as everything else. Batches from
    successive passes are serialised on deferredChain (see runBuild).
  */
  function wrapRunner(runner, kind) {
    if (!runner) return null
    return async () => {
      // A runner that reports it did nothing (fetchURLs, when nothing
      // was asked for) doesn't earn a follow-up build. fetchURLs also
      // reports the URL files it wrote, and the follow-up build is
      // scoped to them: reading a file is what puts its entry in the
      // index and restales the pages that asked, so this one pass reads
      // the new files and rewrites those pages.
      const did = await runner()
      // Only an explicit "nothing" skips the rebuild: a bare 0, or a
      // report with attempted 0. readBuffers returns undefined, and
      // undefined means it ran.
      const report = did && typeof did === "object" ? did : null
      if (did === 0 || (report && report.attempted === 0)) return
      const written = report?.written ?? []
      emit("deferred", kind)
      // The one caller that must not spawn deferred work of its own: this
      // *is* the deferred pass, and re-deferring from inside it would
      // chain another round every time. Internal on purpose - it was
      // public as `build({defer: false})`, which no caller outside votive
      // ever wanted and which made "skip the slow work" look like a
      // supported way to build a site. It is not: a build that skips
      // buffers and fetches produces an incomplete site.
      await runBuild(written.length ? { changed: written, deleted: [] } : {}, false)
    }
  }

  async function runOnce() {
    log("info", "starting build")
    const result = await bundle(config, cache, firstBuildDone ? takeScope() : undefined, { shouldYield: () => queued })
    firstBuildDone = true
    cache = result.database
    if (result.runBuffers || result.runFetches) pendingRunners.push({ runBuffers: result.runBuffers, runFetches: result.runFetches })
  }

  /**
   * Runs the batches a public build() found pending, in order, each
   * pass's buffers and fetches together. Chained onto deferredChain by
   * runBuild; the chain is what a caller's `deferred` resolves with.
   * @param {typeof pendingRunners} batches
   */
  async function runBatches(batches) {
    for (const { runBuffers, runFetches } of batches) {
      const buffers = wrapRunner(runBuffers, "buffers")
      const fetches = wrapRunner(runFetches, "fetches")
      await Promise.all([buffers?.(), fetches?.()])
    }
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
   * Runs a build. Deferred work (buffer reads, URL fetches) always starts;
   * `deferred` resolves once it and its follow-up build have finished. A
   * caller that wants the site listening now and the slow work finishing
   * in the background just doesn't await it (the dev server); one that
   * wants everything done awaits it (the CLI, tests).
   * @param {{ changed?: string[], deleted?: string[] }} [options]
   *   paths relative to sourceFolder. Given them, readSources skips the
   *   recursive scan entirely. Omit them for a full pass, which is what
   *   any caller that doesn't know gets.
   * @returns {Promise<{ deferred: Promise<void> }>}
   */
  async function build(options = {}) {
    return runBuild(options, true)
  }

  /**
   * @param {{ changed?: string[], deleted?: string[] }} options
   * @param {boolean} defer - false only for the follow-up build a deferred
   *   runner triggers (see wrapRunner). Not reachable from outside.
   */
  async function runBuild(options, defer) {
    mergeScope(options.changed ? { changed: options.changed, deleted: options.deleted } : null)
    if (running) {
      log("info", "queueing build")
      queued = true
    } else {
      running = loop()
    }
    await running

    emit("built")

    // Deferred work always runs for a public build(). It used to be the
    // caller's job to remember two nullable functions, which was the
    // easiest thing in the API to forget - and forgetting it meant a
    // fetched link preview or a processed image never reached the page.
    // `deferred` is the only thing returned. The database is
    // `site.database`, not a second copy here.
    //
    // Whoever wakes first takes everything pending and chains it; the
    // others find the list empty and wait on the same chain, so each
    // batch runs exactly once and every waiter sees it finish. A
    // follow-up build (defer false) leaves what its pass found for the
    // next public build() to take - it must not chain a round of its
    // own, or a runner that always finds work would never stop.
    if (!defer) return { deferred: Promise.resolve() }

    const batches = pendingRunners.splice(0)
    if (!batches.length) return { deferred: deferredChain }

    // The caller sees a batch's failure; the chain does not, so one
    // failed follow-up build cannot fail every deferred after it.
    const deferred = deferredChain.then(() => runBatches(batches))
    deferredChain = deferred.catch(() => undefined)
    return { deferred }
  }

  /**
   * Flushes a pending in-memory backup and closes the database, so the
   * file is released. A host that switches projects in-process (the
   * desktop app) needs this.
   */
  async function close() {
    if (!cache) return
    // A build still running would find the database gone under it. The
    // dev server closes its watchers first, but a handler already past
    // that point is mid-build() by the time this runs.
    if (running) await running.catch(() => {})
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
// a config - bundle() throws otherwise, naming resolveProjectFolder, and
// startServer resolves through it too - so it is part of using votive at
// all and belongs on the main entry. (systemDirectoryFor used to be
// exported beside it; where an app keeps its database and cache is the
// app's concern, and it moved to vowel.)
export { default as startServer, runCommand } from "./serve.js"
export { hostSlug } from "./urlStore.js"
export { resolveProjectFolder } from "./utils/resolveProjectFolder.js"
