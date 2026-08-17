import path from "node:path"
import { pageSettingsFolder } from "./utils/index.js"
import createPluginAPI from "./pluginAPI.js"

/** @import {VotiveConfig, FlatProcessors, Abstract, UrlTasks, FlatProcessor, Abstracts} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFilesResult} from "./readSources.js" */

/**
 * @typedef {object} ReadAbstractsResult
 * @property {UrlTasks} urls
 * @property {ReadAbstractResult[]} abstracts
 */

/**
 * @typedef {object} ReadAbstractResult
 */

/**
 * Runs every matching processor's `transformFile` hook over each file's
 * abstract, threading the result through in sequence - multiple
 * transformer processors registered for the same extension all apply,
 * each seeing the previous one's output. The final abstract is written
 * back to the file's target (via `target.create`'s existing selective-
 * update/staling logic), so a transformer processor has a real effect on
 * what gets written, not just on which URL tasks get queued.
 * @param {ReadSourceFilesResult} files
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {{processedAbstracts: Abstracts, abstractsURLs: UrlTasks}}
 */
function readAbstracts(files, config, database, processors) {

  const processed = files.flatMap(file => {

    const { abstract: unprocessedAbstract } = file

    /**
     * @param {FlatProcessors} processors
     * @param {Abstract} abstract
     * @param {UrlTasks} urls
     */
    function recursiveProcess(processors, abstract, urls = []) {
      const [flatProcessor, ...rest] = processors
      if (!flatProcessor) return { abstract, urls }
      const { processor } = flatProcessor
      if (!processor.extensions.includes(file.extension)
        || !processor.transformFile
      ) return recursiveProcess(rest, abstract, urls)

      const transformDependent = file.targetFilePath
      const transformSettings = database.setting.getByFolder(pageSettingsFolder(file.targetFilePath), transformDependent)
      const transformAPI = createPluginAPI(database)

      const processed = processor.transformFile(abstract, transformSettings, transformAPI, config, file.targetFilePath)
      // transformFile has no filePath-override mechanism - the dependent
      // is already final, so this flushes with the same value it would
      // have used immediately before (see pluginAPI.js).
      transformAPI.flush(transformDependent)
      processed.urls && processed.urls.forEach(url => url.extension = file.extension)
      // Scoped to the source file's own folder, not the target's - see
      // the identical note in readSources.js.
      if (processed.settings) {
        const sourceFolder = path.relative(config.sourceFolder, path.dirname(file.sourceFilePath))
        database.setting.accumulate(sourceFolder, processed.settings, file.sourceFilePath)
      }
      return recursiveProcess(rest, processed.abstract, [...urls, ...(processed.urls || [])])
    }

    const { abstract, urls } = recursiveProcess(processors, unprocessedAbstract)

    // Only a transformer that actually ran changes this reference (the
    // no-match base case passes the original abstract straight through),
    // so this cheaply skips a write for files nothing transformed.
    if (file.targetFilePath && abstract !== unprocessedAbstract) {
      database.target.create({ path: file.targetFilePath, abstract })
    }

    return { abstract, urls }
  })

  const processedAbstracts = []
  const abstractsURLs = []

  processed.forEach(({ abstract, urls }) => {
    processedAbstracts.push(abstract)
    abstractsURLs.push(...urls)
  })

  return { processedAbstracts, abstractsURLs }
}

export default readAbstracts
