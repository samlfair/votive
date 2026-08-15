import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-bundle-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/** @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler */
async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) }
}

test("bundle: buffer processing and URL fetches a plugin claims are both deferred, returned from calling the queue", async () => {
  let fetchServerHits = 0
  const { baseUrl, close } = await withServer((req, res) => {
    fetchServerHits++
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("raw-asset-bytes")
  })

  try {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")
      await writeFile(path.join(sourceFolder, "page.md"), `${baseUrl}/asset`)

      let bufferReadCalls = 0

      const config = {
        sourceFolder,
        targetFolder: path.join(sourceFolder, "_out"),
        verbose: false,
        plugins: [{
          name: "test-plugin",
          processors: [
            {
              extensions: [".bin"],
              format: "buffer",
              writeFile: () => ({ data: "" }),
              readFile() {
                bufferReadCalls++
                return { abstract: {}, metadata: { kind: "photo" } }
              }
            },
            {
              extensions: [".md"],
              format: "text",
              writeFile: () => ({ data: "" }),
              readURL: (data) => ({ fetched: data }),
              readFile(text) {
                return {
                  abstract: {},
                  metadata: {},
                  urls: [{ data: text.trim(), runner: "text", target: "page.html", extension: ".md" }]
                }
              }
            }
          ]
        }]
      }

      const queue = await bundler(config)
      const first = await queue()

      // Neither the buffer nor the URL a plugin claims should have run yet.
      assert.equal(bufferReadCalls, 0)
      assert.equal(fetchServerHits, 0)
      assert.equal(typeof first.runBuffers, "function")
      assert.equal(typeof first.runFetches, "function")

      await first.runBuffers()
      assert.equal(bufferReadCalls, 1)

      await first.runFetches()
      assert.equal(fetchServerHits, 1)
    })
  } finally {
    await close()
  }
})

test("bundle: runFetches auto-triggers a rebuild that picks up the newly-staled target", async () => {
  const { baseUrl, close } = await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("fetched-data")
  })

  try {
    await withTempSourceFolder(async (sourceFolder) => {
      await writeFile(path.join(sourceFolder, "page.md"), `${baseUrl}/asset`)

      let writeFileCalls = 0

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
            writeFile: () => { writeFileCalls++; return { data: "" } },
            readURL: (data) => ({ fetched: data }),
            readFile(text) {
              return {
                abstract: { type: "page" },
                metadata: {},
                urls: [{ data: text.trim(), runner: "text", target: "page.html", extension: ".md" }]
              }
            }
          }]
        }]
      }

      const queue = await bundler(config)
      const first = await queue()

      // The first build already wrote page.html once, without the URL's
      // data (the fetch was deferred).
      assert.equal(writeFileCalls, 1)
      assert.equal(first.cache.target.get("page.html").metadata.fetched, undefined)

      // Running the deferred fetch should mark page.html stale again (see
      // queries.url.create) and, via the auto-chained rebuild, write it a
      // second time - this time it should have nothing further to fetch.
      await first.runFetches()

      assert.equal(writeFileCalls, 2)
    })
  } finally {
    await close()
  }
})

test("bundle: runBuffers auto-triggers a rebuild that writes the newly-created buffer target", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

    let writeFileCalls = 0

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "photo", ext: ".html" }),
        processors: [{
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => { writeFileCalls++; return { data: "" } },
          readFile: () => ({ abstract: { kind: "photo" }, metadata: {} })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    // Nothing to write yet - the buffer target doesn't exist until
    // runBuffers() actually creates it.
    assert.equal(writeFileCalls, 0)
    assert.equal(first.cache.target.get("photo.html"), undefined)

    await first.runBuffers()

    // target.create's new-target branch leaves it stale=1; the
    // auto-chained rebuild should have picked that up and written it.
    assert.equal(writeFileCalls, 1)
    assert.deepEqual(first.cache.target.get("photo.html").abstract, { kind: "photo" })
  })
})

test("bundle: a target created via runBuffers() actually reaches the on-disk .votive.db", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "photo", ext: ".html" }),
        processors: [{
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => ({ data: "" }),
          readFile: () => ({ abstract: { kind: "photo" }, metadata: {} })
        }]
      }]
    }

    // No `cache` passed to bundler(), matching the real default: bundle()
    // creates a fresh in-memory database and only backs it up to
    // <sourceFolder>/.votive.db once something worth saving happens.
    const queue = await bundler(config)
    const first = await queue()

    await first.runBuffers()

    // Simulate a separate process reading .votive.db directly (or the
    // next `votive` invocation, which starts from the file on disk, not
    // the in-memory instance that created it) - the previous bug was that
    // this row only ever existed in memory, because saveDB never ran on
    // the pass that actually created it.
    const { DatabaseSync } = await import("node:sqlite")
    const reopened = new DatabaseSync(path.join(sourceFolder, ".votive.db"), { readOnly: true })
    const rows = reopened.prepare("SELECT path FROM targets WHERE path = 'photo.html'").all()
    reopened.close()

    assert.deepEqual(rows.map(r => r.path), ["photo.html"])
  })
})

test("bundle: config.databasePath overrides where .votive.db is written", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.bin"), "binary content")
    const customDbDir = path.join(sourceFolder, "elsewhere")
    await import("node:fs/promises").then(fs => fs.mkdir(customDbDir, { recursive: true }))

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath: path.join(customDbDir, "custom.db"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "photo", ext: ".html" }),
        processors: [{
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => ({ data: "" }),
          readFile: () => ({ abstract: { kind: "photo" }, metadata: {} })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()
    await first.runBuffers()

    const { DatabaseSync } = await import("node:sqlite")
    const reopened = new DatabaseSync(path.join(customDbDir, "custom.db"), { readOnly: true })
    const rows = reopened.prepare("SELECT path FROM targets WHERE path = 'photo.html'").all()
    reopened.close()

    assert.deepEqual(rows.map(r => r.path), ["photo.html"])

    // The default location was never touched.
    await assert.rejects(() => import("node:fs/promises").then(fs => fs.stat(path.join(sourceFolder, ".votive.db"))))
  })
})
