import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"
import createDatabase from "../lib/createDatabase.js"
import createPluginAPI from "../lib/pluginAPI.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-routing-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/** @param {string} filePath */
async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch (e) {
    return false
  }
}

test("readFile: a returned filePath overrides the routed targetFilePath", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "page", ext: ".html" }),
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
            abstract: {},
            metadata: {},
            filePath: "custom/moved.html"
          })
        }]
      }]
    }

    const queue = await bundler(config)
    const { cache } = await queue()

    assert.equal(cache.target.get("page.html"), undefined)
    assert.ok(cache.target.get("custom/moved.html"))

    const written = await import("node:fs/promises")
      .then(fs => fs.readFile(path.join(config.targetFolder, "custom/moved.html"), "utf-8"))
    assert.equal(written, "written:custom/moved.html")
  })
})

test("readFile: write: false creates a target without writing a file to disk", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "partial.md"), "content")

    let writeFileCalls = 0

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "partial", ext: ".html" }),
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => { writeFileCalls++; return { data: "should never land on disk" } },
          readFile: () => ({
            abstract: { kind: "partial" },
            metadata: {},
            write: false
          })
        }]
      }]
    }

    const queue = await bundler(config)
    const { cache } = await queue()

    // The target exists and is readable...
    const target = cache.target.get("partial.html")
    assert.ok(target)
    assert.equal(target.write, 0)

    // ...its processor's writeFile still ran normally (side effects,
    // e.g. api.createTarget() calls, aren't skipped)...
    assert.equal(writeFileCalls, 1)

    // ...but nothing was written to disk.
    assert.equal(await exists(path.join(config.targetFolder, "partial.html")), false)
  })
})

test("readFile: write can flip an existing target between virtual and written across builds", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const sourcePath = path.join(sourceFolder, "toggle.md")
    await writeFile(sourcePath, "v1")

    let virtual = true

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "toggle", ext: ".html" }),
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => ({ data: "toggled content" }),
          readFile: () => ({
            abstract: {},
            metadata: {},
            write: virtual ? false : true
          })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.equal(first.cache.target.get("toggle.html").write, 0)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), false)

    // Flip it, then touch the source file so it's re-read.
    virtual = false
    await writeFile(sourcePath, "v2")

    const second = await queue()

    assert.equal(second.cache.target.get("toggle.html").write, 1)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), true)
  })
})

test("readFile (buffer format): filePath and write are honored the same way as text format", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "asset.bin"), "binary content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "asset", ext: ".html" }),
        processors: [{
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
            abstract: {},
            metadata: {},
            filePath: "buffers/renamed.html"
          })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    await first.runBuffers()

    const final = await queue()

    assert.equal(final.cache.target.get("asset.html"), undefined)
    assert.ok(final.cache.target.get("buffers/renamed.html"))
    assert.equal(await exists(path.join(config.targetFolder, "buffers/renamed.html")), true)
  })
})

test("createPluginAPI: reads are deferred - nothing is written until flush()", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "other.html", abstract: { v: 1 }, metadata: {} })

  const api = createPluginAPI(database)
  api.target("other.html").abstract // triggers the lazy getter, but only records - doesn't write yet

  assert.deepEqual(database.dependency.getAllByTarget("other.html"), [])
})

test("createPluginAPI: flush() attributes every recorded read to whatever dependent it's given, regardless of when the read happened", () => {
  const database = createDatabase(":memory:")

  database.target.create({ path: "other.html", abstract: { v: 1 }, metadata: {} })
  database.target.create({ path: "actual.html", abstract: {}, metadata: {} })
  database.target.markFresh("actual.html")

  // Mimics a readFile() that doesn't decide its real target ("actual.html")
  // until after it's already made an api.target() call - no equivalent of
  // the old api.retarget() needed, every read this API makes stays
  // deferred until flush() regardless of ordering within the callback.
  const api = createPluginAPI(database)
  api.target("other.html").abstract
  api.flush("actual.html")

  database.target.create({ path: "other.html", abstract: { v: 2 }, metadata: {} })

  const actual = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get("actual.html")
  assert.equal(Boolean(actual.stale), true)
})

test("readFile: a filePath override correctly redirects dependency tracking to the final path, automatically", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: ({ name }) => ({ dir: [], name, ext: ".html" }),
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: (text, filePath, targetPath, settings, api) => {
            // Self-created rather than cross-file, so there's no
            // ordering hazard from readSources.js processing multiple
            // files concurrently - other.html is guaranteed to exist by
            // the time it's read back two lines down.
            api.createTarget({ path: "other.html", abstract: { v: 1 }, metadata: {} })
            // Read *before* deciding to relocate itself - no
            // api.retarget()-equivalent call needed for this to
            // attribute correctly once flushed.
            api.target("other.html").abstract
            return { abstract: {}, metadata: {}, filePath: "moved.html" }
          }
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.ok(first.cache.target.get("moved.html"))

    const deps = first.cache.dependency.getAllByTarget("other.html")
    assert.ok(deps.some(d => d.dependent === "moved.html"), "expected moved.html to depend on other.html")
    assert.ok(!deps.some(d => d.dependent === "page.html"), "the pre-override routed path should not have been recorded")
  })
})
