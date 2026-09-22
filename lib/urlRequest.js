import { hash } from "node:crypto"

/**
 * What a plugin asked for through `api.url()`, normalised.
 *
 * A url is asked for as a string or as a `Request` (votive `d…`). The
 * two need the same thing of the store - one row per *distinct request* -
 * so both become this shape, and `key` is the identity every row, edge
 * and file is stored under.
 *
 * The key is the bare url for an ordinary GET, so nothing that existed
 * before this changes key or filename. Anything else carries what makes
 * it different: the method, and a digest of the body when there is one.
 * Two records POSTed to one endpoint are two entries; the same record
 * asked for twice is one, on this build and the next.
 *
 * @typedef {object} UrlRequest
 * @property {string} key - "https://a.test/x", "POST https://a.test/x #3f9a2c1d"
 * @property {string} url - the url to fetch
 * @property {string} method
 * @property {[string, string][]} [headers]
 * @property {string} [body]
 */

/** Eight hex characters of SHA-256, the same digest length the store's filenames use. */
const digest = (value) => hash("sha256", value).slice(0, 8)

/**
 * @param {{ url: string, method?: string, body?: string }} parts
 * @returns {string}
 */
function requestKey({ url, method = "GET", body }) {
  const verb = method.toUpperCase()
  if (verb === "GET" && body === undefined) return url
  return `${verb} ${url}${body === undefined ? "" : ` #${digest(body)}`}`
}

/** Anything with a url and a method: a `Request`, or a plain object shaped like one. */
function isRequestLike(input) {
  return Boolean(input) && typeof input === "object" && typeof input.url === "string" && typeof input.method === "string"
}

/**
 * A `Request` as a UrlRequest. Async because a body is a stream that can
 * be read once: it is read here, at ask time, and the fetch builds a
 * fresh request from the stored parts. The clone is what leaves the
 * caller's own request usable.
 * @param {Request} request
 * @returns {Promise<UrlRequest>}
 */
async function fromRequest(request) {
  const method = request.method.toUpperCase()
  const body = request.body ? await request.clone().text() : undefined
  const headers = [...request.headers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const parts = {
    url: request.url,
    method,
    ...(headers.length ? { headers } : {}),
    ...(body === undefined ? {} : { body })
  }
  return { key: requestKey(parts), ...parts }
}

/**
 * A string as a UrlRequest.
 * @param {string} url
 * @returns {UrlRequest}
 */
function fromURL(url) {
  return { key: url, url, method: "GET" }
}

export { requestKey, isRequestLike, fromRequest, fromURL }
