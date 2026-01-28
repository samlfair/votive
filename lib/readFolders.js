/** @import {VotiveConfig, FlatProcessors} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {Dirent} from "node:fs" */

import path from "node:path"

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
      const folderPath = path.relative(config.sourceFolder, path.join(folder.parentPath, folder.name))

      /** @ts-ignore `.read` is throwing a warning, but it's guarded above */
      const { destinations, jobs } = processor.read.folder(folderPath, database, config)
      jobs.forEach(job => job.plugin = plugin.name)
      if (destinations) {
        destinations.forEach(destination => {
          database.createOrUpdateDestination(destination)
        })
        return jobs
      }
    })

    const rootFolder = processor.read.folder("", database, config)

    if (rootFolder.destinations) {
      rootFolder.destinations.forEach(destination => {
        database.createOrUpdateDestination(destination)
      })
    }

    rootFolder.jobs.forEach(job => job.plugin = plugin.name)

    if(rootFolder.jobs) jobs.push(... rootFolder.jobs)
    return jobs
  })

  return processed
}

export default readFolders