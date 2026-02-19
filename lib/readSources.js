import { decodeBuffer } from "encoding-sniffer"
import fs from "node:fs/promises"
import path from "node:path"
import { visit } from "unist-util-visit"

/** @import {VotiveConfig, VotivePlugin, VotiveProcessor, FlatProcessors, Abstracts, Abstract, Jobs, ProcessorSyntax} from "./bundle.js" */
/** @import {Dirent} from "node:fs" */
/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {object} ReadSourcesResult
 * @property {Dirent[]} folders
 * @property {ReadSourceFilePlugin[]} sources
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

  const filteredDirents = (dirents || []).filter(fileFilter(config, database))
  const { files, folders } = Object.groupBy(filteredDirents, (dirent) => dirent.isFile() ? "files" : "folders")
  if (!files) return { folders, sources: [] }
  const readingSourceFiles = files.flatMap(readSourceFile(processors, database, config))
  const sources = readingSourceFiles && (await Promise.all(readingSourceFiles)).filter(a => a)
  return {
    folders,
    sources
  }
}

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 */
function fileFilter(config, database) {
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
    } else if(dirent.parentPath.match(/^\.\w/)) {
      return false // Ignore hidden folders
    } if(isDestinationFolder) {
      return false
    }
    return true
  }
}

/**
 * @typedef {ReadSourceFilePlugin[]} ReadSourceFileResult
 */

/**
 * @typedef {object} ReadSourceFilePlugin
 * @property {Abstract} abstract
 * @property {ProcessorSyntax} syntax
 * @property {Jobs} jobs
 * @property {string} destinationPath
 */

/**
 * @param {{ plugin: VotivePlugin, processor: VotiveProcessor }[]} processors
 * @param {Database} database
 * @param {VotiveConfig} config
 */
function readSourceFile(processors, database, config) {
  /**
   * @param {import("node:fs").Dirent} dirent
   * @returns {Promise<ReadSourceFilePlugin>[]}
   */
  return (dirent) => {
    const { name, parentPath } = dirent
    const filePath = path.join(parentPath, name)
    const fileInfo = path.parse(filePath)

    const processing = processors.flatMap(({ plugin, processor }) => process(plugin, processor, config))

    /**
     * @param {VotivePlugin} plugin
     * @param {VotiveProcessor} processor
     * @param {VotiveConfig} config
     */
    async function process(plugin, processor, config) {
      const { read, filter, syntax } = processor
      if (filter && filter.extensions.includes(fileInfo.ext) && read && (read.text || read.path)) {

        // Check modified time
        const stat = await fs.stat(filePath)
        const source = database.getSource(filePath)


        if (source && source.lastModified === Number(stat.mtimeMs.toFixed())) return null

        database.deleteSettings(filePath)

        // Get destination route
        const destinationPath = route(filePath, plugin, config)

        // Set URL if exists
        const allJobs = []
        const destination = {}

        // TODO: Rename "path" to "asset"
        if (read.path) {
          const {metadata, abstract, jobs} = await read.path(filePath, database, config)

          database.createOrUpdateDestination({
            metadata,
            abstract,
            path: destinationPath,
            syntax
          })

          if(Array.isArray(jobs)) {
            allJobs.push(...jobs)
          }
        }

        if (read.text) {
          const buffer = await fs.readFile(path.format(fileInfo))
          const data = decodeBuffer(buffer)

          const { jobs, abstract, metadata } = read.text(data, filePath, destinationPath, database, config)

          if(Array.isArray(jobs)) {
            allJobs.push(...jobs)
          }

          database.createOrUpdateDestination({
            abstract,
            path: destinationPath,
            metadata,
            syntax
          })

          // TODO: DRY up
          allJobs && allJobs.forEach(job => job.syntax = processor.syntax)
          updateSource()
          return { abstract, destinationPath, syntax, jobs: allJobs }
        }

        // TODO: DRY up
        allJobs && allJobs.forEach(job => job.syntax = processor.syntax)
        updateSource()

        return {
          jobs: allJobs,
          abstract: null,
          destinationPath: null,
          metadata: null,
          syntax
        }

        function updateSource() {
          const timeStamp = stat.mtimeMs.toFixed()

          if (source) {
            database.updateSource(filePath, Number(timeStamp))
          } else {
            database.createSource(filePath, destinationPath, Number(timeStamp))
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
  const pathInfo = {
    inRootDir: rooty,
    dir: dir.split(path.sep),
    ...parsedPath
  }
  if (!plugin.router) return "0"
  const routedPath = plugin.router(pathInfo)
  if (routedPath && typeof routedPath.dir !== "string") {
    routedPath.dir = path.join(...routedPath.dir)
  }
  return routedPath ? path.format(routedPath) : "0"
}

export default readSources
