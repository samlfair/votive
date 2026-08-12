const META_TAG_RE = /<meta\s+[^>]*>/gi
const LINK_TAG_RE = /<link\s+[^>]*>/gi
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

/**
 * Decodes the handful of HTML entities that show up in meta/link
 * attribute values often enough to matter for title/description text.
 * Not a full entity table - just the five predefined XML entities.
 * @param {string} value
 */
function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
}

/**
 * Parses an HTML tag's attributes into a plain object, tolerant of
 * attribute order and single/double quoting.
 * @param {string} tag
 * @returns {Record<string, string>}
 */
function parseAttributes(tag) {
  const attrs = {}
  ATTR_RE.lastIndex = 0
  let match
  while ((match = ATTR_RE.exec(tag))) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? ""
  }
  return attrs
}

/**
 * @param {string} html
 * @param {string} prefix
 * @returns {Record<string, string>}
 */
function parseMetaTagsByPrefix(html, prefix) {
  const result = {}
  const tags = html.match(META_TAG_RE) || []
  for (const tag of tags) {
    const attrs = parseAttributes(tag)
    const key = attrs.property || attrs.name
    if (!key || !key.startsWith(prefix) || attrs.content === undefined) continue
    result[key.slice(prefix.length)] = decodeEntities(attrs.content)
  }
  return result
}

/**
 * Extracts OpenGraph metadata (`<meta property="og:*">`) from an HTML
 * string. Keys have the `og:` prefix stripped, e.g. `{ title, description,
 * image, url, type, ... }`.
 * @param {string} html
 * @returns {Record<string, string>}
 */
function parseOpenGraphTags(html) {
  return parseMetaTagsByPrefix(html, "og:")
}

/**
 * Extracts Twitter Card metadata (`<meta name="twitter:*">`) from an
 * HTML string. Keys have the `twitter:` prefix stripped.
 * @param {string} html
 * @returns {Record<string, string>}
 */
function parseTwitterCardTags(html) {
  return parseMetaTagsByPrefix(html, "twitter:")
}

/**
 * Returns a page's canonical URL (`<link rel="canonical">`), if present.
 * @param {string} html
 * @returns {string | undefined}
 */
function parseCanonicalLink(html) {
  const tags = html.match(LINK_TAG_RE) || []
  for (const tag of tags) {
    const attrs = parseAttributes(tag)
    if (attrs.rel?.toLowerCase() === "canonical" && attrs.href) return attrs.href
  }
  return undefined
}

/**
 * Returns a page's advertised oEmbed discovery URL
 * (`<link type="application/json+oembed">`), if present. Discovery only -
 * fetching this URL is the caller's responsibility, not this function's.
 * @param {string} html
 * @returns {string | undefined}
 */
function parseOEmbedLink(html) {
  const tags = html.match(LINK_TAG_RE) || []
  for (const tag of tags) {
    const attrs = parseAttributes(tag)
    if (attrs.type === "application/json+oembed" && attrs.href) return attrs.href
  }
  return undefined
}

/**
 * Convenience wrapper combining the four parsers above into one call, for
 * a plugin's `read.url` handler to run against fetched HTML.
 * @param {string} html
 * @returns {{ openGraph: Record<string, string>, twitterCard: Record<string, string>, canonical: string | undefined, oembedURL: string | undefined }}
 */
function metadata(html) {
  return {
    openGraph: parseOpenGraphTags(html),
    twitterCard: parseTwitterCardTags(html),
    canonical: parseCanonicalLink(html),
    oembedURL: parseOEmbedLink(html)
  }
}

export { parseOpenGraphTags, parseTwitterCardTags, parseCanonicalLink, parseOEmbedLink, metadata }
export default metadata
