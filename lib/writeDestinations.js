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
    plugin.processors && plugin.processors.map(({ write, syntax }) => write && { write, syntax }).filter(a => a)
  )).filter(a => a)

  if (!writeProcessors || !writeProcessors.length) throw "No write processor provided"

  const destinations = database.getStaleDestinations()
  if (!destinations) return

  const writing = destinations.flatMap(destination => {
    if(!destination.path) database.freshenDependency(destination.path)
    const destinationPath = path.join(config.destinationFolder, String(destination.path))
    const { dir } = path.parse(destinationPath)
    return writeProcessors.map(async processor => {
      if (processor.syntax === destination.syntax) {
        const writeInfo = await processor.write(destination, database, config)
        if(!writeInfo) return
        const { data, buffer, encoding = 'utf-8' } = writeInfo

        async function write() {
          const destinationExists = checkFile(dir)

          // TODO: Avoid collisions
          if(!destinationExists) {
            await mkdir(dir, { recursive: true })
          }

          if(buffer) {
            await writeFile(destinationPath, buffer)
          } else if(data) {
            await writeFile(destinationPath, data, encoding)
          }

          database.freshenDependency(destination.path)
        }
        
        return write()
      }
    })
  })

  await Promise.all(writing)
}

export default writeDestinations