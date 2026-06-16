import { decodeBuffer } from "encoding-sniffer"
import fs from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"

/** @import {VotiveConfig, VotivePlugin, VotiveProcessor, FlatProcessors, Abstracts, Abstract, Jobs, ProcessorSyntax, Router} from "./bundle.js" */
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
    const isDestinationFolder = !path.relative(config.destinationFolder, path.join(dirent.parentPath, dirent.name))

    if (dirent.parentPath === config.destinationFolder) {
      return false
    } else if (dirent.parentPath.startsWith(config.destinationFolder + path.sep)) {
      return false // Ignore destination folder
    } else if (dirent.name.startsWith(".")) {
      return false // Ignore hidden files
    } else if (dirent.parentPath.includes(path.sep + ".")) {
      return false // Ignore hidden folders
    } else if (dirent.parentPath.match(/^\.\w/)) {
      return false // Ignore hidden folders
    } if (isDestinationFolder) {
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
 * @property {ProcessorSyntax} syntax
 * @property {object} [metadata]
 * @property {string} [targetFilePath]
 * @property {string} [dir]
 * @property {Jobs} jobs
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
        const allJobs = []

        if (format === "buffer") {

          // FIXME update this type
          const data = read(sourceFilePath, database, config)
          const { metadata, abstract, jobs } = data

          const target = database.target.create({
            metadata,
            abstract,
            path: targetFilePath,
          })


          if (Array.isArray(jobs)) {
            allJobs.push(...jobs)
          }
        }

        if (format === "text") {
          const stats = await fs.stat(sourceFilePath)
          const data = await fs.readFile(sourceFilePath, { encoding: "utf-8" })

          const { jobs, abstract, metadata } = read(data, sourceFilePath, targetFilePath, database, config)


          if (Array.isArray(jobs)) {
            allJobs.push(...jobs)
          }

          const target = database.target.create({
            abstract,
            path: targetFilePath,
            metadata,
          })

          // FIXME this won't work with the refactor
          allJobs && allJobs.forEach(job => job.syntax = processor.extensions[0])
          updateSource()
          return {
            abstract,
            metadata,
            syntax: targetFileExtension,
            targetFilePath: target.path,
            dir: target.dir,
            sourceFilePath,
            jobs: allJobs
          }
        }

        // FIXME Job syntax
        allJobs && allJobs.forEach(job => job.syntax = processor.extensions[0])
        updateSource()

        return {
          jobs: allJobs,
          abstract: null,
          targetFilePath: null,
          sourceFilePath: null,
          metadata: null,
          syntax: null
        }

        function updateSource() {
          const timeStamp = stat.mtimeMs.toFixed()

          if (source) {
            database.source.updateTimestamp(sourceFilePath, Number(timeStamp))
          } else {
            database.source.create(sourceFilePath, targetFilePath, Number(timeStamp))
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
