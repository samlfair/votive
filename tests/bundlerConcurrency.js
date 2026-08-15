import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-bundler-concurrency-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/** @param {number} ms */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test("bundler: step() coalesces concurrent callers into a single trailing pass instead of running bundle() concurrently or dropping requests", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let readFileCalls = 0

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
          writeFile: () => ({ data: "" }),
          readFile() {
            readFileCalls++
            return { abstract: {}, metadata: {} }
          }
        }]
      }]
    }

    const queue = await bundler(config)

    // Start a build for a.md, then - before anything yields back to
    // it (writeFileSync and calling queue() are both synchronous up to
    // their first internal await) - add a second file and call queue()
    // twice more. Because step() sets `running` synchronously before
    // its first internal await, every caller here is guaranteed to see
    // the first build already in flight and coalesce into one trailing
    // pass, rather than starting a second bundle() concurrently or
    // missing b.md entirely.
    writeFileSync(path.join(sourceFolder, "a.md"), "a")
    const firstCall = queue()
    writeFileSync(path.join(sourceFolder, "b.md"), "b")
    const secondCall = queue()
    const thirdCall = queue()

    const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall])

    // One bundle() pass reads a.md; exactly one trailing pass (not one
    // per extra caller) picks up b.md.
    assert.equal(readFileCalls, 2)

    for (const result of [first, second, third]) {
      assert.ok(result.cache.target.get("a.html"))
      assert.ok(result.cache.target.get("b.html"))
    }
  })
})

test("bundler: a slow deferred runBuffers() doesn't block a concurrent foreground step() call", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "video.bin"), "binary content")

    let slowReadStarted = false
    let slowReadFinished = false

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: ({ name }) => ({ dir: [], name, ext: ".html" }),
        processors: [
          {
            extensions: [".bin", ".html"],
            format: "buffer",
            writeFile: () => ({ data: "" }),
            async readFile() {
              slowReadStarted = true
              await wait(100)
              slowReadFinished = true
              return { abstract: {}, metadata: {} }
            }
          },
          {
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => ({ data: "" }),
            readFile: () => ({ abstract: {}, metadata: {} })
          }
        ]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    // Fire the slow buffer analysis without awaiting it, mirroring how
    // voot's file-watcher handler calls runBuffers()/runFetches(): this
    // must not block a concurrent foreground edit's own queue() call.
    const runBuffersPromise = first.runBuffers()

    await wait(20)
    assert.equal(slowReadStarted, true)
    assert.equal(slowReadFinished, false)

    // An unrelated foreground edit arrives while the buffer is still
    // being analyzed.
    await writeFile(path.join(sourceFolder, "page.md"), "hello")
    const start = Date.now()
    const result = await queue()
    const elapsed = Date.now() - start

    assert.equal(slowReadFinished, false, "the foreground rebuild should finish well before the slow buffer analysis does")
    assert.ok(elapsed < 80, `foreground queue() call took ${elapsed}ms - it should not have waited on the slow buffer analysis`)
    assert.ok(result.cache.target.get("page.html"))

    await runBuffersPromise
  })
})
