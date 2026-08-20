import path from "node:path"
import createPluginAPI from "./pluginAPI.js"

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
      const { targets, urls, settings } = processor.readFolder(folderPath, folderSettings, folderAPI, config)
      database.setting.accumulate(folderPath, settings ?? {}, folderPath)
      urls.forEach(url => url.extension = processor.extensions[0])
      if (targets) {
        targets.forEach(target => {
          database.target.create(target)
        })
        return urls
      }
    })


    const rootPath = path.relative(config.sourceFolder, config.sourceFolder)
    const rootSettings = database.setting.getByFolder(rootPath, rootPath)
    const rootAPI = createPluginAPI(database, rootPath)
    const rootFolder = processor.readFolder(rootPath, rootSettings, rootAPI, config, true)
    database.setting.accumulate(rootPath, rootFolder.settings ?? {}, rootPath)

    if (rootFolder.targets) {
      rootFolder.targets.forEach(target => {
        database.target.create(target)
      })
    }

    rootFolder.urls.forEach(url => url.extension = processor.extensions[0])

    if(rootFolder.urls) urls.push(... rootFolder.urls)
    return urls
  })

  return processed
}

export default readFolders
