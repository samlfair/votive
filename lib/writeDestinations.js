import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

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
    const destinationPath = path.join(config.destinationFolder, String(destination.path))
    const { dir } = path.parse(destinationPath)
    return writeProcessors.map(processor => {
      if (processor.syntax === destination.syntax) {
        const { data, encoding = 'utf-8' } = processor.write(destination, database, config)

        async function write() {
          await mkdir(dir, { recursive: true })
          await writeFile(destinationPath, data, encoding)
          database.freshenDependency(destination.path)
        }
        
        return write()
      }
    })
  })

  await Promise.all(writing)
}

export default writeDestinations