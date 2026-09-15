/** @import {Database} from "./createDatabase.js" */
/** @import {TargetGetByFolderParams, TargetInput} from "./createDatabase.js" */

/**
 * The restricted database surface handed to plugin callbacks in place
 * of the full `database` object - a plugin gets read access to targets
 * and URLs, plus target creation, all pre-loaded with `dependent` (the
 * target currently being processed) so a plugin author never has to
 * think about dependency tracking or staleness themselves.
 * @param {Database} database
 * @param {string} dependent
 * @param {{ readURL?: Function } | undefined} [processor] - the processor
 *   whose hook is running; its readURL is what a url() request will be
 *   parsed by
 */
function createPluginAPI(database, dependent, processor) {
  return Object.freeze({
    /**
     * A single target, read-tracked against `dependent`.
     * @param {string} filePath
     */
    target(filePath) {
      const target = database.target.getWithTrackers(filePath, dependent)
      return target
    },

    /**
     * @param {string} sourcePath
     */
    targetBySource(sourcePath) {
      const target = database.target.getWithTrackers(sourcePath, dependent, "source")
      return target
    },

    /**
     * Targets in a folder, read-tracked against `dependent`.
     * @param {TargetGetByFolderParams} [params]
     */
    targets(params = {}) {
      return database.target.getByFolder({ ...params, dependent })
    },

    /** @param {TargetInput} target */
    createTarget(target) {
      return database.target.create(target)
    },

    /**
     * The data a url was fetched and parsed into, if it has been. If
     * not, undefined - and a fetch is queued for the build's deferred
     * pass, parsed by whichever `format: "url"` processor claims the
     * url's extension and written to the URL store, after which the
     * target this api belongs to is marked stale and its hook runs again
     * with the data there. Either way the target now depends on the url.
     * A url in its failure cooldown is neither returned nor re-queued.
     * @param {string} url
     */
    url(url) {
      const cached = database.url.get(url)
      if (cached !== undefined) {
        database.url.track(url, dependent)
        return cached
      }
      // Queued regardless of who is asking: which `format: "url"`
      // processor parses the response is decided by the url's extension
      // when the fetch runs, not by the asker.
      database.url.request(url, dependent)
      return undefined
    }
  })
}

export default createPluginAPI
