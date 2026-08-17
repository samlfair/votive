import path from "node:path"
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
    if (target.write === 0) continue // virtual - no file is ever expected
    if (checkFile(path.join(config.targetFolder, target.path))) continue // present, as expected

    const sourceGone = target.source && !checkFile(target.source)

    if (sourceGone) {
      database.target.delete(target.path)
      prunedTargets.push(target.path)
    } else {
      database.target.markStale(target.path)
      healedTargets.push(target.path)
    }
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

  if (config.verbose && (prunedTargets.length || healedTargets.length || prunedDependencies.length)) {
    console.info(
      `cleanup: pruned ${prunedTargets.length} orphaned target(s), ` +
      `healed ${healedTargets.length} missing-but-expected target(s), ` +
      `pruned ${prunedDependencies.length} orphaned dependency row(s)`
    )
  }

  return { prunedTargets, healedTargets, prunedDependencies }
}

export default cleanupDatabase
