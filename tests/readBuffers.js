import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import createDatabase from "../lib/createDatabase.js"
import bundler from "../lib/bundle.js"
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
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile(source) {
            readFileCalls++
            return { metadata: { kind: "photo", width: 100 } }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }
      const { sources } = await readSources(config, database, processors)

      assert.equal(readFileCalls, 0)
      assert.equal(database.target.get("photo.bin"), undefined)

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
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile(source) {
            readFileCalls++
            return { metadata: { kind: "photo", width: 100 } }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }
      const { sources } = await readSources(config, database, processors)
      const { tasks, runBuffers } = readBuffers(sources, config, database)

      assert.equal(tasks.length, 1)

      await runBuffers()

      assert.equal(readFileCalls, 1)
      const target = database.target.get("photo.bin")
      assert.deepEqual(target.metadata, { kind: "photo", width: 100 })

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
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile() {
            readFileCalls++
            return { metadata: { seen: readFileCalls } }
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

  await t.test("api.url() calls made in readFile (buffer format) attribute to the routed path, and are skipped on a cache hit", async () => {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

      const database = createDatabase(":memory:")
      let readFileCalls = 0

      const processors = [{
        plugin: { name: "test-buffer-plugin" },
        processor: {
          extensions: [".bin"],
          format: "buffer",
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile(source, { api }) {
            readFileCalls++
            api.url("https://example.com/photo")
            return { metadata: {} }
          }
        }
      }]

      const config = { sourceFolder, targetFolder: path.join(sourceFolder, "_out"), plugins: [] }

      const first = await readSources(config, database, processors)
      await readBuffers(first.sources, config, database).runBuffers()

      assert.equal(readFileCalls, 1)
      assert.ok(database.target.get("photo.bin"))

      const deps = database.dependency.getAllByTarget("https://example.com/photo")
      assert.ok(deps.some(d => d.dependent === "photo.bin"), "expected the routed target to depend on the linked URL")

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
      assert.ok(reopened.target.get("photo.bin"), "the cached result is still applied")
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
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile() {
            return { metadata: {} }
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

test("readBuffers: a buffer file replaced in place is a cache miss - the cache keys on mtime, not path alone", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let reads = 0
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      plugins: [{
        name: "bytes",
        processors: [{
          extensions: [".bin"],
          format: "buffer",
          router: ({ name, dir, ext }) => ({ dir, name, ext }),
          readFile: (source) => { reads++; return { metadata: { size: source.buffer().length } } },
          writeFile: (target) => ({ data: target.buffer() })
        }]
      }]
    }
    await writeFile(path.join(sourceFolder, "a.bin"), Buffer.from("one"))
    const site = await bundler(config)
    await (await site.build()).deferred
    assert.equal(site.database.target.get("a.bin").metadata.size, 3)
    assert.equal(reads, 1)

    // Same bytes, second launch: served from the cache.
    const again = await bundler(config)
    await (await again.build()).deferred
    assert.equal(reads, 1, "unchanged file: a cache hit")
    await again.close()

    // Replaced in place, with a later mtime.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(path.join(sourceFolder, "a.bin"), Buffer.from("seven"))
    await (await site.build()).deferred
    assert.equal(site.database.target.get("a.bin").metadata.size, 5, "the new bytes were read")
    assert.equal(reads, 2)
    await site.close()
  })
})
