import { readdir, rm } from "node:fs/promises"
import path from "node:path"

/** @import {Abstract, Abstracts, VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */


/**
 * @param {VotiveConfig} config
 * @param {Database} database
 */
async function cleanDeletions(config, database) {
  // Must remove from sources first??
  const dirents = new Set((await readdir(config.destinationFolder, {
    recursive: true,
    withFileTypes: true
  })).map(d => d.isFile() && path.relative(config.destinationFolder, path.join(d.parentPath, d.name)))
    .filter(a => a)
  )

  const targets = new Set(database.target.getAll().map(t => t.path))

  const deletions = dirents.difference(targets)

  deletions.forEach(async deletion => {
    const deletionPath = path.join(config.destinationFolder, deletion)
    await rm(deletionPath)
  })

}

export default cleanDeletions
