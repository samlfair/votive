import path from "node:path"
import createPluginAPI from "./pluginAPI.js"
import applyReadResult from "./applyReadResult.js"
import { canonicalTargetPath } from "./createDatabase.js"
import { splitURL } from "./utils/index.js"
import { buildRouter, settingsFolderFor } from "./router.js"

/** @import {VotiveConfig, FlatProcessors} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFileResult} from "./readSources.js" */

/**
 * A stub is a source a processor enumerates rather than one found on
 * disk. It is declared as a path plus an optional payload, and its
 * content is produced on demand - so enumeration stays a cheap diff and
 * generation happens only when something actually changed.
 *
 * Two hooks, both on the processor:
 *
 *   processor.createStubs  = ({api, settings, config}) => [{path, params?}]
 *   processor.expandStubs = (stub, {config}) => ({text}) | ({buffer})
 *
 * Everything after `expandStubs` is the ordinary pipeline: the processor
 * claiming the extension reads it, its router routes it, and it is
 * transformed, tracked and written like any other source. That is the
 * whole point - a stub is not a second kind of target, it is a source
 * that happens not to be a file.
 *
 * See tasks/2-in-progress/synthetic-sources.md.
 */

/**
 * `JSON.stringify` with object keys sorted at every depth. Arrays keep
 * their order, because their order is meaningful.
 *
 * This is the fingerprint, stored as-is in `sources.stub` and compared by
 * string equality. Deliberately not hashed: the canonical string has to
 * be produced either way, so hashing is that same work plus a digest,
 * and the stored string is readable when you are working out why
 * something re-expanded.
 *
 * Sorting matters because an enumerator that builds the same params by a
 * different route - spreading a config object, say - would otherwise
 * produce a different key order and look changed on every pass, which
 * would re-expand forever.
 * @param {unknown} params
 * @returns {string}
 */
function canonicalParams(params) {
  return JSON.stringify(params ?? null, (key, value) => (
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]]))
      : value
  ))
}

/**
 * The api a `createStubs()` hook receives: reads only, and **untracked**.
 *
 * Nothing depends on the enumerator - it is not a target and has no
 * dependent to register edges against - so every read here goes through
 * the plain query rather than the tracking one. Handing it the ordinary
 * api bound to an empty dependent would grow dependency rows that nothing
 * ever reads (see
 * tasks/2-in-progress/dependency-edges-never-retracted.md).
 *
 * There is deliberately no `url()`: a fetch is attributed to a dependent
 * so that landing it can stale something, and an enumerator has none.
 * @param {Database} database
 */
function createEnumeratorAPI(database) {
  return Object.freeze({
    /** @param {string} filePath */
    target(filePath) {
      return database.target.get(filePath)
    },
    /** @param {string} sourcePath */
    targetBySource(sourcePath) {
      return database.target.getBySource(sourcePath)
    },
    /** @param {object} [params] */
    targets(params = {}) {
      return database.target.getByFolder({ ...params, dependent: undefined })
    },
    /**
     * Every distinct value stored under a metadata label across the
     * site, arrays flattened - "which tags exist", "which authors". One
     * indexed query, where the alternative is pulling every target
     * through targets() and flattening in JS on every pass. Read-only
     * and untracked like the rest of this api; the enumerator that asks
     * runs every pass anyway. Named as a read - noun, then qualifier -
     * like `targetBySource`.
     * @param {string} label
     * @returns {unknown[]}
     */
    metadataValues(label) {
      return database.metadata.distinct(label)
    },
    /**
     * The settings counterpart: every distinct value written for a
     * label at any folder - "which themes does any settings.md
     * declare". What an enumerator needs to declare one stub per
     * distinct folder-level configuration, since the `settings` it is
     * handed is the root's view only.
     * @param {string} label
     * @returns {unknown[]}
     */
    settingValues(label) {
      return database.setting.distinct(label)
    }
  })
}

/**
 * Runs every processor's `createStubs()` and returns the union, keyed by path.
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 */
function enumerate(config, database, processors) {
  const declared = new Map()

  // The root folder's settings view, untracked (no dependent). The
  // enumerator runs after the file sources have been read, so
  // settings.md has already contributed this pass.
  const settings = database.setting.getByFolder("", undefined)
  const api = createEnumeratorAPI(database)

  processors.forEach(({ plugin, processor }) => {
    if (!processor.createStubs) return

    const entries = processor.createStubs({ api, settings, config }) || []

    entries.forEach(entry => {
      if (!entry || !entry.path) {
        throw new Error(`Plugin "${plugin.name}" declared a stub with no path.`)
      }

      const existing = declared.get(entry.path)

      // Two producers for one path is the thing this whole design exists
      // to make impossible, so it is an error rather than a last-one-wins.
      // Named on both sides: the report is useless otherwise.
      if (existing) {
        throw new Error(
          `Two processors declare the stub "${entry.path}": ` +
          `"${existing.plugin.name}" and "${plugin.name}". ` +
          `A target has exactly one source.`
        )
      }

      declared.set(entry.path, { entry, plugin, processor })
    })
  })

  return declared
}

/**
 * Diffs the declared stubs against the recorded ones.
 *
 * Shadowing is by source path: a real file at a stub's path wins and the
 * stub is dropped, which is what makes "write your own 404.md" an
 * override rather than a conflict. The test is a query for a non-stub
 * `sources` row, not a stat - an incremental pass does no directory scan,
 * and the database already knows every file source. That also gets the
 * timing right in both directions without special-casing either: a file
 * added this pass is already recorded by the time enumeration runs, so
 * the stub drops immediately; a file deleted this pass had its row pruned
 * earlier in the same pass, so the stub comes back immediately.
 * @param {Database} database
 * @param {Map<string, {entry: object, plugin: object, processor: object}>} declared
 */
