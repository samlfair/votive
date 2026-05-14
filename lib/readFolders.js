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

    const jobs = folders.flatMap(folder => {
      let folderPath = path.join(folder.parentPath, folder.name)
      if(folderPath) folderPath += path.sep

      const { targets, jobs } = processor.readFolder(folderPath, database, config)
      jobs.forEach(job => job.syntax = processor.syntax)
      if (targets) {
        targets.forEach(target => {
          database.target.create(target)
        })
        return jobs
      }
    })

    
    const rootPath = path.relative(config.sourceFolder, "")
    const rootFolder = processor.readFolder(rootPath, database, config, true)

    if (rootFolder.targets) {
      rootFolder.targets.forEach(target => {
        database.target.create(target)
      })
    }

    rootFolder.jobs.forEach(job => job.syntax = processor.syntax)

    if(rootFolder.jobs) jobs.push(... rootFolder.jobs)
    return jobs
  })

  return processed
}

export default readFolders