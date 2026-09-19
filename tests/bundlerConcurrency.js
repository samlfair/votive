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

test("bundler: site.build() coalesces concurrent callers into a single trailing pass instead of running bundle() concurrently or dropping requests", async () => {
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

    // Start a build for a.md, then - before anything yields back to it
    // (writeFileSync and calling site.build() are both synchronous up to
    // their first internal await) - add a second file and call
    // site.build() twice more. Because site.build() sets `running`
    // synchronously before
    // its first internal await, every caller here is guaranteed to see
    // the first build already in flight and coalesce into one trailing
    // pass, rather than starting a second bundle() concurrently or
    // missing b.md entirely.
    writeFileSync(path.join(sourceFolder, "a.md"), "a")
    const firstCall = site.build()
    writeFileSync(path.join(sourceFolder, "b.md"), "b")
    const secondCall = site.build()
    const thirdCall = site.build()

    const [first, second, third] = await Promise.all([firstCall, secondCall, thirdCall])
    // These plugins defer nothing, so every `deferred` is already
    // resolved; awaiting keeps the test independent of that.
    await Promise.all([first, second, third].map(result => result.deferred))

    // One bundle() pass reads a.md; exactly one trailing pass (not one
    // per extra caller) picks up b.md.
    assert.equal(readFileCalls, 2)

    for (const result of [first, second, third]) {
      assert.ok(site.database.target.get("a.html"))
      assert.ok(site.database.target.get("b.html"))
    }
  })
})

test("bundler: slow deferred buffer work doesn't block a concurrent foreground site.build() call", async () => {
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
    // concurrent foreground edit's own site.build() call.
    const { deferred } = await site.build()

    await wait(20)
    assert.equal(slowReadStarted, true)
    assert.equal(slowReadFinished, false)

    // An unrelated foreground edit arrives while the buffer is still
    // being analyzed.
    await writeFile(path.join(sourceFolder, "page.md"), "hello")
    const start = Date.now()
    // Deliberately not awaiting `deferred` - the whole point is that the
    // foreground pass returns without waiting for the slow buffer work.
    const result = await site.build()
    const elapsed = Date.now() - start

    assert.equal(slowReadFinished, false, "the foreground rebuild should finish well before the slow buffer analysis does")
    assert.ok(elapsed < 80, `foreground site.build() call took ${elapsed}ms - it should not have waited on the slow buffer analysis`)
    assert.ok(site.database.target.get("page.html"))

    await deferred
  })
})

test("bundler: coalesced build() calls run every pass's deferred runner, each exactly once", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const reads = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      plugins: [{
        name: "bin",
        processors: [{
          format: "buffer",
          extensions: [".bin"],
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile: async (source) => {
            reads.push(source.path)
            await wait(30)
            return { data: source.buffer().toString() }
          },
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    await writeFile(path.join(sourceFolder, "a.bin"), "a1")
    await writeFile(path.join(sourceFolder, "b.bin"), "b1")
    const site = await bundler(config)
    await (await site.build()).deferred
    reads.length = 0

    // Two edits whose build() calls coalesce: the second arrives while
    // the first pass runs, so the loop runs a trailing pass. Each pass
    // found one buffer to read. Both runners must run, and once each -
    // the first used to be dropped (its edit lost until a full scan)
    // and the second run by every waiting caller.
    await writeFile(path.join(sourceFolder, "a.bin"), "a2")
    await writeFile(path.join(sourceFolder, "b.bin"), "b2")
    const first = site.build({ changed: ["a.bin"] })
    const second = site.build({ changed: ["b.bin"] })
    const results = await Promise.all([first, second])
    await Promise.all(results.map(result => result.deferred))

    assert.deepEqual(reads.sort(), ["a.bin", "b.bin"])
    const { readFile } = await import("node:fs/promises")
    assert.equal(await readFile(path.join(sourceFolder, "_out", "a.bin"), "utf8"), "a2")
    assert.equal(await readFile(path.join(sourceFolder, "_out", "b.bin"), "utf8"), "b2")
  })
})

test("bundler: deferred batches from successive passes run one after another, not overlapped", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let inFlight = 0
    let mostInFlight = 0
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      plugins: [{
        name: "bin",
        processors: [{
          format: "buffer",
          extensions: [".bin"],
          router: ({ name, dir, ext }) => ({ name, dir, ext }),
          readFile: async (source) => {
            inFlight++
            mostInFlight = Math.max(mostInFlight, inFlight)
            await wait(40)
            inFlight--
            return { data: source.buffer().toString() }
          },
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    await writeFile(path.join(sourceFolder, "a.bin"), "a1")
    await writeFile(path.join(sourceFolder, "b.bin"), "b1")
    const site = await bundler(config)
    await (await site.build()).deferred
    mostInFlight = 0

    // Edit a, let its pass finish (its runner is now in flight), then
    // edit b: b's runner waits for a's batch rather than decoding
    // beside it.
    await writeFile(path.join(sourceFolder, "a.bin"), "a2")
    const first = await site.build({ changed: ["a.bin"] })
    await writeFile(path.join(sourceFolder, "b.bin"), "b2")
    const second = await site.build({ changed: ["b.bin"] })
    await Promise.all([first.deferred, second.deferred])

    assert.equal(mostInFlight, 1)
  })
})
