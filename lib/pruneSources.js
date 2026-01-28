import { readdir } from "node:fs/promises"
import path from "node:path"
/** @import {VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */



/**
 * @param {VotiveConfig} config
 * @param {Database} database
 */
async function pruneSources(config, database) {
  const sources = database.getAllSources()
  const files = (await readdir(config.sourceFolder, {
    withFileTypes: true,
    recursive: true
  })).map(file => {
    return file.isFile() ? path.join(file.parentPath, file.name) : null
  }).filter(a => typeof a === "string")

  sources.forEach(source => {
    if(files.includes(String(source.path))) return
    database.deleteSource(String(source.path))
  })

}

export default pruneSources
