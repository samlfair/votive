import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import YAML from "yaml"
import createDatabase from "../lib/createDatabase.js"
import fetchURLs, { isFetchable, retryAfterMs } from "../lib/fetchURLs.js"
import { entryPath, parseEntry, writeEntry, storeFolder, isStorePath, hostSlug, tiebreaker } from "../lib/urlStore.js"
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

/** The one url processor most tests need: extension-less urls, body as title. */
const titleReader = {
  format: "url",
  extensions: [""],
  readURL: async (response) => ({ path: `${hostSlug(response.url)}${response.url.pathname}`, data: { title: await response.text() } })
}

/** A page processor that asks for every line of its source as a url, and renders what it gets. */
function pageProcessor(onWrite) {
  return {
    extensions: [".md", ".html"],
    format: "text",
    router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
    readFile: (source) => ({ data: source.text, metadata: { urls: source.text.split("\n").filter(Boolean) } }),
    writeFile: (target, { api }) => {
      const seen = Object.fromEntries(target.metadata.urls.map(url => [url, api.url(url)]))
      onWrite?.(seen)
      return { data: JSON.stringify(seen) }
    }
  }
}

function configFor(sourceFolder, processors, extra = {}) {
  return {
    sourceFolder,
    targetFolder: path.join(sourceFolder, "_out"),
    urlStore: path.join(sourceFolder, "links"),
    urlHostInterval: 0,
    log: () => {},
    plugins: [{ name: "test-plugin", processors }],
    ...extra
  }
}

/** Every file under the store, relative to it. */
async function storeFiles(sourceFolder) {
  const folder = path.join(sourceFolder, "links")
  try {
    const entries = await readdir(folder, { withFileTypes: true, recursive: true })
    return entries.filter(e => e.isFile()).map(e => path.relative(folder, path.join(e.parentPath, e.name))).sort()
  } catch {
    return []
  }
}

test("urlStore: entryPath appends a tiebreaker and the extension, and refuses escapes and non-portable paths", () => {
  const config = { sourceFolder: "/p", urlStore: "links" }
  const url = "https://example.com/blog/post"
  assert.equal(entryPath(config, "example.com/blog/post", url), `links/example.com/blog/post-${tiebreaker(url)}.yaml`)
  assert.equal(tiebreaker(url).length, 8)
  assert.notEqual(tiebreaker("https://example.com/Blog/Post"), tiebreaker(url), "case-only differences do not collide")
  assert.throws(() => entryPath(config, "../escape", url), /unusable path/)
  assert.throws(() => entryPath(config, "/absolute", url), /unusable path/)
  assert.throws(() => entryPath(config, "", url), /unusable path/)
  assert.throws(() => entryPath(config, "127.0.0.1:8080/x", url), /not portable/)
})

test("urlStore: hostSlug and storeFolder", () => {
  assert.equal(hostSlug("https://Example.com/a"), "example.com")
  assert.equal(hostSlug(new URL("https://example.com:8080/c")), "example.com_8080")
  assert.equal(storeFolder({ sourceFolder: "/p" }), path.join("/p", ".urls"))
  assert.equal(storeFolder({ sourceFolder: "/p", urlStore: "links" }), path.join("/p", "links"))
  assert.equal(storeFolder({ sourceFolder: "/p", urlStore: "/elsewhere" }), "/elsewhere")
  assert.equal(isStorePath({ sourceFolder: "/p", urlStore: "links" }, "/p/links/x.yaml"), true)
  assert.equal(isStorePath({ sourceFolder: "/p", urlStore: "links" }, "/p/linksmore/x"), false)
})

test("urlStore: a written entry round-trips, keys in envelope order, data verbatim", async () => {
  await withTempFolder(async (folder) => {
    const config = { sourceFolder: folder, urlStore: "links" }
    const relativePath = entryPath(config, "example.com/x", "https://example.com/x")
    await writeEntry(config, relativePath, { url: "https://example.com/x", redirect: "https://example.com/y", data: { title: "A: colon", tags: ["a"] } })

    const text = await readFile(path.join(folder, relativePath), "utf-8")
    assert.deepEqual(Object.keys(YAML.parse(text)), ["url", "redirect", "data"])
    const entry = parseEntry(text, relativePath)
    assert.equal(entry.url, "https://example.com/x")
    assert.deepEqual(entry.data, { title: "A: colon", tags: ["a"] })
  })
})

test("urlStore: parseEntry rejects anything but the envelope, naming the file", () => {
  assert.throws(() => parseEntry("- a list\n", "links/x.yaml"), /links\/x\.yaml/)
  assert.throws(() => parseEntry("data: 1\n", "links/x.yaml"), /url/)
  assert.throws(() => parseEntry("", "links/x.yaml"), /links\/x\.yaml/)
})

