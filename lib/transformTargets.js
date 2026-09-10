import path from "node:path"
import { pageSettingsFolder } from "./utils/index.js"
import createPluginAPI from "./pluginAPI.js"
import applyReadResult from "./applyReadResult.js"

/** @import {VotiveConfig, FlatProcessors, UrlRequest} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFilesResult} from "./readSources.js" */

/**
 * Runs every matching processor's `transformFile` hook over each file's
 * stored target, in sequence - multiple transformer processors registered
 * for the same extension all apply, each seeing the previous one's output.
 *
 * The hook receives the target as stored and the standard context, and may
 * return `data` and/or `metadata` to change it. `target.create`'s
 * selective-update logic decides whether anything actually changed, so a
 * transformer that returns an equal value writes nothing.
 * @param {ReadSourceFilesResult} files
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {{transformURLs: UrlRequest[]}}
 */
function transformTargets(files, config, database, processors) {

  const transformURLs = files.flatMap(file => {
    if (!file.targetFilePath) return []

    const matching = processors.filter(({ processor }) =>
      processor.extensions.includes(file.extension) && processor.transformFile)

    // dirname() of a root-level file is ".", which is not how the root
    // folder is spelled anywhere else - it is "".
    const settingsFolder = path.dirname(file.sourcePath ?? "").replace(/^\.$/, "")

    return matching.flatMap(({ processor }) => {
      const target = database.target.get(file.targetFilePath)
      if (!target) return []

      const transformDependent = file.targetFilePath
      const settings = database.setting.getByFolder(pageSettingsFolder(file.targetFilePath), transformDependent)
      const api = createPluginAPI(database, transformDependent)

      const result = processor.transformFile(target, { api, settings, config })

      const { urls } = applyReadResult(result, {
        database,
        targetPath: file.targetFilePath,
        sourcePath: file.sourcePath,
        settingsFolder,
        processor
      })
      return urls
    })
  })

  return { transformURLs }
}

export default transformTargets
