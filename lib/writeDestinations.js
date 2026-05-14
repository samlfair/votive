import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { checkFile } from "./utils/index.js"

/** @import {Abstract, Abstracts, VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */


/**
 * @param {VotiveConfig} config
 * @param {Database} database
 */
async function writeDestinations(config, database) {
  const writeProcessors = config && config.plugins && config.plugins.flatMap(plugin => (
    plugin.processors && plugin.processors.map(processor => processor.writeFile && processor).filter(a => a)
  )).filter(a => a)

  if (!writeProcessors || !writeProcessors.length) throw "No write processor provided"

  const targets = database.target.getStale()
  if (!targets) return

  const writing = targets.filter(({ path }) => path !== "0").flatMap(destination => {

    /* FIXME the following line doesn't make sense */
    if (!destination.path) database.target.markFresh(destination.path)
    const destinationPath = path.join(config.destinationFolder, String(destination.path))
    const { dir } = path.parse(destinationPath)
    return writeProcessors.map(async processor => {
      if (processor.extensions.includes(destination.syntax)) {
        const writeInfo = processor.writeFile(destination, database, config)
        if (!writeInfo) return
        const { data, encoding = 'utf-8' } = writeInfo

        async function write() {
          const destinationExists = checkFile(dir)

          // TODO: Avoid collisions
          if (!destinationExists) {
            await mkdir(dir, { recursive: true })
          }

          // TODO This was an abandoned attempt to handle colisions
          // database.createOrUpdateDestination({
          //   path: destinationPath,
          //   metadata: { one: 1 },
          //   abstract: { root: null },
          //   syntax: processor.syntax,
          //   writing: true
          // })

          

          await writeFile(destinationPath, data, encoding)

          database.target.markFresh(destination.path)
        }

        return write()
      }
    })
  })

  await Promise.all(writing)
}

export default writeDestinations