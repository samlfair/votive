import { decodeBuffer } from "encoding-sniffer"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"
import { splitURL } from "./utils/index.js"
import { createAccumulatorAPI, dispatchAccumulatedCalls } from "./readAccumulator.js"

/** @import {VotiveConfig, VotivePlugin, VotiveProcessor, FlatProcessors, Abstracts, Abstract, UrlTasks, ProcessorExtension, Router} from "./bundle.js" */
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
async function readSources(config, database, processors) {
  const dirents = await fs.readdir(config.sourceFolder, {
    withFileTypes: true,
    recursive: true
  })

  const filteredDirents = (dirents || []).filter(fileFilter(config))

  const { files, folders } = Object.groupBy(filteredDirents, (dirent) => dirent.isFile() ? "files" : "folders")
  const loadingFiles = files.map(a => path.normalize(path.format({ name: a.name, dir: a.parentPath })))
  if (!files) return { folders, sources: [] }
  const limit = pLimit(5)
  const readingSourceFiles = files.flatMap(readSourceFile(processors, database, config))

  const reading = [
    (await Promise.all(readingSourceFiles)).filter(a => a),
    pruneDeletions(config, database, filteredDirents)
  ]

  const [sources, deletedSources] = await Promise.all(reading)

  return {
    folders,
    sources: [...sources, ...deletedSources]
  }
}

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {Dirent[]} dirents
 */
async function pruneDeletions(config, database, dirents) {
  const sourceFilePaths = new Set(dirents.map(d => d.isFile() && path.join(d.parentPath, d.name)))
  const sourceRecords = database.source.getAll()
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
    const isTargetFolder = !path.relative(config.targetFolder, path.join(dirent.parentPath, dirent.name))

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
 * @property {Abstract} abstract
 * @property {ProcessorExtension} extension
 * @property {object} [metadata]
 * @property {string} [targetFilePath]
 * @property {string} [dir]
 * @property {UrlTasks} urls
 * @property {string} sourceFilePath
 */

/**
 * @param {{ plugin: VotivePlugin, processor: VotiveProcessor }[]} processors
 * @param {Database} database
 * @param {VotiveConfig} config
 */
function readSourceFile(processors, database, config) {
  /**
   * @param {import("node:fs").Dirent} dirent
   * @returns {Promise<ReadSourceFileResult>[]}
   */
  return (dirent) => {
    const { name, parentPath } = dirent
    const sourceFilePath = path.join(parentPath, name)
    const sourceFileInfo = path.parse(sourceFilePath)

    const processing = processors.flatMap(({ plugin, processor }) => process(plugin, processor, config))

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
        const source = database.source.get(sourceFilePath)
        const diff = source && source.lastModified - Number(Math.floor(stat.mtimeMs))

        if (source && diff > -1) {
          return null
        }

        database.setting.deleteBySource(sourceFilePath)

        const targetFilePath = route(sourceFilePath, plugin, config)
        const targetFileExtension = path.extname(targetFilePath)

        // Set URL if exists
        const allURLs = []

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
            abstract: null,
            metadata: null,
            extension: targetFileExtension,
            targetFilePath,
            dir: splitURL(targetFilePath),
            sourceFilePath,
            urls: [],
            readBuffer: read,
            lastModified: Number(stat.mtimeMs.toFixed())
          }
        }

        if (format === "text") {
          const stats = await fs.stat(sourceFilePath)
          const data = await fs.readFile(sourceFilePath, { encoding: "utf-8" })

          // read() processes one source file in isolation - it doesn't
          // get folder settings or read-capable api methods, since
          // anything it might want to query may not exist yet (this
          // file might be what creates it). It only creates targets and
          // links URLs, both fire-and-forget - see ReadPluginAPI in
          // bundle.js. That's also what makes queuing every api.* call
          // here and replaying it once the final (possibly overridden)
          // target path is known unconditionally correct, not just an
          // approximation - see dispatchAccumulatedCalls below.
          const { api: readAPI, calls: readAPICalls } = createAccumulatorAPI()

          const content = read(data, sourceFilePath, targetFilePath, readAPI, config)
          if (content) {

            // filePath: an escape hatch for a plugin author to
            // programmatically override where routing sent this file -
            // read() is handed the routed targetFilePath as an argument,
            // decides its own override (if any) after seeing the
            // content, so this can't be known any earlier than here.
            const { urls, abstract, metadata, settings, data: targetData, filePath: filePathOverride, write } = content
            const finalTargetFilePath = filePathOverride || targetFilePath
            const finalTargetFileExtension = path.extname(finalTargetFilePath)

            if (Array.isArray(urls)) {
              allURLs.push(...urls)
            }

            const target = database.target.create({
              abstract,
              path: finalTargetFilePath,
              metadata,
              source: sourceFilePath,
              data: targetData,
              write,
            })

            dispatchAccumulatedCalls(database, target.path, readAPICalls)

            // Settings are scoped to the source file's own folder, not
            // the target's - a router can send a file's target anywhere
            // (or, like settings.md here, nowhere at all: its router
            // returns false, collapsing targetFilePath/target.dir to the
            // "0" placeholder regardless of which folder the file is
            // actually in), so target.dir can't be trusted for this.
            if (settings) {
              const sourceFolder = path.relative(config.sourceFolder, path.dirname(sourceFilePath))
              database.setting.accumulate(sourceFolder, settings, sourceFilePath)
            }

            allURLs.forEach(url => url.extension = processor.extensions[0])
            updateSource(target.path)
            return {
              abstract,
              metadata,
              extension: finalTargetFileExtension,
              targetFilePath: target.path,
              dir: target.dir,
              sourceFilePath,
              urls: allURLs
            }
          }
        }

        allURLs.forEach(url => url.extension = processor.extensions[0])
        updateSource()

        return {
          urls: allURLs,
          abstract: null,
          targetFilePath: null,
          sourceFilePath: null,
          metadata: null,
          extension: null
        }

        /** @param {string} [targetOverride] - the target's actual final path, if filePath overrode routing */
        function updateSource(targetOverride) {
          const timeStamp = stat.mtimeMs.toFixed()

          if (source) {
            database.source.updateTimestamp(sourceFilePath, Number(timeStamp))
          } else {
            database.source.create(sourceFilePath, targetOverride || targetFilePath, Number(timeStamp))
          }
        }

      }
    }

    return processing
  }
}

/**
 * @param {string} filePath
 * @param {VotivePlugin} plugin
 * @param {VotiveConfig} config
 */
function route(filePath, plugin, config) {
  const { dir, ...parsedPath } = path.parse(filePath)
  const rooty = !path.relative(config.sourceFolder, dir)
  const segments = ["", ...dir.split(path.sep).filter(a => a)]
  const pathInfo = {
    inRootDir: rooty,
    dir: segments,
    ...parsedPath
  }

  if (!plugin.router) return "0"

  const routedPath = plugin.router(pathInfo)

  if (!routedPath) return "0"

  if (routedPath.hasOwnProperty("dir") && Array.isArray(routedPath.dir)) {
    return path.normalize(path.format({
      dir: path.join(...routedPath.dir),
      root: routedPath.root || "",
      base: routedPath.base,
      name: routedPath.name,
      ext: routedPath.ext
    }))
  }

  const routedInfo = {
    dir: routedPath.dir || "",
    root: routedPath.root || "",
    base: routedPath.base,
    name: routedPath.name,
    ext: routedPath.ext
  }

  return path.normalize(path.format(routedInfo))
}

export default readSources
