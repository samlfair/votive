import path from "node:path"
import createPluginAPI from "./pluginAPI.js"
import applyReadResult from "./applyReadResult.js"

/** @import {VotiveConfig, FlatProcessors} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {Dirent} from "node:fs" */


/**
 * @param {Dirent[]} folders
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 */
function readFolders(folders = [], config, database, processors) {

  const folderProcessors = processors.filter(({ processor }) => processor.readFolder)

  const processed = folderProcessors.flatMap(({ processor, plugin }) => {

    const urls = folders.flatMap(folder => {
      let folderPath = path.relative(config.sourceFolder, path.join(folder.parentPath, folder.name))
      if(folderPath) folderPath += path.sep

      // readFolder isn't gated by "did anything change" the way readFile
      // is (it reruns for every folder on every pass), so its settings
      // contribution is fully regenerated each time rather than
      // accumulated indefinitely - accumulate() below does its own
      // source-scoped replacement (and cleanup, unconditionally, even
      // when settings ends up {}) now, so there's no preceding delete
      // here anymore. Deleting first, then conditionally recomputing,
      // was what made every re-contribution look brand new to
      // accumulate()'s first-appearance check - see
      // tasks/folder-staling-bug.md. (folderSettings read here can now
      // include this folder's own not-yet-replaced prior contribution -
      // harmless, since readFolder only ever reads settings other
      // sources contributed, e.g. fm_theme, never stylesheets/theme,
      // the labels it writes itself.)
      const folderSettings = database.setting.getByFolder(folderPath, folderPath)
      const folderAPI = createPluginAPI(database, folderPath)
      // The subject is { path, isRoot }, the same (subject, context) shape
      // every hook takes. Every return key is optional, and applyReadResult
      // handles the whole shape.
      const result = processor.readFolder({ path: folderPath, isRoot: false }, { api: folderAPI, settings: folderSettings, config })
      const { urls } = applyReadResult(result, {
        database,
        settingsFolder: folderPath,
        processor
      })
      return urls
    })


    const rootPath = path.relative(config.sourceFolder, config.sourceFolder)
    const rootSettings = database.setting.getByFolder(rootPath, rootPath)
    const rootAPI = createPluginAPI(database, rootPath)
    const rootResult = processor.readFolder({ path: rootPath, isRoot: true }, { api: rootAPI, settings: rootSettings, config })
    const { urls: rootURLs } = applyReadResult(rootResult, {
      database,
      settingsFolder: rootPath,
      processor
    })

    urls.push(...rootURLs)
    return urls
  })

  return processed
}

export default readFolders
