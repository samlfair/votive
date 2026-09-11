import path from "node:path"
import { readdirSync, rmSync } from "node:fs"
import { checkFile } from "./utils/index.js"

/** @import {VotiveConfig} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */

/**
 * @typedef {object} CleanupSummary
 * @property {string[]} prunedTargets - target rows deleted outright: both
 *   the target's file and its source were already gone. pruneDeletions()
 *   (readSources.js) should have caught this during a normal build - if
 *   it's showing up here, something skipped that path (an interrupted
 *   build, a manually edited database).
 * @property {string[]} healedTargets - target rows whose file was missing
 *   but shouldn't be (source file still exists, or it's a synthetic
 *   target with no source at all - e.g. sitemap.xml). Not safe to delete
 *   outright (that would just make votive forget the target), so these
 *   are marked stale instead, so the next write pass regenerates them.
 * @property {string[]} prunedDependencies - dependency rows deleted
 *   because their `dependent` no longer matches any known target.
 * @property {string[]} prunedFiles - files deleted from the target folder
 *   because no non-virtual target row claims them: output left behind by
 *   an interrupted build, a previous run that wrote different paths, or
 *   a build that deleted rows without reaching the file.
 */

/**
 * A non-blocking consistency sweep between votive's database and the
 * filesystem. This does a full stat() pass over every written target, so
 * it's meant to run occasionally (e.g. once when a dev server starts),
 * not on every single build - unlike runBuffers()/runFetches(), its cost
 * doesn't shrink to near-zero when nothing changed.
 *
 * Two distinct problems, two different remedies:
 *   - A target row whose file *and* source are both gone is orphaned -
 *     pruneDeletions() already handles this in the normal case; this is
 *     the safety net for whenever that didn't run to completion. Deleted
 *     outright (queries.target.delete() cascades its own metadata/
 *     dependency rows via the existing DB trigger).
 *   - A target row whose file is missing but *should* exist (its source
 *     is still there, or it's synthetic) is a real inconsistency, not a
 *     deletion - silently dropping the row would be worse than leaving it
 *     broken. Marked stale instead, so a normal rebuild regenerates it.
 *
 * The other direction too: a file in the target folder that no
 * non-virtual target row claims is deleted. Rows-against-disk alone
 * can't do this - it only ever visits rows - and it is the half that
 * removes stranded output rather than just forgetting it. The database
 * and cache are skipped in case a config places them inside the target
 * folder.
 *
 * Also prunes dependency rows whose `dependent` doesn't match any known
 * target. The cleanup_target_rows trigger only deletes dependency edges
 * pointing *at* a deleted target (`target = OLD.path`) - it has no way to
 * also clean up edges *from* that target (where it was the dependent),
 * since by the time the trigger fires the row identifying what it used to
 * depend on is already gone. Those rows are harmless (a stale dependent
 * that no longer exists just no-ops if ever triggered) but accumulate
 * forever otherwise.
 *
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {CleanupSummary}
 */
function cleanupDatabase(config, database) {
  const targets = database.target.getAll()
  const knownPaths = new Set(targets.map(target => target.path))

  const prunedTargets = []
  const healedTargets = []

  for (const target of targets) {
    if (target.write === false) continue // virtual - no file is ever expected
    if (checkFile(path.join(config.targetFolder, target.path))) continue // present, as expected

    // target.source is relative to sourceFolder (like every path in the
    // database); resolved here, or it would be checked against cwd and
    // every target would look source-gone from any other directory.
    const sourceGone = target.source && !checkFile(path.join(config.sourceFolder, target.source))

    if (sourceGone) {
      database.target.delete(target.path)
      prunedTargets.push(target.path)
    } else {
      database.target.markStale(target.path)
      healedTargets.push(target.path)
    }
  }

  const prunedFiles = []
  const expectedFiles = new Set(targets.filter(target => target.write !== false).map(target => target.path))
  const outsideOutput = [config.databasePath, config.cacheDirectory].filter(Boolean).map(p => path.resolve(p))

  const entries = checkFile(config.targetFolder)
    ? readdirSync(config.targetFolder, { withFileTypes: true, recursive: true })
    : []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const absolutePath = path.join(entry.parentPath, entry.name)
    if (outsideOutput.some(p => absolutePath.startsWith(p))) continue
    const relativePath = path.relative(config.targetFolder, absolutePath)
    if (expectedFiles.has(relativePath)) continue

    rmSync(absolutePath, { force: true })
    prunedFiles.push(relativePath)
  }

  const prunedDependencies = []
  const deleteDependency = database.raw.prepare(
    `DELETE FROM dependencies WHERE target = ? AND property = ? AND dependent = ?`
  )

  for (const dependency of database.dependency.getAll()) {
    // Only 'target' dependents are target paths at all - 'folder'/
    // 'folder_recursive'/'url' dependencies key on something else
    // entirely and don't belong in this check.
    if (dependency.type !== "target") continue
    if (knownPaths.has(dependency.dependent)) continue

    deleteDependency.run(dependency.target, dependency.property, dependency.dependent)
    prunedDependencies.push(`${dependency.target}:${dependency.property} -> ${dependency.dependent}`)
  }

  if (config.verbose && (prunedTargets.length || healedTargets.length || prunedFiles.length || prunedDependencies.length)) {
    console.info(
      `cleanup: pruned ${prunedTargets.length} orphaned target(s), ` +
      `healed ${healedTargets.length} missing-but-expected target(s), ` +
      `deleted ${prunedFiles.length} unclaimed file(s), ` +
      `pruned ${prunedDependencies.length} orphaned dependency row(s)`
    )
  }

  return { prunedTargets, healedTargets, prunedFiles, prunedDependencies }
}

export default cleanupDatabase
