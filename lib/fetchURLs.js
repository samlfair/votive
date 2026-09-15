/** @import {Database, VotiveConfig} from "./bundle.js" */
import pLimit from "p-limit"
import createPluginAPI from "./pluginAPI.js"
import { saveEntry } from "./urlStore.js"

const DEFAULT_USER_AGENT = "VotiveBot/1.0"
const DEFAULT_TIMEOUT_MS = 10_000

/** How many fetches may be in flight at once, across every host. */
const DEFAULT_CONCURRENCY = 5

/**
 * The gap between two requests to the same host. Requests to one host are
 * always sequential; this is the pause between them. Half a second is
 * ordinary crawler politeness - a site with three hundred links to one
 * blog fetches them over a couple of minutes instead of in one burst.
 */
const DEFAULT_HOST_INTERVAL_MS = 500

/**
 * The only schemes votive fetches. Anything else - mailto:, at:, tel: -
 * is neither queued nor recorded as a failure, because fetch() would
 * throw and the failure cooldown would then retry it forever at a
 * slowing rate. A future scheme needs its own fetcher, and this set is
 * where it would be declared.
 */
const FETCHABLE_SCHEMES = new Set(["http:", "https:"])

/** @param {string} url */
function isFetchable(url) {
  try {
    return FETCHABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/**
 * Hosts that answered 429 or 503 with a Retry-After, and when they may be
 * asked again. Process-lifetime: a pause is a courtesy to the other side
 * for the next few seconds or minutes, not state worth persisting.
 * @type {Map<string, number>}
 */
const hostPausedUntil = new Map()

/**
 * Parses a Retry-After header - seconds, or an HTTP date - into a
 * duration in milliseconds. Undefined when absent or unparseable.
 * @param {Response} response
 */
function retryAfterMs(response) {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined
}

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

      // Rate limited, or told to come back later. Not a failure of the
      // URL - the other side is asking for a pause - so no cooldown is
      // recorded. The host is paused instead, and the caller re-queues
      // whatever was still waiting for it.
      if (response.status === 429 || response.status === 503) {
        const pause = retryAfterMs(response)
        if (pause !== undefined) return { retryAfter: pause }
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

        // Write-through to the store, which is the durable copy: the row
        // just written is an index of this. See urlStore.js.
        await saveEntry(config, request.url, {
          fetched: new Date().toISOString(),
          ...(redirect ? { redirect } : {}),
          data: parsed
        })
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
  const log = config.log || (() => {})
  const concurrency = config.urlConcurrency || DEFAULT_CONCURRENCY
  const hostInterval = config.urlHostInterval ?? DEFAULT_HOST_INTERVAL_MS

  async function runFetches() {
    const requested = database.url.takePending()

    const fetchable = requested.filter(({ url }) => {
      if (isFetchable(url)) return true
      log("warn", `not fetching ${url}: only http and https are fetched`)
      return false
    })

    const pending = fetchable
      .filter(({ url }) => !shouldSkip(database.url.getStatus(url)))
      .map(({ url, processor }) => {
        const api = createPluginAPI(database, "", processor)
        return { processor, task: buildPendingFetch({ url }, processor, config, database, api) }
      })

    if (!pending.length) return 0

    /*
      Two limits, one inside the other. The global limit bounds how much
      is in flight at all. Within it, every host gets its own queue,
      drained one request at a time with a pause between - a site with
      hundreds of links to one blog used to open hundreds of connections
      to it at once, which is the behaviour a well-run host blocks. The
      host queues run concurrently with each other, so many hosts still
      fetch quickly; only requests to the *same* host wait on each other.
    */
    const limit = pLimit(concurrency)
    const byHost = Map.groupBy(pending, ({ task }) => new URL(task.url).host)

    let attempted = 0

    await Promise.all([...byHost].map(async ([host, queue]) => {
      for (const [index, { task, processor }] of queue.entries()) {
        const pausedUntil = hostPausedUntil.get(host) ?? 0
        if (Date.now() < pausedUntil) {
          // Not this pass. Back into the queue for the next one, with
          // the dependency edges it already has.
          database.url.request(task.url, "", processor)
          continue
        }

        attempted++
        const outcome = await limit(() => task.run())

        if (outcome && outcome.retryAfter !== undefined) {
          hostPausedUntil.set(host, Date.now() + outcome.retryAfter)
          log("warn", `${host} asked for a pause of ${Math.round(outcome.retryAfter / 1000)}s; its remaining urls wait for the next pass`)
          database.url.request(task.url, "", processor)
          continue
        }

        if (index < queue.length - 1 && hostInterval > 0) {
          await new Promise(resolve => setTimeout(resolve, hostInterval))
        }
      }
    }))

    return attempted
  }

  return { runFetches }
}

export default fetchURLs
export { shouldSkip, isFetchable, retryAfterMs, FETCHABLE_SCHEMES }
