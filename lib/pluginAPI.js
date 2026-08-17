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
 */
function createPluginAPI(database, dependent) {
  // A plain closure variable, not the frozen object's own property -
  // Object.freeze() below only locks the object's shape (no new/
  // reassigned properties), it doesn't stop a method from reading a
  // variable it closes over that changes later. That's what makes
  // retarget() below work: every method here reads currentDependent
  // fresh on each call rather than capturing `dependent` by value.
  let currentDependent = dependent

  return Object.freeze({
    /**
     * A single target, read-tracked against the current dependent.
     * @param {string} filePath
     */
    target(filePath) {
      return database.target.getWithTrackers(filePath, currentDependent)
    },

    /**
     * Targets in a folder, read-tracked against the current dependent.
     * @param {TargetGetByFolderParams} [params]
     */
    targets(params = {}) {
      return database.target.getByFolder({ ...params, dependent: currentDependent })
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
       * @param {string} url
       * @param {any} data
       * @param {{ redirect?: string, canonical?: string }} [options]
       */
      create(url, data, options) {
        return database.url.create(url, data, currentDependent, options)
      }
    },

    /**
     * For a readFile() that's about to return a `filePath` override
     * (see readSources.js/readBuffers.js): call this as early as
     * possible - ideally before any other api. call - once the final
     * path is known, so target()/targets()/url.create() calls made
     * *after* it correctly attribute their dependency tracking to
     * where this content is actually landing, not the routed path it
     * started at. Calls already made before retarget() can't be fixed
     * retroactively - the override genuinely isn't knowable until the
     * plugin decides it, so there's no dependent to attribute them to
     * until this is called. This only affects tracking for the rest of
     * *this* readFile() call; it doesn't itself change where the
     * target ends up (that's still the returned `filePath`).
     * @param {string} filePath
     */
    retarget(filePath) {
      currentDependent = filePath
    }
  })
}

export default createPluginAPI
