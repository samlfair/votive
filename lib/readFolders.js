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

  const folderProcessors = processors.filter(({ processor }) => processor.read && processor.read.folder)

  const processed = folderProcessors.flatMap(({ processor, plugin }) => {

    const jobs = folders.flatMap(folder => {
      let folderPath = path.join(folder.parentPath, folder.name)
      if(folderPath) folderPath += path.sep


      /** @ts-ignore `.read` is throwing a warning, but it's guarded above */
      const { destinations, jobs } = processor.read.folder(folderPath, database, config)
      jobs.forEach(job => job.syntax = processor.syntax)
      if (destinations) {
        destinations.forEach(destination => {
          database.createOrUpdateDestination(destination)
        })
        return jobs
      }
    })

    
    const rootInfo = path.parse(config.sourceFolder)
    const rootPath = rootInfo.name
      ? path.format(rootInfo) + path.sep
      : ""

    // TODO: Add isRoot to type definition
    const rootFolder = processor.read.folder(rootPath, database, config, true)

    if (rootFolder.destinations) {
      rootFolder.destinations.forEach(destination => {
        database.createOrUpdateDestination(destination)
      })
    }

    rootFolder.jobs.forEach(job => job.syntax = processor.syntax)

    if(rootFolder.jobs) jobs.push(... rootFolder.jobs)
    return jobs
  })

  return processed
}

export default readFolders