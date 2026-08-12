import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import createDatabase from "../lib/createDatabase.js"
import fetchURLs, { shouldSkip } from "../lib/fetchURLs.js"

/** @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler */
async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    return { baseUrl, close: () => new Promise(resolve => server.close(resolve)) }
  } catch (e) {
    await new Promise(resolve => server.close(resolve))
    throw e
  }
}

function pluginConfigFor(fetcher) {
  return {
    plugins: [{
      name: "test-plugin",
      processors: [{ extensions: [".md"], read: { url: fetcher } }]
    }]
  }
}

test("fetchURLs: only jobs a plugin has claimed are fetched at all", async (t) => {
  await t.test("a job with no matching plugin is never fetched, returns runFetches: null", async () => {
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => {
      requests++
      res.writeHead(200)
      res.end()
    })

    try {
      const database = createDatabase(":memory:")
      const job = { data: `${baseUrl}/page`, runner: "text", extension: ".md" }
      const { pending, runFetches } = await fetchURLs([job], { plugins: [] }, database)

      assert.equal(requests, 0)
      assert.equal(pending, undefined)
      assert.equal(runFetches, null)
    } finally {
      await close()
    }
  })

  await t.test("does not fetch until runFetches() is called, then hands the plugin raw data", async () => {
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => {
      requests++
      res.writeHead(200, { "content-type": "application/octet-stream" })
      res.end("raw-bytes")
    })

    try {
      const database = createDatabase(":memory:")
      const job = { data: `${baseUrl}/asset`, runner: "text", destination: "post.html", extension: ".md" }
      const config = pluginConfigFor(data => ({ optimized: true, raw: data }))

      const { pending, runFetches } = await fetchURLs([job], config, database)

      assert.equal(requests, 0)
      assert.equal(pending.length, 1)
      assert.equal(database.url.get(job.data), undefined)

      await runFetches()

      assert.equal(requests, 1)
      assert.deepEqual(database.url.get(job.data), { optimized: true, raw: "raw-bytes" })

      const deps = database.dependency.getAllByTarget(job.data)
      assert.deepEqual(deps.map(d => ({ dependent: d.dependent, type: d.type })), [
        { dependent: "post.html", type: "url" }
      ])
    } finally {
      await close()
    }
  })

  await t.test("records the redirect target, findable via either URL", async () => {
    const { baseUrl, close } = await withServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: `${baseUrl}/end` })
        res.end()
      } else {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("landed")
      }
    })

    try {
      const database = createDatabase(":memory:")
      const job = { data: `${baseUrl}/start`, runner: "text", extension: ".md" }
      const config = pluginConfigFor(data => ({ body: data }))

      const { runFetches } = await fetchURLs([job], config, database)
      await runFetches()

      assert.deepEqual(database.url.get(`${baseUrl}/start`), { body: "landed" })
      assert.deepEqual(database.url.get(`${baseUrl}/end`), { body: "landed" })
    } finally {
      await close()
    }
  })

  await t.test("a non-2xx response records a failure, not a success", async () => {
    const { baseUrl, close } = await withServer((req, res) => {
      res.writeHead(404)
      res.end("not found")
    })

    try {
      const database = createDatabase(":memory:")
      const job = { data: `${baseUrl}/missing`, runner: "text", extension: ".md" }
      const config = pluginConfigFor(data => ({ body: data }))

      const { runFetches } = await fetchURLs([job], config, database)
      await runFetches()

      assert.equal(database.url.get(job.data), undefined)
      const status = database.url.getStatus(job.data)
      assert.equal(status.failureCount, 1)
      assert.ok(status.failedAt)
    } finally {
      await close()
    }
  })

  await t.test("a failed URL within its cooldown window is not retried", async () => {
    const database = createDatabase(":memory:")
    let requests = 0
    const { baseUrl, close } = await withServer((req, res) => {
      requests++
      res.writeHead(500)
      res.end()
    })

    try {
      const job = { data: `${baseUrl}/flaky`, runner: "text", extension: ".md" }
      const config = pluginConfigFor(data => ({ body: data }))

      const first = await fetchURLs([job], config, database)
      await first.runFetches()
      assert.equal(requests, 1)

      // failureCount is 1, so the cooldown is a full day - nowhere near
      // elapsed, so this job shouldn't even reach the pending list again.
      const second = await fetchURLs([job], config, database)
      assert.equal(second.runFetches, null)
      assert.equal(requests, 1)
    } finally {
      await close()
    }
  })

  await t.test("a slow response past the configured timeout records a failure", async () => {
    const { baseUrl, close } = await withServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("too slow")
      }, 300)
    })

    try {
      const database = createDatabase(":memory:")
      const job = { data: `${baseUrl}/slow`, runner: "text", extension: ".md" }
      const config = { ...pluginConfigFor(data => ({ body: data })), urlFetchTimeout: 50 }

      const { runFetches } = await fetchURLs([job], config, database)
      await runFetches()

      const status = database.url.getStatus(job.data)
      assert.equal(status.failureCount, 1)
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

    // Push failureCount up to 10; the cooldown should never exceed 8 days.
    for (let i = 0; i < 8; i++) database.url.recordFailure(url, Date.now())
    assert.equal(database.url.getStatus(url).failureCount, 10)

    database.url.recordFailure(url, Date.now() - 7 * day)
    assert.equal(shouldSkip(database.url.getStatus(url)), true) // 7 days < 8-day cap

    database.url.recordFailure(url, Date.now() - 9 * day)
    assert.equal(shouldSkip(database.url.getStatus(url)), false) // 9 days > 8-day cap
  })
})
