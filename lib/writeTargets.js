import { mkdir, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import pLimit from "p-limit"
import { checkFile, pageSettingsFolder } from "./utils/index.js"
import withAssetHelpers from "./assetHelpers.js"
import createPluginAPI from "./pluginAPI.js"
import attempt from "./attempt.js"

/** @import {VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */

/**
 * Writes every stale target, the edited sources' own targets first.
 *
 * `first` names the source files read this pass; the targets they
 * produce (routed and owned) are written and awaited before anything
 * else starts, so the page a person is editing lands - and its
 * live-reload frame goes out - before the site's dependents (a feed
 * that re-renders every entry, the folder index, backlinks) are even
 * begun. Those follow, bounded, and each checks `shouldYield` before
 * it starts: when another edit is already waiting, the rest are left
 * stale for the pass that edit starts, which writes them after its own
 * page. Nothing is skipped, only deferred - a stale target is written
 * by whichever pass gets to it - so a person typing sees every
 * keystroke's page promptly and the dependents catch up when they
 * pause.
 *
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {{ first?: Iterable<string>, shouldYield?: () => boolean }} [options]
 * @returns {Promise<number>} how many stale targets were found, so callers
 *   (bundle.js's saveDB decision) can tell real database work happened
 *   here even on a pass where no source file changed - e.g. the rebuild
 *   runBuffers()/runFetches() trigger once they finish.
 */
async function writeTargets(config, database, { first = [], shouldYield = () => false } = {}) {
  const writeProcessors = config && config.plugins && config.plugins.flatMap(plugin => (
    plugin.processors && plugin.processors.map(processor => processor.writeFile && processor).filter(a => a)
  )).filter(a => a)

  if (!writeProcessors || !writeProcessors.length) {
    console.info("No write processor provided.")
    return 0
  }

  const targets = database.target.getStale()

  if (!targets) return 0

  const own = new Set(first)
  const limit = pLimit(5)
  // A write that throws is logged and leaves its target stale, so the
  // next pass tries again; it is not retried by this pass's rewrite
  // rounds below (attempt.js).
  const failed = new Set()

  /** @param {import("./createDatabase.js").TargetOutput} target */
  const writeTarget = (target) => attempt(config, `writing "${target.path}"`, () => writeOne(target)).then(result => {
    if (result === undefined) failed.add(target.path)
    return result
  })

  /** @param {import("./createDatabase.js").TargetOutput} target */
  const writeOne = (target) => {
    const targetPath = path.join(config.targetFolder, String(target.path))
    const { dir } = path.parse(targetPath)
    return Promise.all(writeProcessors.map(async processor => {
      if ((processor.extensions ?? []).includes(target.extension)) {
        const writeDependent = target.path
        const writeSettings = database.setting.getByFolder(pageSettingsFolder(target.path), writeDependent)
        const writeAPI = createPluginAPI(database, writeDependent, processor)

        const writeInfo = await processor.writeFile(withAssetHelpers(target, config.sourceFolder), { api: writeAPI, settings: writeSettings, config })

        // A virtual target has no file, whatever its writeFile returned. One
        // that was written before and is virtual now loses its file here:
        // otherwise it stayed at its url until the dev server's startup
        // sweep, and a build that deploys its folder published it.
        // `force`: usually there is no file.
        if (target.write === false) await rm(targetPath, { force: true })

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
    }))
  }

  await Promise.all(targets.filter(target => own.has(target.source)).map(target => limit(() => writeTarget(target))))
  await Promise.all(targets.filter(target => !own.has(target.source)).map(target => limit(() => {
    if (shouldYield()) return undefined
    return writeTarget(target)
  })))

  // What this pass's own writes restaled. A write stores what it
  // produced as the target's data, and a target that read another's
  // data - a feed, whose entries are rendered pages - is staled by it;
  // written before that page in the same pass, it would stay stale
  // until something else happened to rebuild it. So each round writes
  // what the last one left, until nothing is. Bounded, for a writer
  // that stales itself; and not while an edit is waiting, whose pass
  // will get to them.
  for (let round = 0; round < MAX_REWRITE_ROUNDS; round++) {
    if (shouldYield()) return targets.length
    const restaled = database.target.getStale().filter(target => !failed.has(target.path))
    if (!restaled.length) return targets.length
    await Promise.all(restaled.map(target => limit(() => writeTarget(target))))
  }
  const left = database.target.getStale().filter(target => !failed.has(target.path))
  if (left.length) config.log?.("warn", `${left.length} target(s) still stale after ${MAX_REWRITE_ROUNDS} rewrite rounds: a writeFile is restaling its own target (${left.slice(0, 3).map(target => target.path).join(", ")})`)

  return targets.length
}

const MAX_REWRITE_ROUNDS = 3

export default writeTargets
