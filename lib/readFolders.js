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

  folderProcessors.forEach(({ processor }) => {

    folders.forEach(folder => {
      let folderPath = path.relative(config.sourceFolder, path.join(folder.parentPath, folder.name))
      if(folderPath) folderPath += path.sep

      // readFolder isn't gated by "did anything change" the way readFile
      // is (it reruns for every folder on every pass that has a stale
      // source), so its settings contribution is fully regenerated each
      // time - setting.write() replaces what this source wrote before
      // and prunes what it no longer writes, as one step. Deleting
      // first, then conditionally recomputing, was what made every
      // re-contribution look brand new to the first-appearance check -
      // see tasks/folder-staling-bug.md.
      //
      // folderSettings read here includes this folder's own prior
      // contribution. A readFolder must therefore never read a label it
      // writes: a guard like `if (!settings.x) write x` sees its own
      // previous pass, declines, and the prune removes the row - so it
      // flips on every build. Vowel's `theme` and `title` did exactly
      // that; vowel/tests/buildIdempotence.js pins it from the outside.
      const folderSettings = database.setting.getByFolder(folderPath, folderPath)
      const folderAPI = createPluginAPI(database, folderPath, processor)
      // The subject is { path, isRoot }, the same (subject, context) shape
      // every hook takes. Every return key is optional, and applyReadResult
      // handles the whole shape.
      const result = processor.readFolder({ path: folderPath, isRoot: false }, { api: folderAPI, settings: folderSettings, config })
      applyReadResult(result, {
        database,
        settingsFolder: folderPath
      })
    })


    const rootPath = path.relative(config.sourceFolder, config.sourceFolder)
    const rootSettings = database.setting.getByFolder(rootPath, rootPath)
    const rootAPI = createPluginAPI(database, rootPath, processor)
    const rootResult = processor.readFolder({ path: rootPath, isRoot: true }, { api: rootAPI, settings: rootSettings, config })
    applyReadResult(rootResult, {
      database,
      settingsFolder: rootPath
    })
  })

}


export default readFolders
