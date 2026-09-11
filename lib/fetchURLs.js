/** @import {Database, VotiveConfig} from "./bundle.js" */
import createPluginAPI from "./pluginAPI.js"

const DEFAULT_USER_AGENT = "VotiveBot/1.0"
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * @typedef {object} PendingFetch
 * @property {string} url
 * @property {string} [target]
 * @property {string} extension
 * @property {() => Promise<void>} run
 */

/** @param {VotiveConfig} config */
function userAgentFor(config) {
  return (config && config.userAgent) || DEFAULT_USER_AGENT
}

/** @param {VotiveConfig} config */
function timeoutFor(config) {
  return (config && config.urlFetchTimeout) || DEFAULT_TIMEOUT_MS
}

/**
 * Checks whether a previously-failed URL should attempt another fetch.
 * Returns false for URLs that have already succeeded; false if the URL
 * has failed inside a cooldown period (one day times `2^(attempts - 1)`,
 * maximum 8).
 * @param {import("./createDatabase.js").SQLiteURL | undefined} status
 */
function shouldSkip(status) {
  if (!status) return false
  if (status.data) return true
  if (!status.failedAt) return false
  const cooldownDays = Math.min(2 ** (status.failureCount - 1), 8)
  return (Date.now() - status.failedAt) < cooldownDays * 24 * 60 * 60 * 1000
}

/**
 * @param {string} url
 * @param {VotiveConfig} config
 */
function fetchWithDefaults(url, config) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutFor(config)),
    headers: { "User-Agent": userAgentFor(config) }
  })
}

/**
 * Returns a redirect direct if one exists.
 * @param {Response} response
 * @param {string} requestedUrl
 */
function redirectFor(response, requestedUrl) {
  return response.url && response.url !== requestedUrl ? response.url : undefined
}

/**
 * Prepare a fetch request to run (without running it) and return
 * a promise containing the request.
 * @param {{ url: string }} request
 * @param {{ readURL: Function }} processor
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {PendingFetch}
 */
function buildPendingFetch(request, processor, config, database, api) {
  return {
    url: request.url,
    async run() {
      let response

      try {
        response = await fetchWithDefaults(request.url, config)
      } catch (e) {
        database.url.recordFailure(request.url)
        return
      }

      if (response.status < 200 || response.status >= 300) {
        database.url.recordFailure(request.url)
        return
      }

      const redirect = redirectFor(response, request.url)

      try {
        // The body methods are lazy, so a plugin that only reads headers
        // never reads the body - that boundary used to be a `runner` name
        // on the task, chosen before anyone had seen the response.
        const responseInput = {
          url: request.url,
          status: response.status,
          redirect,
          text: () => response.text(),
          json: () => response.json(),
          arrayBuffer: () => response.arrayBuffer()
        }

        const parsed = await processor.readURL(responseInput, { api, settings: undefined, config })
        database.url.create(request.url, parsed, { redirect })
      } catch (e) {
        console.error(e)
        database.url.recordFailure(request.url)
      }
    }
  }
}

/**
 * Deferred fetching of every url a hook asked for through api.url().
 * The queue is drained when runFetches() runs - after the whole pass,
 * writeFile included - not when this is called, so nothing is missed
 * by being asked for late. A url in its failure cooldown is skipped
 * (see shouldSkip). Returns the number of fetches attempted, so the
 * caller can skip the follow-up build when there were none.
 * @param {VotiveConfig} config
 * @param {Database} database
 */
function fetchURLs(config, database) {
  async function runFetches() {
    const pending = database.url.takePending()
      .filter(({ url }) => !shouldSkip(database.url.getStatus(url)))
      .map(({ url, processor }) => {
        const api = createPluginAPI(database, "", processor)
        return buildPendingFetch({ url }, processor, config, database, api)
      })

    await Promise.allSettled(pending.map(task => task.run()))
    return pending.length
  }

  return { runFetches }
}

export default fetchURLs
export { shouldSkip }
