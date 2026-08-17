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
      let folderPath = path.join(folder.parentPath, folder.name)
      if(folderPath) folderPath += path.sep

      // readFolder isn't gated by "did anything change" the way readFile
      // is (it reruns for every folder on every pass), so its settings
      // contribution is cleared and fully regenerated each time rather
      // than accumulated indefinitely.
      database.setting.deleteBySource(folderPath)
      const folderSettings = database.setting.getByFolder(folderPath, folderPath)
      const folderAPI = createPluginAPI(database)
      const { targets, urls, settings } = processor.readFolder(folderPath, folderSettings, folderAPI, config)
      // readFolder has no override mechanism - folderPath is already
      // final (see pluginAPI.js).
      folderAPI.flush(folderPath)
      if (settings) database.setting.accumulate(folderPath, settings, folderPath)
      urls.forEach(url => url.extension = processor.extensions[0])
      if (targets) {
        targets.forEach(target => {
          database.target.create(target)
        })
        return urls
      }
    })


    const rootPath = path.relative(config.sourceFolder, "")
    database.setting.deleteBySource(rootPath)
    const rootSettings = database.setting.getByFolder(rootPath, rootPath)
    const rootAPI = createPluginAPI(database)
    const rootFolder = processor.readFolder(rootPath, rootSettings, rootAPI, config, true)
    rootAPI.flush(rootPath)
    if (rootFolder.settings) database.setting.accumulate(rootPath, rootFolder.settings, rootPath)

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
