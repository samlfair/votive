import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import YAML from "yaml"
import createDatabase from "../lib/createDatabase.js"
import fetchURLs, { shouldSkip, processorFor } from "../lib/fetchURLs.js"
import { hostSlug } from "../lib/urlStore.js"

/** @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler */
async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  return { baseUrl, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

/** A temp project with a url store, torn down after `run`. */
async function withProject(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-fetch-"))
  const config = { sourceFolder, urlStore: "links", urlHostInterval: 0, log: () => {} }
  try {
    await run(config)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/**
 * A `format: "url"` processor for extension-less urls whose readURL
 * files the result under the host and records whatever `parse` makes of
 * the response.
 */
function urlProcessor(parse, extensions = [""]) {
  return {
    plugin: { name: "test-url-plugin" },
    processor: {
      format: "url",
      extensions,
      readURL: async (response) => ({ path: `${hostSlug(response.url)}${response.url.pathname}`, data: await parse(response) })
    }
  }
}

/** The entry a fetch wrote, parsed. */
async function writtenEntry(config, relativePath) {
  return YAML.parse(await readFile(path.join(config.sourceFolder, relativePath), "utf-8"))
}

test("fetchURLs: dispatch is by the url's extension, to a format:'url' processor", async (t) => {
  await t.test("a url with no matching processor is not fetched, and runFetches() reports nothing done", async () => {
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => { requests++; res.writeHead(200); res.end() })

    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/page`, "post.html")

        // The only processor handles .mp3; this url has no extension.
        const { attempted } = await fetchURLs(config, database, [urlProcessor(() => ({}), [".mp3"])]).runFetches()

        assert.equal(attempted, 0)
        assert.equal(requests, 0)
        // The dependency is still recorded: adding a processor for ""
        // later restales the page.
        assert.equal(database.dependency.getAllByTarget(`${baseUrl}/page`).length, 1)
      })
    } finally {
      await close()
    }
  })

  await t.test("'' matches an extension-less url and nothing else; there is no wildcard", () => {
    const empty = urlProcessor(() => ({}), [""])
    const mp3 = urlProcessor(() => ({}), [".mp3"])
    const both = [empty, mp3]
    assert.equal(processorFor(both, "https://a.com/page"), empty.processor)
    assert.equal(processorFor(both, "https://a.com/"), empty.processor)
    assert.equal(processorFor(both, "https://a.com/song.mp3"), mp3.processor)
    assert.equal(processorFor(both, "https://a.com/cal.ical"), undefined)
    assert.equal(processorFor([mp3], "https://a.com/page"), undefined)
  })

  await t.test("does not fetch until runFetches() is called, then files what the processor returned", async () => {
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => {
      requests++
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end("raw-bytes")
    })

    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/asset`, "post.html")
        assert.equal(requests, 0)

        const { runFetches } = fetchURLs(config, database, [urlProcessor(async r => ({ text: await r.text() }))])
        assert.equal(requests, 0, "constructing the runner fetches nothing")

        const { attempted, written } = await runFetches()
        assert.equal(attempted, 1)
        assert.equal(requests, 1)

        // Nothing lands in the index from the fetch itself: the file is
        // the truth, and the follow-up build reads it.
        assert.equal(database.url.get(`${baseUrl}/asset`), undefined)
        assert.equal(written.length, 1)
        assert.match(written[0], /^links\/127\.0\.0\.1_\d+\/asset-[0-9a-f]{8}\.yaml$/)
        const entry = await writtenEntry(config, written[0])
        assert.equal(entry.url, `${baseUrl}/asset`)
        assert.deepEqual(entry.data, { text: "raw-bytes" })
        assert.match(entry.fetched, /^\d{4}-/)
      })
    } finally {
      await close()
    }
  })

  await t.test("a redirect is recorded in the file, and a returned url becomes the canonical", async () => {
    const { baseUrl, close } = await withServer((req, res) => {
      if (req.url === "/old") { res.writeHead(302, { location: "/new" }); res.end(); return }
      res.writeHead(200); res.end("moved")
    })

    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/old`, "post.html")
        const processors = [{
          plugin: { name: "t" },
          processor: {
            format: "url", extensions: [""],
            readURL: async (r) => ({ path: "h/old", url: "https://canonical.example/x", data: { body: await r.text() } })
          }
        }]
        const { written } = await fetchURLs(config, database, processors).runFetches()
        const entry = await writtenEntry(config, written[0])
        assert.equal(entry.url, `${baseUrl}/old`, "the requested url stays the key")
        assert.equal(entry.redirect, `${baseUrl}/new`)
        assert.equal(entry.canonical, "https://canonical.example/x")

        // And once read into the index, any of the three finds it.
        database.url.accumulate(entry, written[0])
        assert.deepEqual(database.url.get(`${baseUrl}/old`), { body: "moved" })
        assert.deepEqual(database.url.get(`${baseUrl}/new`), { body: "moved" })
        assert.deepEqual(database.url.get("https://canonical.example/x"), { body: "moved" })
      })
    } finally {
      await close()
    }
  })

  await t.test("a readURL returning no path is an error naming the url, and nothing is written", async () => {
    const { baseUrl, close } = await withServer((req, res) => { res.writeHead(200); res.end("x") })
    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/p`, "post.html")
        const errors = []
        const original = console.error
        console.error = (e) => errors.push(String(e))
        try {
          const processors = [{ plugin: { name: "t" }, processor: { format: "url", extensions: [""], readURL: () => ({ data: 1 }) } }]
          const { written } = await fetchURLs(config, database, processors).runFetches()
          assert.deepEqual(written, [])
          assert.match(errors.join("\n"), new RegExp(`${baseUrl.replaceAll(".", "\\.")}/p`))
        } finally {
          console.error = original
        }
      })
    } finally {
      await close()
    }
  })

  await t.test("a non-2xx response records a failure, not a success", async () => {
    const { baseUrl, close } = await withServer((req, res) => { res.writeHead(404); res.end() })
    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/missing`, "post.html")
        const { written } = await fetchURLs(config, database, [urlProcessor(() => ({}))]).runFetches()
        assert.deepEqual(written, [])
        const status = database.url.getStatus(`${baseUrl}/missing`)
        assert.equal(status.failureCount, 1)
        assert.equal(status.data, null)
      })
    } finally {
      await close()
    }
  })

  await t.test("a failed URL within its cooldown window is not retried", async () => {
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => { requests++; res.writeHead(500); res.end() })
    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        const url = `${baseUrl}/flaky`
        const processors = [urlProcessor(() => ({}))]

        database.url.request(url, "post.html")
        await fetchURLs(config, database, processors).runFetches()
        assert.equal(requests, 1)

        database.url.request(url, "post.html")
        const { attempted } = await fetchURLs(config, database, processors).runFetches()
        assert.equal(attempted, 0)
        assert.equal(requests, 1, "inside the cooldown, no second request")
      })
    } finally {
      await close()
    }
  })

  await t.test("a slow response past the configured timeout records a failure", async () => {
    const { baseUrl, close } = await withServer((req, res) => setTimeout(() => { res.writeHead(200); res.end() }, 300))
    try {
      await withProject(async (config) => {
        const database = createDatabase(":memory:")
        database.url.request(`${baseUrl}/slow`, "post.html")
        await fetchURLs({ ...config, urlFetchTimeout: 50 }, database, [urlProcessor(() => ({}))]).runFetches()
        assert.equal(database.url.getStatus(`${baseUrl}/slow`).failureCount, 1)
      })
    } finally {
      await close()
    }
  })

  await t.test("exponential cooldown: 1/2/4 day schedule, capped at 8 days", () => {
    const database = createDatabase(":memory:")
    const url = "https://example.com/cooling-down"
    const day = 24 * 60 * 60 * 1000

    database.url.recordFailure(url, Date.now() - 12 * 60 * 60 * 1000) // failureCount=1 -> 1 day cooldown
    assert.equal(shouldSkip(database.url.getStatus(url)), true) // 12h < 1 day

    database.url.recordFailure(url, Date.now() - 25 * 60 * 60 * 1000) // failureCount=2 -> 2 day cooldown
    assert.equal(shouldSkip(database.url.getStatus(url)), true) // 25h < 2 days

    for (let i = 0; i < 8; i++) database.url.recordFailure(url, Date.now())
    assert.equal(database.url.getStatus(url).failureCount, 10)

    database.url.recordFailure(url, Date.now() - 7 * day)
    assert.equal(shouldSkip(database.url.getStatus(url)), true) // 7 days < 8-day cap

    database.url.recordFailure(url, Date.now() - 9 * day)
    assert.equal(shouldSkip(database.url.getStatus(url)), false) // 9 days > 8-day cap
  })
})