function diff(database, declared) {
  const live = new Map()

  declared.forEach((declaration, sourcePath) => {
    if (database.source.getFile(sourcePath)) return // shadowed by a real file
    live.set(sourcePath, declaration)
  })

  // A stub that is no longer declared is deleted exactly like a deleted
  // file: its row, its target, and (in bundle.js, which already does this
  // for the sources readSources prunes) its output file.
  const deleted = database.source.getStubs()
    .filter(row => !live.has(row.path))
    .map(row => database.source.delete(row.path))
    .filter(a => a)

  const changed = []

  live.forEach((declaration, sourcePath) => {
    const params = canonicalParams(declaration.entry.params)
    const row = database.source.get(sourcePath)

    // Identical params: nothing to do. This is the common case on every
    // pass, and it is one string compare.
    if (row && row.stub === params) return

    changed.push({ ...declaration, sourcePath, params, existing: row })
  })

  return { changed, deleted }
}

/**
 * Enumerates, diffs, expands what changed, and reads the result through
 * the ordinary pipeline. Returns the same shape readSources does, so
 * everything downstream - transformTargets, readBuffers, writeTargets -
 * treats a stub exactly like a file.
 *
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {Promise<{sources: ReadSourceFileResult[], deleted: object[]}>}
 */
async function readStubs(config, database, processors) {
  const declared = enumerate(config, database, processors)
  const { changed, deleted } = diff(database, declared)

  const sources = []

  for (const stub of changed) {
    const read = await readStub(stub, config, database, processors)
    if (read) sources.push(read)
  }

  return { sources, deleted }
}

/**
 * Expands one stub and reads it.
 *
 * `expandStubs` runs on the processor that *declared* the stub; the read runs
 * on whichever processor claims the extension. Those are often different
 * on purpose - a tags plugin can declare `.md` stubs without the markdown
 * processor knowing tags exist.
 */
async function readStub(stub, config, database, processors) {
  const { entry, plugin, processor, sourcePath, params } = stub
  const extension = path.extname(sourcePath)

  const reader = processors.find(({ processor: p }) =>
    p.extensions.includes(extension) && (p.readFile || p.readBuffer))

  if (!reader) {
    throw new Error(
      `Plugin "${plugin.name}" declared the stub "${sourcePath}", ` +
      `but no processor reads "${extension}".`
    )
  }

  if (!processor.expandStubs) {
    throw new Error(
      `Plugin "${plugin.name}" declared the stub "${sourcePath}" ` +
      `but has no expandStubs() to produce its content.`
    )
  }

  const expanded = await processor.expandStubs(
    { path: sourcePath, params: entry.params },
    { config }
  )

  if (!expanded) return null

  const readingProcessor = reader.processor
  const targetFilePath = buildRouter(config, readingProcessor, reader.plugin)(sourcePath)
  const targetFileExtension = targetFilePath ? path.extname(targetFilePath) : null

  // A buffer-format stub is a descriptor, exactly like a buffer file:
  // nothing is read or applied here, and readBuffers.js runs it as
  // deferred work. `stubBuffer` is what expand() produced, standing in
  // for the bytes readBuffers would otherwise read off disk.
  if (readingProcessor.format === "buffer") {
    return {
      metadata: null,
      extension: targetFileExtension,
      targetFilePath,
      dir: targetFilePath ? splitURL(targetFilePath) : null,
      sourcePath,
      readBuffer: readingProcessor.readFile || readingProcessor.readBuffer,
      processor: readingProcessor,
      lastModified: 0,
      stub: params,
      stubBuffer: expanded.buffer
    }
  }

  const text = expanded.text

  // Bound to the routed target path, canonicalized, for the same reason
  // readSources.js does it: a router producing "About.html" must still
  // attribute its edges to the row stored as "about.html".
  const readAPI = createPluginAPI(
    database,
    targetFilePath ? canonicalTargetPath(targetFilePath) : "",
    readingProcessor
  )

  // The same `source` shape a file gets, minus the filesystem: a stub has
  // no file, so buffer() serves the expanded text rather than reading a
  // path that does not exist, and stream() says so rather than throwing
  // ENOENT from somewhere confusing.
  const source = {
    path: sourcePath,
    target: targetFilePath,
    text,
    buffer: () => Buffer.from(text ?? ""),
    stream: () => {
      throw new Error(`"${sourcePath}" is a stub and has no file to stream.`)
    }
  }

  const content = readingProcessor.readFile(source, { api: readAPI, settings: undefined, config })

  if (!content) {
    recordStub(database, sourcePath, targetFilePath, params, stub.existing)
    return null
  }

  const settingsFolder = settingsFolderFor(config, sourcePath, targetFilePath)

  applyReadResult(content, {
    database,
    targetPath: targetFilePath,
    sourcePath,
    settingsFolder
  })

  const target = targetFilePath ? database.target.get(targetFilePath) : undefined
  recordStub(database, sourcePath, target?.path ?? targetFilePath, params, stub.existing)

  return {
    metadata: content.metadata,
    extension: targetFileExtension,
    targetFilePath: target?.path ?? targetFilePath,
    dir: target?.dir ?? (targetFilePath ? splitURL(targetFilePath) : null),
    sourcePath
  }
}

/**
 * Writes the stub's row. An update rather than an insert when the row is
 * already there, so a re-expanded stub doesn't accumulate duplicate
 * `sources` rows (`path` is not unique).
 */
function recordStub(database, sourcePath, targetPath, params, existing) {
  if (existing) {
    database.source.updateStub(sourcePath, params)
    return
  }
  database.source.create(sourcePath, targetPath || null, 0, params)
}

export default readStubs
export { canonicalParams, createEnumeratorAPI, enumerate, diff }
