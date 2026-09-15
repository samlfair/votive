import { decodeBuffer } from "encoding-sniffer"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"
import { splitURL } from "./utils/index.js"
import createPluginAPI from "./pluginAPI.js"
import { canonicalTargetPath } from "./createDatabase.js"
import { withSourceHelpers } from "./assetHelpers.js"
import applyReadResult from "./applyReadResult.js"
import { isStorePath, parseEntry } from "./urlStore.js"
import { buildRouter, settingsFolderFor } from "./router.js"

/** @import {VotiveConfig, VotivePlugin, VotiveProcessor, FlatProcessors, Router} from "./bundle.js" */
/** @import {Dirent} from "node:fs" */
/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {object} ReadSourcesResult
 * @property {Dirent[]} folders
 * @property {ReadSourceFileResult[]} sources
 */

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {Promise<ReadSourcesResult>}
 */
async function readSources(config, database, processors, scope = {}) {
  const { changed, deleted } = scope

  // An incremental pass: the watcher already knows which paths changed, so
  // there is nothing to discover. A full pass rescans the tree, which
  // costs a recursive readdir plus one stat per file per matching
  // processor before any real work - linear in file count, on every edit.
  if (changed) {
    const dirents = changed.map(relativePath => {
      const absolute = path.join(config.sourceFolder, relativePath)
      const parsed = path.parse(absolute)
      return { name: parsed.base, parentPath: parsed.dir, isFile: () => true }
    }).filter(fileFilter(config))

    const limit = pLimit(5)
    const reading = dirents.flatMap(readSourceFile(processors, database, config, limit))
    const sources = (await Promise.all(reading)).filter(a => a)

    // `deleted` is handed straight to the pruning step rather than being
    // discovered by diffing the whole tree against the database.
    const deletedSources = deleted?.length
      ? pruneNamedDeletions(config, database, deleted)
      : []

    return { folders: folderScope(config, database), sources, deleted: deletedSources }
  }

  const dirents = await fs.readdir(config.sourceFolder, {
    withFileTypes: true,
    recursive: true
  })

  const filteredDirents = (dirents || []).filter(fileFilter(config))

  const { files, folders } = Object.groupBy(filteredDirents, (dirent) => dirent.isFile() ? "files" : "folders")

  // No early return when there are no files. Object.groupBy omits the key
  // entirely rather than giving an empty array, and returning here skipped
  // pruneDeletions - so deleting the *last* source file in a project left
  // its row and its target behind forever, with nothing to notice. An
  // empty tree still has deletions to prune; it is the case where there
  // are the most of them.
  const sourceFiles = files || []

  // Bounded, not a bare Promise.all over every file: a cold start on a
  // large tree would otherwise open every source at once. `limit` was
  // already declared here and never used - and it has to wrap the call
  // itself, not the promise it returns, or the work has already started.
  const limit = pLimit(5)
  const readingSourceFiles = sourceFiles.flatMap(readSourceFile(processors, database, config, limit))

  const reading = [
    (await Promise.all(readingSourceFiles)).filter(a => a),
    pruneDeletions(config, database, filteredDirents)
  ]

  const [sources, deletedSources] = await Promise.all(reading)

  // `deleted` is kept separate rather than concatenated onto `sources`:
  // the two have different shapes (deleted entries are raw rows from
  // database.source.delete, with no `extension` and no `urls`), and
  // downstream stages were only tolerating the mixture by coincidence -
  // fetchURLs skipped the undefined tasks it produced, readAbstracts
  // matched no processor for them.
  return { folders, sources, deleted: deletedSources }
}

/**
 * The folder list for an incremental pass. readFolders still needs every
 * folder, and an incremental pass has no scan to take it from - so it
 * comes from the database, which knows every folder a target lives in.
 * @param {Database} database
 * @returns {{name: string, parentPath: string, isFile: () => boolean}[]}
 */
