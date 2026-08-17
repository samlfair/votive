/** @import {Database} from "./createDatabase.js" */
/** @import {TargetGetByFolderParams, TargetInput, DependencyRecorder} from "./createDatabase.js" */

/**
 * The restricted database surface handed to plugin callbacks in place of
 * the full `database` object - read access to targets and URLs, plus
 * target creation.
 *
 * Dependency tracking is deferred, not immediate. A callback like
 * readFile() can override its own target path by returning `filePath`
 * (see readSources.js/readBuffers.js), and that override isn't known
 * until the callback returns - so target()/targets()/url.create() calls
 * made *during* the callback can't yet know who the real "dependent" is.
 * Rather than write dependency edges against a path that might turn out
 * to be wrong, every call here just *records* what it read (or wants to
 * link), via the same lazy per-property getters as before - reading
 * `.abstract` records an abstract-read, reading nothing records nothing.
 * `flush(dependent)` runs every recorded action for real, once the
 * caller (readSources.js/readBuffers.js/readAbstracts.js/readFolders.js/
 * writeTargets.js) knows the actual final path - which, for anything
 * without an override mechanism, is just the path it already had.
 * @param {Database} database
 */
function createPluginAPI(database) {
  /** @type {((dependent: string) => void)[]} */
  const pending = []

  /** @type {DependencyRecorder} */
  function record(action) {
    pending.push(action)
  }

  return Object.freeze({
    /**
     * A single target. Reading a property off the result (e.g.
     * `.abstract`) records a dependency on it, flushed by flush().
     * @param {string} filePath
     */
    target(filePath) {
      return database.target.getWithTrackers(filePath, record)
    },

    /**
     * Targets in a folder. Same per-property recording as target(),
     * plus a folder-membership record (a target appearing/disappearing
     * has no property to have read, so it's recorded unconditionally).
     * @param {TargetGetByFolderParams} [params]
     */
    targets(params = {}) {
      return database.target.getByFolder({ ...params, dependent: record })
    },

    /** @param {TargetInput} target */
    createTarget(target) {
      return database.target.create(target)
    },

    url: {
      /** @param {string} url */
      get(url) {
        return database.url.get(url)
      },

      /**
       * The URL is fetched/cached immediately regardless of the
       * eventual dependent (nothing about storing it depends on who's
       * asking) - only linking it to a dependent (and marking that
       * dependent stale) is deferred.
       * @param {string} url
       * @param {any} data
       * @param {{ redirect?: string, canonical?: string }} [options]
       */
      create(url, data, options) {
        database.url.create(url, data, null, options)
        record(dependent => database.url.linkDependent(url, dependent))
      }
    },

    /**
     * Runs every recorded dependency action for real, now that the
     * final dependent is known. Called once, by whichever votive module
     * created this API, right after the callback it was passed to has
     * returned.
     * @param {string} dependent
     */
    flush(dependent) {
      pending.forEach(action => action(dependent))
    }
  })
}

export default createPluginAPI