test("url.accumulate: identical entries touch nothing; a changed one stales dependents; deleteBySource forgets", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", metadata: {} })
  database.target.create({ path: "b.html", metadata: {} })
  database.url.request("https://x.com/1", "a.html")
  database.url.request("https://x.com/2", "b.html")

  assert.equal(database.url.accumulate({ url: "https://x.com/1", data: { title: "one" } }, "links/1.yaml"), true)
  assert.equal(database.url.accumulate({ url: "https://x.com/2", data: { title: "two" } }, "links/2.yaml"), true)
  database.target.markFresh("a.html")
  database.target.markFresh("b.html")

  assert.equal(database.url.accumulate({ url: "https://x.com/1", data: { title: "one" } }, "links/1.yaml"), false)
  assert.equal(isStale(database, "a.html"), false)

  assert.equal(database.url.accumulate({ url: "https://x.com/1", data: { title: "one, edited" } }, "links/1.yaml"), true)
  assert.equal(isStale(database, "a.html"), true)
  assert.deepEqual(database.url.get("https://x.com/1"), { title: "one, edited" })

  assert.deepEqual(database.url.deleteBySource("links/2.yaml"), ["https://x.com/2"])
  assert.equal(isStale(database, "b.html"), true, "forgotten, so it asks again")
  assert.equal(database.url.get("https://x.com/2"), undefined)
})

test("url.accumulate: a file supplying a url clears its failure state", () => {
  const database = createDatabase(":memory:")
  database.url.recordFailure("https://x.com/1")
  assert.equal(database.url.getStatus("https://x.com/1").failureCount, 1)
  database.url.accumulate({ url: "https://x.com/1", data: { ok: true } }, "links/1.yaml")
  assert.equal(database.url.getStatus("https://x.com/1").failureCount, 0)
})

test("a url file in the project is a source: read on a cold build, served without a fetch", async () => {
  let hits = 0
  const { baseUrl, close } = await withServer((req, res) => { hits++; res.writeHead(200); res.end(`fetched ${req.url}`) })

  try {
    await withTempFolder(async (folder) => {
      // A coworker's commit: one link already in the store.
      const config = configFor(folder, [pageProcessor(), titleReader])
      await writeEntry(config, entryPath(config, "h/seeded", `${baseUrl}/seeded`), { url: `${baseUrl}/seeded`, data: { title: "from the store" } })
      await writeFile(path.join(folder, "page.md"), `${baseUrl}/seeded\n${baseUrl}/fresh`)

      const site = await bundler(config)
      await (await site.build()).deferred

      assert.equal(hits, 1, "only the link the store lacked was fetched")
      const page = JSON.parse(await readFile(path.join(folder, "_out", "page.html"), "utf-8"))
      assert.deepEqual(page[`${baseUrl}/seeded`], { title: "from the store" })
      assert.deepEqual(page[`${baseUrl}/fresh`], { title: "fetched /fresh" }, "the fetch was filed and read back in the follow-up build")

      const files = await storeFiles(folder)
      assert.equal(files.length, 2)
      assert.ok(files.some(f => f.startsWith(`${hostSlug(baseUrl)}/fresh-`)))

      // The store files are sources, with rows and no target.
      assert.notEqual(site.database.source.get(path.join("links", files[0])), undefined)
      await site.close()
    })
  } finally {
    await close()
  }
})

test("a wiped database refetches nothing: the files rebuild the index", async () => {
  let hits = 0
  const { baseUrl, close } = await withServer((req, res) => { hits++; res.writeHead(200); res.end("fetched") })

  try {
    await withTempFolder(async (folder) => {
      await writeFile(path.join(folder, "page.md"), `${baseUrl}/x`)
      const config = configFor(folder, [pageProcessor(), titleReader], { databasePath: path.join(folder, "db.sqlite") })

      let site = await bundler(config)
      await (await site.build()).deferred
      await site.close()
      assert.equal(hits, 1)

      await rm(path.join(folder, "db.sqlite"), { force: true })
      site = await bundler(config)
      await (await site.build()).deferred
      assert.equal(hits, 1, "the file supplied it")
      assert.deepEqual(JSON.parse(await readFile(path.join(folder, "_out", "page.html"), "utf-8"))[`${baseUrl}/x`], { title: "fetched" })
      await site.close()
    })
  } finally {
    await close()
  }
})

test("editing a url file wins; deleting it refetches", async () => {
  let hits = 0
  const { baseUrl, close } = await withServer((req, res) => { hits++; res.writeHead(200); res.end(`fetched #${hits}`) })

  try {
    await withTempFolder(async (folder) => {
      await writeFile(path.join(folder, "page.md"), `${baseUrl}/x`)
      const config = configFor(folder, [pageProcessor(), titleReader])
      const site = await bundler(config)
      await (await site.build()).deferred
      const rendered = async () => JSON.parse(await readFile(path.join(folder, "_out", "page.html"), "utf-8"))[`${baseUrl}/x`]
      assert.deepEqual(await rendered(), { title: "fetched #1" })

      const [file] = await storeFiles(folder)
      const absolute = path.join(folder, "links", file)
      await writeFile(absolute, (await readFile(absolute, "utf-8")).replace("fetched #1", "edited by hand"))
      await (await site.build({ changed: [path.join("links", file)] })).deferred
      assert.deepEqual(await rendered(), { title: "edited by hand" })
      assert.equal(hits, 1, "an edit is not a refetch")

      await rm(absolute)
      await (await site.build()).deferred
      assert.equal(hits, 2, "deleting the file asks again")
      assert.deepEqual(await rendered(), { title: "fetched #2" })
      await site.close()
    })
  } finally {
    await close()
  }
})