function folderScope(config, database) {
  const targets = database.target.getAll()
  const dirs = new Set(targets.map(target => target.dir).filter(dir => dir))
  return [...dirs].map(dir => {
    // readFolders rebuilds the relative path with
    // path.relative(sourceFolder, join(parentPath, name)), so these have
    // to be absolute to survive that round trip.
    const parsed = path.parse(path.join(config.sourceFolder, dir))
    return { name: parsed.base, parentPath: parsed.dir, isFile: () => false }
  })
}

/**
 * Removes the named sources, and the targets they produced.
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {string[]} deleted - paths relative to sourceFolder
 */
function pruneNamedDeletions(config, database, deleted) {
  return deleted.flatMap(sourcePath => database.source.delete(sourcePath) || [])
}

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {Dirent[]} dirents
 */
async function pruneDeletions(config, database, dirents) {
  // database.source.getAll() returns paths relative to config.sourceFolder
  // (see readSourceFile below) - these have to be relative-ized the same
  // way, or every existing source looks "deleted" against the absolute
  // paths fs.readdir hands back, and pruning cascades into deleting the
  // targets those sources just created (see source.delete() in
  // createDatabase.js). See tasks/desktop-app-architecture.md.
  const sourceFilePaths = new Set(dirents.map(d => d.isFile() && path.relative(config.sourceFolder, path.join(d.parentPath, d.name))))

  // Stub rows are excluded: a stub is a source a processor enumerates,
  // so it is never on disk and would look deleted on every full pass -
  // which would delete its target and its file, every time. Its lifetime
  // is the enumeration diff in stubs.js, not this scan.
  const sourceRecords = database.source.getAll().filter(record => record.stub === null || record.stub === undefined)
  const sourceRecordPaths = new Set(sourceRecords.map(r => r.path))

  const deletions = sourceRecordPaths.difference(sourceFilePaths)

  let deletedSources = []

  deletions.forEach(deletion => {
    deletedSources.push(database.source.delete(deletion))
  })

  return deletedSources.filter(a => a)
}

/**
 * @param {VotiveConfig} config
 */
function fileFilter(config) {
  /** @param {Dirent} dirent */
  return (dirent) => {
    const fullPath = path.join(dirent.parentPath, dirent.name)
    const isTargetFolder = !path.relative(config.targetFolder, fullPath)

    // The URL store is source - its files are read below, natively -
    // and it is checked before the hidden-folder rules because the
    // default store is a dot-folder.
    if (isStorePath(config, fullPath)) return dirent.isFile() && dirent.name.endsWith(".yaml")

    if (dirent.parentPath === config.targetFolder) {
      return false
    } else if (dirent.parentPath.startsWith(config.targetFolder + path.sep)) {
      return false // Ignore target folder
    } else if (dirent.name.startsWith(".")) {
      return false // Ignore hidden files
    } else if (dirent.parentPath.includes(path.sep + ".")) {
      return false // Ignore hidden folders
    } else if (dirent.parentPath.match(/^\.\w/)) {
      return false // Ignore hidden folders
    } if (isTargetFolder) {
      return false
    }
    return true
  }
}

/**
 * @typedef {ReadSourceFileResult[]} ReadSourceFilesResult
 */

/**
 * @typedef {object} ReadSourceFileResult
 * @property {ProcessorExtension} extension
 * @property {object} [metadata]
 * @property {string} [targetFilePath]
 * @property {string} [dir]
 * @property {string} sourcePath - relative to sourceFolder, like every
 *   other path votive records
 */

/**
 * @param {{ plugin: VotivePlugin, processor: VotiveProcessor }[]} processors
 * @param {Database} database
 * @param {VotiveConfig} config
 */
