import { isRequestLike, fromRequest, fromURL } from "./urlRequest.js"

/** @import {Database} from "./createDatabase.js" */
/** @import {TargetGetByFolderParams, TargetInput} from "./createDatabase.js" */

/**
 * The restricted database surface handed to plugin callbacks in place
 * of the full `database` object - a plugin gets read access to targets
 * and URLs, pre-loaded with `dependent` (the target currently being
 * processed) so a plugin author never has to think about dependency
 * tracking or staleness themselves.
 *
 * Reads only. A plugin produces targets by being a processor for a
 * source - a file, or a stub it declared - never as a side effect of
 * reading something else. That is what makes "source gone, target gone"
 * the one deletion rule.
 * @param {Database} database
 * @param {string} dependent
 * @param {{ readURL?: Function } | undefined} [processor] - the processor
 *   whose hook is running; its readURL is what a url() request will be
 *   parsed by
 */
function createPluginAPI(database, dependent, processor) {
  /**
   * The store lookup, once a request is normalised: its data if it has
   * been fetched, otherwise a queued fetch and undefined. Tracked
   * either way, so the target depends on it.
   * @param {import("./urlRequest.js").UrlRequest} request
   */
  function ask(request) {
    const cached = database.url.get(request.key)
    if (cached !== undefined) {
      database.url.track(request.key, dependent)
      return cached
    }
    // Queued regardless of who is asking: which `format: "url"`
    // processor parses the response is decided by the response when the
    // fetch runs, not by the asker.
    database.url.request(request, dependent)
    return undefined
  }

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

    /**
     * Removed. Loud rather than "not a function", because the plugin
     * that calls it is one whose pages would otherwise silently never
     * appear.
     */
    createTarget() {
      throw new Error("api.createTarget() no longer exists. A target has one owner: return it from the owner's readFile as one of its `targets`, or - when nothing owns it - declare it as a stub (createStubs/expandStubs).")
    },

    /**
     * The data a url was fetched and parsed into, if it has been. If
     * not, undefined - and a fetch is queued for the build's deferred
     * pass, parsed by whichever `format: "url"` processor claims the
     * url's extension and written to the URL store, after which the
     * target this api belongs to is marked stale and its hook runs again
     * with the data there. Either way the target now depends on the url.
     * A url in its failure cooldown is neither returned nor re-queued.
     *
     * **A `Request` may be given instead of a string**, for a POST or
     * any request that is more than a url (votive `d…`). Everything
     * above holds; the difference is the return, and why:
     *
     * - `api.url(string)` answers **synchronously**, as it always has.
     * - `api.url(request)` answers with a **promise**, because a
     *   `Request`'s body is a stream that can be read once and the
     *   store's identity for it includes a digest of that body (see
     *   urlRequest.js). It is read here, at ask time; the deferred
     *   fetch builds a fresh request from the parts. `await` it - a
     *   hook may be async - and the caller's own request stays usable.
     *
     * One row per distinct request: two records POSTed to one endpoint
     * are two entries, the same request asked for twice is one. An
     * ordinary GET keys on the bare url, so nothing that existed
     * before this changed.
     * @param {string | Request} input
     * @returns {unknown | Promise<unknown>}
     */
    url(input) {
      if (isRequestLike(input)) return fromRequest(input).then(ask)
      return ask(fromURL(input))
    }
  })
}

export default createPluginAPI
