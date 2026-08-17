import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-pluginapi-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("plugin callbacks receive a restricted api instead of the full database", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "content")
    await writeFile(path.join(sourceFolder, "b.md"), "content")

    let seenAPI
    let seenB

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
          readFile: (text, filePath) => ({ abstract: { tag: "p" }, metadata: { name: path.basename(filePath) } }),
          // writeFile runs after every target has already been created,
          // so reading b.html's own target from within a.html's write
          // (the only cross-file read that's guaranteed ordering-safe)
          // still exercises api.target() against real, already-committed
          // data instead of racing readFile's per-file concurrency.
          // The read has to happen *inside* the callback, not just the
          // api reference captured for later - dependency tracking is
          // deferred (see pluginAPI.js) and flushed right after this
          // callback returns, so a read made after that point (e.g. from
          // the test itself, post-build) would never get flushed at all.
          writeFile: (target, settings, api) => {
            if (target.path === "a.html") {
              seenAPI = api
              seenB = api.target("b.html")
              seenB.metadata.name // trigger the lazy read now, while still inside the callback
            }
            return { data: "" }
          }
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    // Only the curated methods are exposed - not the full database surface.
    assert.deepEqual(Object.keys(seenAPI).sort(), ["createTarget", "flush", "target", "targets", "url"])

    // api.target()/api.targets() read with the current file pre-loaded as
    // the dependent - reading b.html from within a.html's writeFile
    // should register a real dependency, without the callback ever
    // passing `dependent` itself.
    assert.equal(seenB.metadata.name, "b.md")

    const deps = first.cache.dependency.getAllByTarget("b.html")
    assert.ok(deps.some(d => d.dependent === "a.html"))
  })
})

test("api.createTarget() creates a target, and api.target()/api.targets() see it", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "post.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => ({ data: "" }),
          readFile: (text, filePath, targetPath, settings, api) => {
            api.createTarget({ path: "generated.html", abstract: { tag: "p" }, metadata: { generated: "yes" } })
            return { abstract: { tag: "p" }, metadata: {} }
          }
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.ok(first.cache.target.get("generated.html"))
    assert.equal(first.cache.target.get("generated.html").metadata.generated, "yes")
  })
})
