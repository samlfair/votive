import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import createDatabase from "../lib/createDatabase.js"
import readSources from "../lib/readSources.js"
import readBuffers from "../lib/readBuffers.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-buffers-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("readBuffers: deferred buffer processing", async (t) => {
  await t.test("readSources doesn't read, parse, or cache buffer files - just describes them", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "not actually read synchronously")

      const database = createDatabase(":memory:")
      let readFileCalls = 0

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          readFile(source) {
            readFileCalls++
            return { abstract: { kind: "photo" }, metadata: { width: 100 } }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }
      const { sources } = await readSources(config, database, processors)

      assert.equal(readFileCalls, 0)
      assert.equal(database.target.get("0"), undefined)

      const pending = sources.filter(s => s && s.readBuffer)
      assert.equal(pending.length, 1)
      // Project-relative, like every other path votive records or hands
      // to a plugin - not path.join(sourceFolder, ...).
      assert.equal(pending[0].sourcePath, "photo.bin")
    })
  })

  await t.test("runBuffers() actually runs the deferred jobs and persists the (small) parsed result", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

      const database = createDatabase(":memory:")
      let readFileCalls = 0

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          readFile(source) {
            readFileCalls++
            return { abstract: { kind: "photo" }, metadata: { width: 100 } }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }
      const { sources } = await readSources(config, database, processors)
      const { tasks, runBuffers } = readBuffers(sources, config, database)

      assert.equal(tasks.length, 1)

      await runBuffers()

      assert.equal(readFileCalls, 1)
      const target = database.target.get("0")
      assert.deepEqual(target.abstract, { kind: "photo" })
      assert.deepEqual(target.metadata, { width: 100 })

      // A second readSources pass sees the source as already handled.
      const second = await readSources(config, database, processors)
      assert.equal(second.sources.filter(s => s && s.readBuffer).length, 0)
    })
  })

  await t.test("a cached result is reused without re-invoking the plugin's readFile", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

      const database = createDatabase(":memory:")
      let readFileCalls = 0

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          readFile() {
            readFileCalls++
            return { abstract: {}, metadata: { seen: readFileCalls } }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }

      const first = await readSources(config, database, processors)
      await readBuffers(first.sources, config, database).runBuffers()
      assert.equal(readFileCalls, 1)

      const cacheDir = path.join(sourceFolder, ".cache")
      const cacheFiles = await readdir(cacheDir)
      assert.equal(cacheFiles.length, 1)

      // Force the source to look "new" again without touching the cache,
      // to isolate the cache-hit path from readSources' own staleness check.
      database.source.delete("photo.bin")
      const second = await readSources(config, database, processors)
      await readBuffers(second.sources, config, database).runBuffers()

      assert.equal(readFileCalls, 1)
    })
  })

  await t.test("api.url.create() calls made in readFile (buffer format) attribute to the routed path, and are skipped on a cache hit", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

      const database = createDatabase(":memory:")
      let readFileCalls = 0

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          readFile(filePath, api) {
            readFileCalls++
            api.url.create("https://example.com/photo", { title: "Photo" })
            return { abstract: {}, metadata: {} }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }

      const first = await readSources(config, database, processors)
      await readBuffers(first.sources, config, database).runBuffers()

      assert.equal(readFileCalls, 1)
      // No router in this config, so routing sends it to the "0"
      // placeholder - the same path the sibling tests above assert on.
      assert.ok(database.target.get("0"))

      const deps = database.dependency.getAllByTarget("https://example.com/photo")
      assert.ok(deps.some(d => d.dependent === "0"), "expected the routed target to depend on the linked URL")

      // The api is the real one now, called during readFile - so a cache
      // hit, which doesn't run readFile at all, doesn't make the call
      // either. Only the returned result is replayed. Pinned here so the
      // limitation is deliberate rather than discovered; see the note in
      // readBuffers.js's run().
      // A fresh database against the same source folder: the on-disk
      // cache still holds photo.bin's result, so readFile is skipped.
      const reopened = createDatabase(":memory:")
      const second = await readSources(config, reopened, processors)
      await readBuffers(second.sources, config, reopened).runBuffers()

      assert.equal(readFileCalls, 1)
      assert.ok(reopened.target.get("0"), "the cached result is still applied")
      assert.equal(reopened.dependency.getAllByTarget("https://example.com/photo").length, 0)
    })
  })

  await t.test("config.cacheDirectory overrides where the buffer cache is written", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

      const database = createDatabase(":memory:")

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          readFile() {
            return { abstract: {}, metadata: {} }
          }
        }
      }]

      const customCacheDir = path.join(sourceFolder, "elsewhere-cache")
      const config = {
        sourceFolder,
        targetFolder: path.join(sourceFolder, "_out"),
        cacheDirectory: customCacheDir,
        plugins: []
      }

      const { sources } = await readSources(config, database, processors)
      await readBuffers(sources, config, database).runBuffers()

      const cacheFiles = await readdir(customCacheDir)
      assert.equal(cacheFiles.length, 1)

      // The default location was never created.
      await assert.rejects(() => readdir(path.join(sourceFolder, ".cache")))
    })
  })
})
