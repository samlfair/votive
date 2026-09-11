import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { checkFile, pageSettingsFolder } from "./utils/index.js"
import withAssetHelpers from "./assetHelpers.js"
import createPluginAPI from "./pluginAPI.js"

/** @import {VotiveConfig} from "./bundle.js" */
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

  if (!writeProcessors || !writeProcessors.length) {
    console.info("No write processor provided.")
    return 0
  }

  const targets = database.target.getStale()

  if (!targets) return 0

  // "0" is the placeholder a source whose router returned false collapses
  // to. Nothing is ever written for it, but it still has to be marked
  // fresh: without that it stays stale forever, so getStale() is never
  // empty and every build reports work it isn't doing.
  const writable = targets.filter(({ path }) => {
    if (path !== "0") return true
    database.target.markFresh(path)
    return false
  })

  const writing = writable.flatMap(target => {
    const targetPath = path.join(config.targetFolder, String(target.path))
    const { dir } = path.parse(targetPath)
    return writeProcessors.map(async processor => {
      if (processor.extensions.includes(target.extension)) {
        const writeDependent = target.path
        const writeSettings = database.setting.getByFolder(pageSettingsFolder(target.path), writeDependent)
        const writeAPI = createPluginAPI(database, writeDependent)

        const writeInfo = await processor.writeFile(withAssetHelpers(target, config.sourceFolder), { api: writeAPI, settings: writeSettings, config })

        // Returning nothing means "nothing to write": the target is left
        // alone and marked fresh. Removal is the explicit { delete: true }
        // below, so forgetting a `return` can't destroy a target - it used
        // to mean exactly that.
        if (!writeInfo) {
          database.target.markFresh(target.path)
          return
        }

        if (writeInfo.delete) {
          try {
            database.target.delete(target.path)
            // targetPath, not target.path: the stored path is relative to
            // sourceFolder and would resolve against process.cwd().
            return await rm(targetPath, { force: true })
          } catch (e) {
            console.error(e)
            return
          }
        }

        const { data, encoding = 'utf-8' } = writeInfo

        async function write() {
          // A virtual target (write = 0) - its processor still ran above
          // (any side effects, like api.createTarget() calls, happen
          // normally), but nothing lands on disk for it. It's only ever
          // read back via api.target()/api.targets(), so there's nothing
          // more to do here beyond marking it fresh.
          if (target.write === false) {
            database.target.markFresh(target.path)
            return
          }

          const targetExists = checkFile(dir)

          if (!targetExists) {
            await mkdir(dir, { recursive: true })
          }

          // Not `if (data)`: an empty string is legitimate output (an
          // empty CSS file, a cleared page). Guarding on truthiness meant
          // such a target was never written and never marked fresh, so it
          // rebuilt on every pass forever.
          if (data !== undefined && data !== null) {
            if (processor.format === "text") {
              await writeFile(targetPath, data, encoding)
              // After the first write a page's `data` is its rendered
              // output, which is what gives live-reload a body without
              // reading the file back. setData, not target.create: create
              // marks the target itself stale, so it would be stale again
              // the moment it was written and every build would rewrite
              // every page forever.
              database.target.setData(target.path, data)
            } else {
              await writeFile(targetPath, data)
            }
            database.target.markFresh(target.path)
          }
        }

        return write()
      }
    })
  })

  await Promise.all(writing)

  return writable.length
}

export default writeTargets
