import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

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

test("readFile: a returned filePath does not move the target - routing decides where it lands", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "page", ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
                        metadata: {},
            filePath: "custom/moved.html"
          })
        }]
      }]
    }

    const site = await bundler(config)
    const { database: cache } = await site.build({ defer: false })

    // read() is handed the routed path and cannot rewrite it. A stray
    // `filePath` in the returned object is inert, not an escape hatch.
    assert.ok(cache.target.get("page.html"))
    assert.equal(cache.target.get("custom/moved.html"), undefined)

    const written = await import("node:fs/promises")
      .then(fs => fs.readFile(path.join(config.targetFolder, "page.html"), "utf-8"))
    assert.equal(written, "written:page.html")
    assert.equal(await exists(path.join(config.targetFolder, "custom/moved.html")), false)
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
        processors: [{
          router: () => ({ dir: [], name: "partial", ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => { writeFileCalls++; return { data: "should never land on disk" } },
          readFile: () => ({
            metadata: { kind: "partial" },
            metadata: {},
            write: false
          })
        }]
      }]
    }

    const site = await bundler(config)
    const { database: cache } = await site.build({ defer: false })

    // The target exists and is readable...
    const target = cache.target.get("partial.html")
    assert.ok(target)
    assert.equal(target.write, false)

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
        processors: [{
          router: () => ({ dir: [], name: "toggle", ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => ({ data: "toggled content" }),
          readFile: () => ({
                        metadata: {},
            write: virtual ? false : true
          })
        }]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    assert.equal(first.database.target.get("toggle.html").write, false)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), false)

    // Flip it, then touch the source file so it's re-read.
    virtual = false
    await writeFile(sourcePath, "v2")

    const second = await site.build({ defer: false })

    assert.equal(second.database.target.get("toggle.html").write, true)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), true)
  })
})

test("readFile (buffer format): a returned filePath does not move the target either", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "asset.bin"), "binary content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "asset", ext: ".html" }),
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
                        metadata: {},
            filePath: "buffers/renamed.html"
          })
        }]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    await first.runBuffers()

    const final = await site.build({ defer: false })

    assert.ok(final.database.target.get("asset.html"))
    assert.equal(final.database.target.get("buffers/renamed.html"), undefined)
    assert.equal(await exists(path.join(config.targetFolder, "asset.html")), true)
    assert.equal(await exists(path.join(config.targetFolder, "buffers/renamed.html")), false)
  })
})

test("readFile: an api.url.create() call attributes to the routed target path", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: ({ name }) => ({ dir: [], name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: (source, { api }) => {
            // The api is real and pre-bound to targetPath, so this runs
            // immediately rather than being queued - the path it
            // attributes to is settled before read() is even called.
            api.url.create("https://example.com/thing", { title: "Thing" })
            return { metadata: {} }
          }
        }]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    assert.ok(first.database.target.get("page.html"))

    const deps = first.database.dependency.getAllByTarget("https://example.com/thing")
    assert.ok(deps.some(d => d.dependent === "page.html"), "expected page.html to depend on the linked URL")
  })
})
