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
  return Object.freeze({
    /**
     * A single target, read-tracked against `dependent`.
     * @param {string} filePath
     */
    target(filePath) {
      return database.target.getWithTrackers(filePath, dependent)
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
        return database.url.create(url, data, dependent, options)
      }
    }
  })
}

export default createPluginAPI
