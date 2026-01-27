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

  // TODO: Check file modified time

  const filteredDirents = (dirents || []).filter(fileFilter(config, database))
  const { files, folders } = Object.groupBy(filteredDirents, (dirent) => dirent.isFile() ? "files" : "folders")
  if (!files) return { folders, sources: [] }
  const readingSourceFiles = files.flatMap(readSourceFile(processors, database, config))
  const sources = readingSourceFiles && await Promise.all(readingSourceFiles)
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
    if (dirent.parentPath === config.destinationFolder) {
      return false
    } else if (dirent.parentPath.startsWith(config.destinationFolder + path.sep)) {
      return false // Ignore destination folder
    } else if (dirent.name.startsWith(".")) {
      return false // Ignore hidden files
    } else if (dirent.parentPath.includes(path.sep + ".")) {
      return false // Ignore hidden folders
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
      if (filter.extensions.includes(fileInfo.ext) && read && read.text) {

        // Check modified time
        const stat = await fs.stat(filePath)
        const source = database.getSource(filePath)


        if (source.lastModified === Number(stat.mtimeMs.toFixed())) return { jobs: [] }

        // Get destination route
        const destinationPath = route(filePath, plugin)

        // Set URL if exists
        const buffer = await fs.readFile(path.format(fileInfo))
        const data = decodeBuffer(buffer)
        const { jobs, abstract, metadata } = read.text(data, database, config)
        jobs && jobs.forEach(job => job.plugin = plugin.name)
        // TODO: Cache: Check if file already exists

        const timeStamp = stat.mtimeMs.toFixed()
        database.createSource(filePath, destinationPath, Number(timeStamp))
        database.createOrUpdateDestination({
          metadata,
          path: destinationPath,
          abstract: abstract,
          syntax: syntax
        })

        return { abstract, destinationPath, syntax, jobs }
      }
    }

    return processing
  }
}

/**
 * @param {string} filePath
 * @param {VotivePlugin} plugin
 */
function route(filePath, plugin) {
  if (!plugin.router) return ""
  return plugin.router(filePath) || ""
}

export default readSources
