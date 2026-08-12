import test from "node:test"
import assert from "node:assert/strict"
import metadata, {
  parseOpenGraphTags,
  parseTwitterCardTags,
  parseCanonicalLink,
  parseOEmbedLink
} from "../lib/urlMetadata.js"

const html = `
  <html><head>
    <meta property="og:title" content="Hello &amp; World" />
    <meta property='og:image' content='https://example.com/a.png'>
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="description" content="not a card, ignored" />
    <link rel="canonical" href="https://example.com/page" />
    <link rel="stylesheet" href="https://example.com/ignored.css" />
    <link type="application/json+oembed" href="https://example.com/oembed.json" />
  </head></html>
`

test("urlMetadata: parseOpenGraphTags", () => {
  assert.deepEqual(parseOpenGraphTags(html), {
    title: "Hello & World",
    image: "https://example.com/a.png"
  })
})

test("urlMetadata: parseTwitterCardTags ignores non-twitter meta tags", () => {
  assert.deepEqual(parseTwitterCardTags(html), { card: "summary_large_image" })
})

test("urlMetadata: parseCanonicalLink ignores non-canonical link tags", () => {
  assert.equal(parseCanonicalLink(html), "https://example.com/page")
})

test("urlMetadata: parseCanonicalLink returns undefined when absent", () => {
  assert.equal(parseCanonicalLink("<html></html>"), undefined)
})

test("urlMetadata: parseOEmbedLink finds the discovery URL", () => {
  assert.equal(parseOEmbedLink(html), "https://example.com/oembed.json")
})

test("urlMetadata: metadata() combines all four parsers", () => {
  assert.deepEqual(metadata(html), {
    openGraph: { title: "Hello & World", image: "https://example.com/a.png" },
    twitterCard: { card: "summary_large_image" },
    canonical: "https://example.com/page",
    oembedURL: "https://example.com/oembed.json"
  })
})