test("rate limiting: requests to one host are sequential and spaced; different hosts run concurrently", async () => {
  const timeline = []
  let inFlight = 0
  let maxInFlight = 0
  const { baseUrl, close } = await withServer((req, res) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    timeline.push(Date.now())
    setTimeout(() => { inFlight--; res.writeHead(200); res.end("ok") }, 30)
  })
  const other = await withServer((req, res) => { res.writeHead(200); res.end("ok") })

  try {
    await withTempFolder(async (folder) => {
      const database = createDatabase(":memory:")
      for (let i = 0; i < 4; i++) database.url.request(`${baseUrl}/${i}`, "")
      for (let i = 0; i < 4; i++) database.url.request(`${other.baseUrl}/${i}`, "")
      const processors = [{ plugin: { name: "t" }, processor: titleReader }]
      const config = { sourceFolder: folder, urlStore: "links", urlHostInterval: 60, urlConcurrency: 8, log: () => {} }

      const start = Date.now()
      const { attempted } = await fetchURLs(config, database, processors).runFetches()
      const elapsed = Date.now() - start

      assert.equal(attempted, 8)
      assert.equal(maxInFlight, 1, "never more than one request in flight to the same host")
      const gaps = timeline.slice(1).map((t, i) => t - timeline[i])
      assert.ok(gaps.every(gap => gap >= 55), `every gap on one host is at least the interval: ${gaps}`)
      assert.ok(elapsed < 700, `hosts run concurrently with each other, took ${elapsed}ms`)
    })
  } finally {
    await close()
    await other.close()
  }
})

test("Retry-After: a 429 pauses the host, records no failure, and re-queues what was waiting", async () => {
  let hits = 0
  const { baseUrl, host, close } = await withServer((req, res) => { hits++; res.writeHead(429, { "retry-after": "2" }); res.end() })

  try {
    await withTempFolder(async (folder) => {
      const database = createDatabase(":memory:")
      for (let i = 0; i < 3; i++) database.url.request(`${baseUrl}/${i}`, "")
      const warnings = []
      const config = { sourceFolder: folder, urlStore: "links", urlHostInterval: 0, log: (level, message) => level === "warn" && warnings.push(message) }
      await fetchURLs(config, database, [{ plugin: { name: "t" }, processor: titleReader }]).runFetches()

      assert.equal(hits, 1, "the first answer pauses the host; the rest are not attempted")
      assert.equal(database.url.getStatus(`${baseUrl}/0`), undefined, "a pause is not a failure")
      assert.equal(database.url.takePending().length, 3, "all three are queued again for a later pass")
      assert.ok(warnings.some(w => w.startsWith(`${host} asked for a pause`)), `expected a pause warning: ${warnings}`)
    })
  } finally {
    await close()
  }
})

test("only http and https are fetched; anything else is neither queued nor a failure", async () => {
  assert.equal(isFetchable("https://a.com"), true)
  assert.equal(isFetchable("mailto:x@a.com"), false)
  assert.equal(isFetchable("at://did:plc:abc/app.bsky.feed.post/1"), false)
  assert.equal(isFetchable("not a url"), false)

  await withTempFolder(async (folder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: {} })
    database.url.request("mailto:x@a.com", "a.html")
    const warnings = []
    const config = { sourceFolder: folder, urlStore: "links", log: (level, message) => level === "warn" && warnings.push(message) }
    const { attempted } = await fetchURLs(config, database, [{ plugin: { name: "t" }, processor: titleReader }]).runFetches()
    assert.equal(attempted, 0)
    assert.equal(database.url.getStatus("mailto:x@a.com"), undefined)
    assert.match(warnings[0], /mailto:x@a\.com/)
    assert.equal(database.dependency.getAllByTarget("mailto:x@a.com").length, 1)
  })
})

test("retryAfterMs: seconds and HTTP dates both parse; absent is undefined", () => {
  const withHeader = (value) => ({ headers: new Headers(value ? { "retry-after": value } : {}) })
  assert.equal(retryAfterMs(withHeader("3")), 3000)
  assert.equal(retryAfterMs(withHeader(undefined)), undefined)
  assert.equal(retryAfterMs(withHeader("garbage")), undefined)
  const soon = retryAfterMs(withHeader(new Date(Date.now() + 5000).toUTCString()))
  assert.ok(soon > 3000 && soon <= 5000, `an HTTP date becomes a duration: ${soon}`)
})
