import path from "node:path"

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

      const { targets, urls } = processor.readFolder(folderPath, database, config)
      urls.forEach(url => url.extension = processor.extensions[0])
      if (targets) {
        targets.forEach(target => {
          database.target.create(target)
        })
        return urls
      }
    })


    const rootPath = path.relative(config.sourceFolder, "")
    const rootFolder = processor.readFolder(rootPath, database, config, true)

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