function readSourceFile(processors, database, config, limit) {
  /**
   * @param {import("node:fs").Dirent} dirent
   * @returns {Promise<ReadSourceFileResult>[]}
   */
  return (dirent) => {
    const { name, parentPath } = dirent
    const sourceFilePath = path.join(parentPath, name)
    const sourceFileInfo = path.parse(sourceFilePath)

    // A URL file is votive's own: two-key YAML (see urlStore.js), read
    // here rather than by a processor, so a cold start rebuilds the url
    // index from the files with no plugin involved. It is still a source
    // in every other way - stat'd by mtime, recorded in `sources`,
    // pruned when deleted - which is what makes editing one an ordinary
    // edit and deleting one an ordinary deletion.
    if (isStorePath(config, sourceFilePath)) {
      return [limit(() => readURLFile(sourceFilePath, database, config))]
    }

    const processing = processors.flatMap(({ plugin, processor }) => limit(() => process(plugin, processor, config)))

    /**
     * @param {VotivePlugin} plugin
     * @param {VotiveProcessor} processor
     * @param {VotiveConfig} config
     */
    async function process(plugin, processor, config) {
      const { readFile: read, extensions: filter, format } = processor
      if (filter.includes(sourceFileInfo.ext) && read) {

        // Check modified time
        const stat = await fs.stat(sourceFilePath)
        const sourcePath = path.relative(config.sourceFolder, sourceFilePath)
        const source = database.source.get(sourcePath)
        const diff = source && source.lastModified - Number(Math.floor(stat.mtimeMs))

        if (source && diff > -1) {
          return null
        }

        // No preemptive deleteBySource here - setting.write() below
        // replaces what this file wrote before and prunes what it no
        // longer writes, as one step. Deleting first, then conditionally
        // recomputing, was what made every re-contribution look brand
        // new to the first-appearance check - see
        // tasks/folder-staling-bug.md.
        const targetFilePath = buildRouter(config, processor, plugin)(sourcePath)
        const targetFileExtension = targetFilePath ? path.extname(targetFilePath) : null

        if (format === "buffer") {
          /*
            Buffer files (images, video, zips, ...) can be arbitrarily
            large, so they aren't read or parsed here - that would block
            the rest of the build on however long this one file takes,
            and there's nowhere safe to cache the raw bytes. Instead this
            just hands back a descriptor identifying what needs reading;
            readBuffers() turns these into deferred tasks the caller runs
            separately (see votive/lib/readBuffers.js), keyed off the
            presence of `readBuffer` below rather than a separate flag -
            it's only ever set here, so it's already a sufficient signal.
            Nothing is written to the database and the source isn't
            marked seen (updateSource()) until that actually happens.
          */
          return {
            metadata: null,
            extension: targetFileExtension,
            targetFilePath,
            dir: targetFilePath ? splitURL(targetFilePath) : null,
            sourcePath,
            readBuffer: read,
            processor,
            lastModified: Number(stat.mtimeMs.toFixed())
          }
        }

        if (format === "text") {
          // The file was already stat'd above to compare mtimes; a second
          // stat here assigned to a variable nothing read.
          const data = await fs.readFile(sourceFilePath, { encoding: "utf-8" })

          // read() processes one source file in isolation - it doesn't
          // get folder settings or read-capable api methods, since
          // anything it might want to query may not exist yet (this
          // file might be what creates it). It only creates targets and
          // links URLs, both fire-and-forget - see ReadPluginAPI in
          // bundle.js.
          //
          // The api is the real one, bound up front to the routed target
          // path, because that path is now final: read() is handed where
          // routing sent it and cannot move itself somewhere else. Bound
          // to the canonical form the row is stored under, so a router
          // that produced "About.html" still attributes its dependency
          // edges to "about.html". A source with no target gets "" - it
          // can still create targets and queue urls, and there is
          // nothing for an edge to point at.
          const readAPI = createPluginAPI(database, targetFilePath ? canonicalTargetPath(targetFilePath) : "", processor)

          // Both paths on `source` are relative to sourceFolder - the
          // form the router already works in and the database stores, so
          // a plugin asking a routing-shaped question ("is this the root
          // settings file?") gets an answer instead of an absolute path
          // it has to un-resolve first. Bytes come from source.buffer().
          const source = withSourceHelpers(
            { path: sourcePath, target: targetFilePath, text: data },
            config.sourceFolder
          )

          // Every hook takes (subject, context) with the same context
          // shape. `settings` is undefined for readFile alone: a read hook
          // runs before the things it might query exist.
          const content = read(source, { api: readAPI, settings: undefined, config })
          if (content) {

            // Settings are scoped to the folder the source *lands* in
            // (settingsFolderFor): the cascade's rewrite of its own path,
            // but not the processor's routing, which can send a target
            // anywhere or - like settings.md here - nowhere at all. That
            // is the folder its neighbouring pages read settings from,
            // and it is the hashed folder for a secret settings.md.
            //
            // Unconditional (not `if (settings)`) - setting.write() needs
            // to run even when this file no longer contributes anything,
            // so it can clean up what it used to contribute. Skipping
            // the call entirely here would skip that cleanup too - not
            // deferred, never, unless this file contributes something
            // else later. See tasks/folder-staling-bug.md.
            applyReadResult(content, {
              database,
              targetPath: targetFilePath,
              sourcePath,
              settingsFolder: settingsFolderFor(config, sourcePath)
            })

            const target = targetFilePath ? database.target.get(targetFilePath) : undefined
            updateSource(target?.path)
            return {
              metadata: content.metadata,
              extension: targetFileExtension,
              targetFilePath: target?.path ?? targetFilePath,
              dir: target?.dir ?? (targetFilePath ? splitURL(targetFilePath) : null),
              sourcePath
            }
          }
        }

        updateSource()

        return {
          targetFilePath: null,
          sourcePath: null,
          metadata: null,
          extension: null
        }

        /** @param {string} [targetOverride] - the target's actual final path, if filePath overrode routing */
        function updateSource(targetOverride) {
          const timeStamp = stat.mtimeMs.toFixed()

          if (source) {
            database.source.updateTimestamp(sourcePath, Number(timeStamp))

            // A real file has appeared where a stub was. The row becomes
            // a file row: otherwise source.getFile() never finds it, so
            // the stub is never shadowed, and pruneDeletions skips it, so
            // deleting the file would leave its target behind forever.
            if (source.stub !== null && source.stub !== undefined) {
              database.source.clearStub(sourcePath)
            }
          } else {
            database.source.create(sourcePath, targetOverride || targetFilePath, Number(timeStamp))
          }
        }

      }
    }

    return processing
  }
}

