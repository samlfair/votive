import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import votive from "../lib/bundle.js"
import { VOTIVE_VERSION, cacheKeyFor, syncBufferCache } from "../lib/cacheKey.js"

test("the cache key is votive's version and the caller's", () => {
  assert.equal(cacheKeyFor({}), `votive@${VOTIVE_VERSION}`)
  assert.equal(cacheKeyFor({ cacheKey: "vowel@1.2.3" }), `votive@${VOTIVE_VERSION} vowel@1.2.3`)
})

test("a warm start with the same key reuses the database; a different key starts it over", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "votive-cachekey-"))
  const sourceFolder = path.join(root, "site")
  await mkdir(sourceFolder)
  await writeFile(path.join(sourceFolder, "page.txt"), "hello")
  const reads = []
  const config = (cacheKey) => ({
    sourceFolder,
    targetFolder: path.join(root, "out"),
    databasePath: path.join(root, "db", ".votive.db"),
    cacheDirectory: path.join(root, "cache"),
    cacheKey,
    log: () => {},
    plugins: [{
      name: "p",
      processors: [{
        extensions: [".txt", ".html"],
        format: "text",
        router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
        readFile: (source) => { reads.push(source.path); return { data: source.text, metadata: {} } },
        writeFile: (target) => ({ data: target.data })
      }]
    }]
  })
  const run = async (cacheKey) => {
    const site = await votive(config(cacheKey))
    await (await site.build()).deferred
    await site.close()
  }
  try {
    await run("app@1")
    assert.equal(reads.length, 1)
    await run("app@1")
    assert.equal(reads.length, 1, "same key: a warm start, nothing re-read")
    await run("app@2")
    assert.equal(reads.length, 2, "a new key: the database started over, so the page was read again")
    assert.equal(await readFile(path.join(root, "out", "page.html"), "utf8"), "hello")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the buffer cache keeps its own key: a different one empties it; a folder that doesn't exist isn't made", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "votive-buffercache-"))
  const cache = path.join(root, "cache")
  try {
    assert.equal(await syncBufferCache(cache, "k1"), false)
    assert.deepEqual(await readdir(root), [], "not created")

    await mkdir(cache)
    await writeFile(path.join(cache, "abc.json"), "{}")
    assert.equal(await syncBufferCache(cache, "k1"), true, "no key yet: emptied, keyed")
    assert.deepEqual((await readdir(cache)).sort(), ["cache-key"])

    await writeFile(path.join(cache, "def.json"), "{}")
    assert.equal(await syncBufferCache(cache, "k1"), false, "same key: kept")
    assert.ok((await readdir(cache)).includes("def.json"))
    assert.equal(await syncBufferCache(cache, "k2"), true)
    assert.deepEqual(await readdir(cache), ["cache-key"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
