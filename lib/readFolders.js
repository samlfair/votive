/** @import {VotiveConfig, FlatProcessors, Jobs} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {Dirent} from "node:fs" */

import path from "node:path"

/**
 * @param {Dirent[]} folders
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {Jobs}
 */
function readFolders(folders, config, database, processors) {
  if(!folders) return
  return folders.flatMap(folder => {
    return config.plugins.flatMap(plugin => {
      return plugin.processors.flatMap(processor => {
        const folderPath = path.relative(config.sourceFolder, path.join(folder.parentPath, folder.name))
        return processor.read
          && processor.read.folder
          && processor.read.folder(folderPath, database, config)
      })
    })
  })
}

export default readFolders