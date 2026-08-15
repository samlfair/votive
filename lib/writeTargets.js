import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { checkFile, pageSettingsFolder } from "./utils/index.js"
import withAssetHelpers from "./assetHelpers.js"
import createPluginAPI from "./pluginAPI.js"

/** @import {Abstract, Abstracts, VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {Promise<number>} how many stale targets were found, so callers
 *   (bundle.js's saveDB decision) can tell real database work happened
 *   here even on a pass where no source file changed - e.g. the rebuild
 *   runBuffers()/runFetches() trigger once they finish.
 */
async function writeTargets(config, database) {
  const writeProcessors = config && config.plugins && config.plugins.flatMap(plugin => (
    plugin.processors && plugin.processors.map(processor => processor.writeFile && processor).filter(a => a)
  )).filter(a => a)

  if (!writeProcessors || !writeProcessors.length) throw "No write processor provided"

  const targets = database.target.getStale()

  if (!targets) return 0

  const writing = targets.filter(({ path }) => path !== "0").flatMap(target => {

    /* FIXME the following line doesn't make sense */
    if (!target.path) database.target.markFresh(target.path)
    const targetPath = path.join(config.targetFolder, String(target.path))
    const { dir } = path.parse(targetPath)
    return writeProcessors.map(async processor => {
      if (processor.extensions.includes(target.extension)) {
        const writeDependent = target.path
        const writeSettings = database.setting.getByFolder(pageSettingsFolder(target.path), writeDependent)
        const writeAPI = createPluginAPI(database, writeDependent)

        const writeInfo = await processor.writeFile(withAssetHelpers(target), writeSettings, writeAPI, config)
        if (!writeInfo) {
          try {
            database.target.delete(target.path)
            return await rm(target.path)
          } catch (e) {
            console.error(e)
          }
        }
        const { data, encoding = 'utf-8' } = writeInfo

        async function write() {
          const targetExists = checkFile(dir)

          if (!targetExists) {
            await mkdir(dir, { recursive: true })
          }

          if (data) {
            if (processor.format === "text") {
              await writeFile(targetPath, data, "utf-8")
              database.target.markFresh(target.path)
            } else {
              await writeFile(targetPath, data)
              database.target.markFresh(target.path)
            }
          }
        }

        return write()
      }
    })
  })

  await Promise.all(writing)

  return targets.length
}

export default writeTargets
