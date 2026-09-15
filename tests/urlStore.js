import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import YAML from "yaml"
import createDatabase from "../lib/createDatabase.js"
import fetchURLs, { isFetchable, retryAfterMs } from "../lib/fetchURLs.js"
import { hostFile, loadStore, saveEntry, saveHostFile, storeFolder, isStorePath } from "../lib/urlStore.js"
import bundler from "../lib/bundle.js"

function isStale(database, targetPath) {
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get(targetPath)
  return Boolean(row && row.stale)
}

async function withTempFolder(run) {
  const folder = await mkdtemp(path.join(tmpdir(), "votive-urlstore-"))
  try {
    await run(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    host: `127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  }
}

/** A processor whose readURL records the body as {title}. */
const titleReader = { extensions: [".md"], readURL: async (response) => ({ title: await response.text() }) }

function configFor(sourceFolder, extra = {}) {
  return {
    sourceFolder,
    targetFolder: path.join(sourceFolder, "_out"),
    urlStore: path.join(sourceFolder, "links"),
    urlHostInterval: 0,
    log: () => {},
    plugins: [{ name: "test-plugin", processors: [titleReader] }],
    ...extra
  }
}

test("urlStore: hostFile maps a URL to one file per host", () => {
  assert.equal(hostFile("https://Example.com/a"), "example.com.yaml")
  assert.equal(hostFile("http://example.com/b"), "example.com.yaml", "http and https share a file")
  assert.equal(hostFile("https://example.com:8080/c"), "example.com_8080.yaml", "a port's colon is not a filename character on Windows")
  assert.equal(hostFile("https://sub.example.com/"), "sub.example.com.yaml")
})

test("urlStore: storeFolder resolves relative to sourceFolder, absolute as given, and defaults hidden", () => {
  assert.equal(storeFolder({ sourceFolder: "/p" }), path.join("/p", ".urls"))
  assert.equal(storeFolder({ sourceFolder: "/p", urlStore: "links" }), path.join("/p", "links"))
  assert.equal(storeFolder({ sourceFolder: "/p", urlStore: "/elsewhere/links" }), "/elsewhere/links")
  assert.equal(isStorePath({ sourceFolder: "/p", urlStore: "links" }, "/p/links/example.com.yaml"), true)
  assert.equal(isStorePath({ sourceFolder: "/p", urlStore: "links" }, "/p/linksmore/x"), false)
})

test("urlStore: entries round-trip through a host file, keys sorted, data verbatim", async () => {
  await withTempFolder(async (folder) => {
    const config = { sourceFolder: folder, urlStore: "links" }
    await saveEntry(config, "https://example.com/zeta", { fetched: "2026-09-15", data: { title: "Z", tags: ["a", "b"] } })
    await saveEntry(config, "https://example.com/alpha", { data: { title: "A: with a colon" } })
    await saveEntry(config, "https://other.net/x", { data: { title: "X" } })

    const files = (await readdir(path.join(folder, "links"))).sort()
    assert.deepEqual(files, ["example.com.yaml", "other.net.yaml"])

    const text = await readFile(path.join(folder, "links", "example.com.yaml"), "utf-8")
    assert.ok(text.indexOf("alpha") < text.indexOf("zeta"), "sorted by url, so a diff is one entry")
    assert.deepEqual(Object.keys(YAML.parse(text)), ["https://example.com/alpha", "https://example.com/zeta"])

    const store = await loadStore(config)
    assert.equal(store.size, 3)
    assert.deepEqual(store.get("https://example.com/zeta").data, { title: "Z", tags: ["a", "b"] })
    assert.equal(store.get("https://example.com/alpha").data.title, "A: with a colon")
  })
})

test("urlStore: a malformed host file is an error naming the file, not an empty store", async () => {
  await withTempFolder(async (folder) => {
    await mkdir(path.join(folder, "links"), { recursive: true })
    await writeFile(path.join(folder, "links", "example.com.yaml"), "- this\n- is a list\n")
    await assert.rejects(() => loadStore({ sourceFolder: folder, urlStore: "links" }), /example\.com\.yaml/)
  })
})

test("url.seed: identical entries touch nothing; a changed entry stales dependents; a missing one is forgotten", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", metadata: {} })
  database.target.create({ path: "b.html", metadata: {} })
  database.url.request("https://x.com/1", "a.html", titleReader)
  database.url.request("https://x.com/2", "b.html", titleReader)
  database.url.create("https://x.com/1", { title: "one" })
  database.url.create("https://x.com/2", { title: "two" })
  database.target.markFresh("a.html")
  database.target.markFresh("b.html")

  const same = database.url.seed(new Map([
    ["https://x.com/1", { data: { title: "one" } }],
    ["https://x.com/2", { data: { title: "two" } }]
  ]))
  assert.deepEqual(same, { changed: [], removed: [] })
  assert.equal(isStale(database, "a.html"), false)

  const edited = database.url.seed(new Map([
    ["https://x.com/1", { data: { title: "one, edited" } }]
  ]))
  assert.deepEqual(edited.changed, ["https://x.com/1"])
  assert.deepEqual(edited.removed, ["https://x.com/2"])
  assert.equal(isStale(database, "a.html"), true, "its link changed")
  assert.equal(isStale(database, "b.html"), true, "its link was forgotten, so it must ask again")
  assert.equal(database.url.get("https://x.com/2"), undefined)
  assert.deepEqual(database.url.get("https://x.com/1"), { title: "one, edited" })
})

test("a store entry is served without a fetch; a fetch writes the store", async () => {
  let hits = 0
  const { baseUrl, host, close } = await withServer((req, res) => {
    hits++
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(`fetched ${req.url}`)
  })

  try {
    await withTempFolder(async (folder) => {
      // Pre-seed one link in the store, as a coworker's commit would.
      await saveEntry({ sourceFolder: folder, urlStore: "links" }, `${baseUrl}/seeded`, { data: { title: "from the store" } })
      await writeFile(path.join(folder, "page.md"), `${baseUrl}/seeded\n${baseUrl}/fresh`)

      let seen = {}
      const config = configFor(folder, {
        plugins: [{
          name: "test-plugin",
          processors: [{
            extensions: [".md", ".html"],
            format: "text",
            router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
            readFile: (source) => ({ data: source.text, metadata: { urls: source.text.split("\n") } }),
            readURL: titleReader.readURL,
            // From metadata, not `data`: the write pass stores back what
            // writeFile produced, so on the rebuild after the fetch lands
            // `data` is this hook's own previous output.
            writeFile: (target, { api }) => {
              seen = Object.fromEntries(target.metadata.urls.map(url => [url, api.url(url)]))
              return { data: "" }
            }
          }]
        }]
      })

      const site = await bundler(config)
      await (await site.build()).deferred

      assert.equal(hits, 1, "only the link the store lacked was fetched")
      assert.deepEqual(seen[`${baseUrl}/seeded`], { title: "from the store" })
      assert.deepEqual(seen[`${baseUrl}/fresh`], { title: "fetched /fresh" })

      const store = await loadStore(config)
      assert.equal(store.get(`${baseUrl}/fresh`).data.title, "fetched /fresh", "the fetch was written through")
      assert.match(store.get(`${baseUrl}/fresh`).fetched, /^\d{4}-\d{2}-\d{2}T/)
      assert.equal((await readdir(path.join(folder, "links")))[0], hostFile(baseUrl))
      await site.close()
    })
  } finally {
    await close()
  }
})

test("the store folder is not source: nothing in it is read as a page", async () => {
  await withTempFolder(async (folder) => {
    await saveEntry({ sourceFolder: folder, urlStore: "links" }, "https://example.com/x", { data: { title: "X" } })
    await writeFile(path.join(folder, "page.md"), "hello")

    const read = []
    const config = configFor(folder, {
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".yaml", ".html"],
          format: "text",
          router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
          readFile: (source) => { read.push(source.path); return { data: source.text, metadata: {} } },
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    })
    const site = await bundler(config)
    await (await site.build()).deferred
    assert.deepEqual(read, ["page.md"])
    await site.close()
  })
})

test("rate limiting: requests to one host are sequential and spaced; different hosts run concurrently", async () => {
  const timeline = []
  let inFlight = 0
  let maxInFlight = 0
  const { baseUrl, close } = await withServer((req, res) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    timeline.push([req.url, Date.now()])
    setTimeout(() => { inFlight--; res.writeHead(200); res.end("ok") }, 30)
  })
  const other = await withServer((req, res) => { res.writeHead(200); res.end("ok") })

  try {
    const database = createDatabase(":memory:")
    for (let i = 0; i < 4; i++) database.url.request(`${baseUrl}/${i}`, "", titleReader)
    for (let i = 0; i < 4; i++) database.url.request(`${other.baseUrl}/${i}`, "", titleReader)

    const config = { sourceFolder: "/nowhere", urlStore: path.join(tmpdir(), "votive-rl-" + process.pid), urlHostInterval: 60, urlConcurrency: 8, log: () => {} }
    const start = Date.now()
    const attempted = await fetchURLs(config, database).runFetches()
    const elapsed = Date.now() - start
    await rm(config.urlStore, { recursive: true, force: true })

    assert.equal(attempted, 8)
    assert.equal(maxInFlight, 1, "never more than one request in flight to the same host")
    const gaps = timeline.slice(1).map(([, t], i) => t - timeline[i][1])
    assert.ok(gaps.every(gap => gap >= 55), `every gap on one host is at least the interval: ${gaps}`)
    // 4 requests x (30ms + 60ms) ~ 360ms for the slow host; if the two
    // hosts were serialized against each other this would be far higher.
    assert.ok(elapsed < 700, `hosts run concurrently with each other, took ${elapsed}ms`)
  } finally {
    await close()
    await other.close()
  }
})

test("Retry-After: a 429 pauses the host, records no failure, and re-queues what was waiting", async () => {
  let hits = 0
  const { baseUrl, host, close } = await withServer((req, res) => {
    hits++
    res.writeHead(429, { "retry-after": "2" })
    res.end()
  })

  try {
    const database = createDatabase(":memory:")
    for (let i = 0; i < 3; i++) database.url.request(`${baseUrl}/${i}`, "", titleReader)

    const warnings = []
    const config = { sourceFolder: "/nowhere", urlStore: path.join(tmpdir(), "votive-ra-" + process.pid), urlHostInterval: 0, log: (level, message) => level === "warn" && warnings.push(message) }
    await fetchURLs(config, database).runFetches()

    assert.equal(hits, 1, "the first answer pauses the host; the rest are not attempted")
    assert.equal(database.url.getStatus(`${baseUrl}/0`), undefined, "a pause is not a failure")
    assert.equal(database.url.takePending().length, 3, "all three are queued again for a later pass")
    assert.ok(warnings.some(w => w.startsWith(`${host} asked for a pause`)), `expected a pause warning naming ${host}: ${warnings}`)
  } finally {
    await close()
  }
})

test("only http and https are fetched; anything else is neither queued nor a failure", async () => {
  assert.equal(isFetchable("https://a.com"), true)
  assert.equal(isFetchable("http://a.com"), true)
  assert.equal(isFetchable("mailto:x@a.com"), false)
  assert.equal(isFetchable("at://did:plc:abc/app.bsky.feed.post/1"), false)
  assert.equal(isFetchable("not a url"), false)

  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", metadata: {} })
  database.url.request("mailto:x@a.com", "a.html", titleReader)

  const warnings = []
  const config = { sourceFolder: "/nowhere", urlStore: path.join(tmpdir(), "votive-scheme-" + process.pid), log: (level, message) => level === "warn" && warnings.push(message) }
  assert.equal(await fetchURLs(config, database).runFetches(), 0)
  assert.equal(database.url.getStatus("mailto:x@a.com"), undefined, "no failure row, so no cooldown to retry forever")
  assert.match(warnings[0], /mailto:x@a\.com/)
  // The dependency is still recorded: a future fetcher for the scheme
  // would restale the page.
  assert.equal(database.dependency.getAllByTarget("mailto:x@a.com").length, 1)
})

test("retryAfterMs: seconds and HTTP dates both parse; absent is undefined", () => {
  const withHeader = (value) => ({ headers: new Headers(value ? { "retry-after": value } : {}) })
  assert.equal(retryAfterMs(withHeader("3")), 3000)
  assert.equal(retryAfterMs(withHeader(undefined)), undefined)
  assert.equal(retryAfterMs(withHeader("garbage")), undefined)
  const soon = retryAfterMs(withHeader(new Date(Date.now() + 5000).toUTCString()))
  assert.ok(soon > 3000 && soon <= 5000, `an HTTP date becomes a duration: ${soon}`)
})
