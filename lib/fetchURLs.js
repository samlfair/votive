/** @import {UrlTasks, UrlTask, Database, VotiveConfig} from "./bundle.js" */

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
 * @param {UrlTask} task
 * @param {{ fetcher: Function, extensions: string[] }} processor
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {PendingFetch}
 */
function buildPendingFetch(task, processor, config, database) {
  return {
    url: task.data,
    target: task.target,
    extension: task.extension,
    async run() {
      let response

      try {
        response = await fetchWithDefaults(task.data, config)
      } catch (e) {
        database.url.recordFailure(task.data)
        return
      }

      if (response.status < 200 || response.status >= 300) {
        database.url.recordFailure(task.data)
        return
      }

      const redirect = redirectFor(response, task.data)

      try {
        const data = await response[task.runner]()
        const parsed = processor.fetcher(data)
        database.url.create(task.data, parsed, task.target, { redirect })
      } catch (e) {
        console.error(e)
        database.url.recordFailure(task.data)
      }
    }
  }
}

/**
 * Creates a queue of URLs to fetch for a given plugin without running
 * said fetches. Returns an array of promises containing the fetches and
 * a function to run them.
 * @param {UrlTasks} urls
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {Promise<{ pending?: PendingFetch[], runFetches: (() => Promise<void>) | null }>}
 */
async function fetchURLs(urls, config, database) {
  const processors = config.plugins.flatMap(plugin => plugin.processors
    ?.flatMap(processor => processor.readURL && { fetcher: processor.readURL, extensions: processor.extensions }))
    .filter(a => a)

    if(!processors) return {
      pending: [],
      runFetches: async () => {
        null
      }
    }

  /** @type {PendingFetch[]} */
  const pending = []

  for (const task of urls) {
    if (!task) continue

    const status = database.url.getStatus(task.data)
    if (shouldSkip(status)) continue

    const processor = processors.find(p => p.extensions.includes(task.extension))
    if (processor) pending.push(buildPendingFetch(task, processor, config, database))
  }

  if (!pending.length) return { runFetches: null }

  async function runFetches() {
    await Promise.allSettled(pending.map(task => task.run()))
  }

  return { pending, runFetches }
}

export default fetchURLs
export { shouldSkip }
