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

test("bundler: site.build({ defer: false }) coalesces concurrent callers into a single trailing pass instead of running bundle() concurrently or dropping requests", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let readFileCalls = 0

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
          writeFile: () => ({ data: "" }),
          readFile() {
            readFileCalls++
            return { metadata: {} }
          }
        }]
      }]
    }

    const site = await bundler(config)

    // Start a build for a.md, then - before anything yields back to
    // it (writeFileSync and calling site.build({ defer: false }) are both synchronous up to
    // their first internal await) - add a second file and call site.build({ defer: false })
    // twice more. Because site.build({ defer: false }) sets `running` synchronously before
    // its first internal await, every caller here is guaranteed to see
    // the first build already in flight and coalesce into one trailing
    // pass, rather than starting a second bundle() concurrently or
    // missing b.md entirely.
    writeFileSync(path.join(sourceFolder, "a.md"), "a")
    const firstCall = site.build({ defer: false })
    writeFileSync(path.join(sourceFolder, "b.md"), "b")
    const secondCall = site.build({ defer: false })
    const thirdCall = site.build({ defer: false })

    const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall])

    // One bundle() pass reads a.md; exactly one trailing pass (not one
    // per extra caller) picks up b.md.
    assert.equal(readFileCalls, 2)

    for (const result of [first, second, third]) {
      assert.ok(site.database.target.get("a.html"))
      assert.ok(site.database.target.get("b.html"))
    }
  })
})

test("bundler: slow deferred buffer work doesn't block a concurrent foreground site.build({ defer: false }) call", async () => {
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
        processors: [
          {
            router: ({ name }) => ({ dir: [], name, ext: ".html" }),
            extensions: [".bin", ".html"],
            format: "buffer",
            writeFile: () => ({ data: "" }),
            async readFile() {
              slowReadStarted = true
              await wait(100)
              slowReadFinished = true
              return { metadata: {} }
            }
          },
          {
            router: ({ name }) => ({ dir: [], name, ext: ".html" }),
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => ({ data: "" }),
            readFile: () => ({ metadata: {} })
          }
        ]
      }]
    }

    const site = await bundler(config)
    // Not awaiting `deferred`, mirroring how the dev server lets the slow
    // buffer analysis run in the background: this must not block a
    // concurrent foreground edit's own site.build({ defer: false }) call.
    const { deferred } = await site.build()

    await wait(20)
    assert.equal(slowReadStarted, true)
    assert.equal(slowReadFinished, false)

    // An unrelated foreground edit arrives while the buffer is still
    // being analyzed.
    await writeFile(path.join(sourceFolder, "page.md"), "hello")
    const start = Date.now()
    const result = await site.build({ defer: false })
    const elapsed = Date.now() - start

    assert.equal(slowReadFinished, false, "the foreground rebuild should finish well before the slow buffer analysis does")
    assert.ok(elapsed < 80, `foreground site.build({ defer: false }) call took ${elapsed}ms - it should not have waited on the slow buffer analysis`)
    assert.ok(site.database.target.get("page.html"))

    await deferred
  })
})
