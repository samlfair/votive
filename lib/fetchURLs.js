/** @import {Database, VotiveConfig, FlatProcessors} from "./bundle.js" */
import pLimit from "p-limit"
import createPluginAPI from "./pluginAPI.js"
import { entryPath, writeEntry, urlExtension } from "./urlStore.js"

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
 * @property {string} key - what the store records it under
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
 * The fetch a UrlRequest describes. Its own headers win over the
 * User-Agent default, and a body is sent with the method it was asked
 * with - the request is rebuilt here from the stored parts, since the
 * caller's `Request` body was read at ask time (urlRequest.js).
 * @param {import("./urlRequest.js").UrlRequest} request
 * @param {VotiveConfig} config
 */
function fetchWithDefaults(request, config) {
  const headers = new Headers(request.headers ?? [])
  if (!headers.has("user-agent")) headers.set("user-agent", userAgentFor(config))
  return fetch(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    signal: AbortSignal.timeout(timeoutFor(config))
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
 * @param {import("./urlRequest.js").UrlRequest} request
 * @param {FlatProcessors} processors
 * @param {VotiveConfig} config
 * @param {Database} database
 * @returns {PendingFetch}
 */
function buildPendingFetch(request, processors, config, database) {
  const log = config.log || (() => {})
  // Everything the store does - the row, the cooldown, the filename -
  // keys on the request's identity; everything the network does uses
  // the url. They are the same string for an ordinary GET.
  const key = request.key
  return {
    key,
    url: request.url,
    /** @returns {Promise<undefined | { retryAfter: number } | { written: string }>} */
    async run() {
      let response

      try {
        response = await fetchWithDefaults(request, config)
      } catch (e) {
        database.url.recordFailure(key)
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
        database.url.recordFailure(key)
        return
      }

      // Which processor, decided by what came back. No claimant: the
      // body is dropped unread, and a failure is recorded so the url is
      // not fetched again on every build - it is a failure to produce
      // data, and the cooldown is what bounds the retries. Said out loud,
      // because "no preview, no message" is how this was first noticed.
      const processor = processorFor(processors, request.url, response)
      if (!processor) {
        const what = mediaTypeOf(response) ?? `extension ${JSON.stringify(urlExtension(request.url))}`
        log("warn", `no url processor for ${what}: ${key}`)
        await response.body?.cancel().catch(() => {})
        database.url.recordFailure(key)
        return
      }
      const api = createPluginAPI(database, "", processor)

      const redirect = redirectFor(response, request.url)

      try {
        // The body methods are lazy, so a plugin that only reads headers
        // never reads the body - that boundary used to be a `runner` name
        // on the task, chosen before anyone had seen the response.
        // `url` is a URL instance: protocol, host, pathname and
        // searchParams are there for a processor deciding where to file
        // the result. String(response.url) is the requested url.
        const responseInput = {
          url: new URL(request.url),
          status: response.status,
          redirect,
          text: () => response.text(),
          json: () => response.json(),
          arrayBuffer: () => response.arrayBuffer()
        }

        const result = await processor.readURL(responseInput, { api, settings: undefined, config })

        // { path, url?, data }. `path` is where the file goes, relative
        // to the store and without an extension; votive appends the
        // tiebreaker and the extension. `url`, if given and different,
        // is the canonical url - the requested one stays the key, since
        // it is what pages ask for, and lookups match either.
        if (!result || typeof result !== "object") {
          throw new Error(`readURL for ${request.url} returned nothing; it must return { path, data }.`)
        }
        // The tiebreaker is over the *key*, so two records POSTed to one
        // endpoint are two files rather than one overwriting the other.
        const relativePath = entryPath(config, result.path, key)
        const canonical = typeof result.url === "string" && result.url !== request.url ? result.url : undefined

        // Nothing goes into the index here. The file is the truth, and
        // the follow-up build reads it back through readSources like any
        // edited source - which is the same moment the data used to
        // reach the page, one build after the fetch.
        // `url` in the file is the identity - the bare url for a GET,
        // "POST <url> #<digest>" otherwise - because that is what a page
        // asks for and what the row is keyed on. The method and url are
        // legible in it.
        await writeEntry(config, relativePath, {
          url: key,
          redirect,
          canonical,
          fetched: new Date().toISOString(),
          data: result.data ?? null
        })
        return { written: relativePath }
      } catch (e) {
        console.error(e)
        database.url.recordFailure(key)
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
/**
 * The media type a response says it is - "text/html" from
 * "text/html; charset=utf-8" - or undefined when it says nothing useful.
 * application/octet-stream is "bytes", which is not a kind of thing.
 * @param {Response} response
 */
function mediaTypeOf(response) {
  const header = response.headers.get("content-type")
  if (!header) return undefined
  const type = header.split(";")[0].trim().toLowerCase()
  return type && type !== "application/octet-stream" ? type : undefined
}

/**
 * The `format: "url"` processor for a fetched url.
 *
 * Dispatched on the **response**, not the url: what the server says the
 * resource is (`mediaTypes`), falling back to the url's pathname
 * extension (`extensions`) only when the response has no usable type. A
 * url path is not a file path - `/profile/littlefair.ca` ends in ".ca"
 * and is an html page - so the extension alone was the wrong key, and
 * votive fetches before parsing anyway, so the response is there to ask.
 *
 * Exact matches only, and one claimant per type or extension: two
 * processors claiming "text/html" is an error naming both, like two
 * processors declaring one stub. There is no fallback handler.
 * @param {FlatProcessors} processors
 * @param {string} url
 * @param {Response} response
 */
function processorFor(processors, url, response) {
  const urlProcessors = processors.filter(({ processor }) => processor.format === "url")

  const claimants = (key, field) => urlProcessors.filter(({ processor }) => (
    Array.isArray(processor[field]) && processor[field].includes(key)
  ))

  const type = mediaTypeOf(response)
  let matches = type ? claimants(type, "mediaTypes") : []
  let key = type

  if (!matches.length) {
    key = urlExtension(url)
    matches = claimants(key, "extensions")
  }

  if (matches.length > 1) {
    const names = matches.map(({ plugin }) => `"${plugin.name}"`).join(" and ")
    throw new Error(`Two url processors claim ${JSON.stringify(key)}: ${names}. A url is parsed by exactly one.`)
  }

  return matches[0]?.processor
}

/**
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 */
function fetchURLs(config, database, processors = []) {
  const log = config.log || (() => {})
  const concurrency = config.urlConcurrency || DEFAULT_CONCURRENCY
  const hostInterval = config.urlHostInterval ?? DEFAULT_HOST_INTERVAL_MS

  async function runFetches() {
    const requested = database.url.takePending()

    const pending = []
    for (const request of requested) {
      if (!isFetchable(request.url)) {
        log("warn", `not fetching ${request.key}: only http and https are fetched`)
        continue
      }
      if (shouldSkip(database.url.getStatus(request.key))) continue

      // Nothing is fetched unless some url processor exists at all; which
      // one is decided by the response (see processorFor).
      if (!processors.some(({ processor }) => processor.format === "url")) {
        log("warn", `no url processors are registered; not fetching ${request.key}`)
        continue
      }

      pending.push({ request, task: buildPendingFetch(request, processors, config, database) })
    }

    if (!pending.length) return { attempted: 0, written: [] }

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
    const written = []

    await Promise.all([...byHost].map(async ([host, queue]) => {
      for (const [index, { request, task }] of queue.entries()) {
        const pausedUntil = hostPausedUntil.get(host) ?? 0
        if (Date.now() < pausedUntil) {
          // Not this pass. Back into the queue for the next one, with
          // the dependency edges it already has. The whole record, so a
          // request with a body is re-sent as itself.
          database.url.request(request, "")
          continue
        }

        attempted++
        const outcome = await limit(() => task.run())

        if (outcome && outcome.retryAfter !== undefined) {
          hostPausedUntil.set(host, Date.now() + outcome.retryAfter)
          log("warn", `${host} asked for a pause of ${Math.round(outcome.retryAfter / 1000)}s; its remaining urls wait for the next pass`)
          // Safe for a POST too: 429 and 503 mean the request was not
          // processed, so re-sending it is not a second write.
          database.url.request(request, "")
          continue
        }

        if (outcome && outcome.written) written.push(outcome.written)

        if (index < queue.length - 1 && hostInterval > 0) {
          await new Promise(resolve => setTimeout(resolve, hostInterval))
        }
      }
    }))

    // The follow-up build is scoped to the files just written, so they
    // are read - and their pages restaled and rewritten - in one pass.
    return { attempted, written }
  }

  return { runFetches }
}

export default fetchURLs
export { shouldSkip, isFetchable, retryAfterMs, processorFor, mediaTypeOf, FETCHABLE_SCHEMES }