/**
 * Reads one URL file into the url index. Same mtime gate as a processor
 * read, so an unchanged file costs a stat. Returns the readSources shape
 * with no target: a URL file's destination is the URL, not a path.
 * @param {string} sourceFilePath - absolute
 * @param {Database} database
 * @param {VotiveConfig} config
 */
async function readURLFile(sourceFilePath, database, config) {
  const stat = await fs.stat(sourceFilePath)
  const sourcePath = path.relative(config.sourceFolder, sourceFilePath)
  const source = database.source.get(sourcePath)
  const diff = source && source.lastModified - Number(Math.floor(stat.mtimeMs))
  if (source && diff > -1) return null

  const text = await fs.readFile(sourceFilePath, { encoding: "utf-8" })
  const entry = parseEntry(text, sourcePath)
  database.url.create(entry, sourcePath)

  const timeStamp = Number(stat.mtimeMs.toFixed())
  if (source) {
    database.source.updateTimestamp(sourcePath, timeStamp)
    if (source.stub !== null && source.stub !== undefined) database.source.clearStub(sourcePath)
  } else {
    database.source.create(sourcePath, null, timeStamp)
  }

  return { targetFilePath: null, sourcePath, metadata: null, extension: null, dir: null }
}

export default readSources
export { fileFilter }
