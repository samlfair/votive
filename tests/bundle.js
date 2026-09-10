import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises"
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

test("bundle: throws when sourceFolder is relative instead of silently resolving against cwd", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const config = {
      sourceFolder: path.relative(process.cwd(), sourceFolder),
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [],
    }

    const queue = await bundler(config)
    await assert.rejects(() => queue(), /sourceFolder must be an absolute/)
  })
})

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
                return { metadata: { kind: "photo" } }
              }
            },
            {
              extensions: [".md"],
              format: "text",
              writeFile: () => ({ data: "" }),
              readURL: (data) => ({ fetched: data }),
              readFile(source) {
                return {
                                    metadata: {},
                  urls: [{ url: source.text.trim(), target: "page.html", extension: ".md" }]
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
          processors: [{
            router: () => ({ dir: [], name: "page", ext: ".html" }),
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => { writeFileCalls++; return { data: "" } },
            readURL: (data) => ({ fetched: data }),
            readFile(source) {
              return {
                data: "page",
                metadata: {},
                urls: [{ url: source.text.trim(), target: "page.html", extension: ".md" }]
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
        processors: [{
          router: () => ({ dir: [], name: "photo", ext: ".html" }),
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => { writeFileCalls++; return { data: "" } },
          readFile: () => ({ metadata: { kind: "photo" } })
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
    assert.deepEqual(first.cache.target.get("photo.html").metadata, { kind: "photo" })
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
        processors: [{
          router: () => ({ dir: [], name: "photo", ext: ".html" }),
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => ({ data: "" }),
          readFile: () => ({ metadata: { kind: "photo" } })
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
        processors: [{
          router: () => ({ dir: [], name: "photo", ext: ".html" }),
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: () => ({ data: "" }),
          readFile: () => ({ metadata: { kind: "photo" } })
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

test("bundle: a plugin with no processors at all doesn't crash the build", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [
        // No `processors` at all - plugin.processors && plugin.processors.map(...)
        // short-circuits to a bare `undefined`, which flatMap doesn't drop the
        // way it drops an empty array, so this used to leave `undefined` as a
        // literal entry in the flattened processors list.
        { name: "no-op-plugin" },
        {
          name: "test-plugin",
          processors: [{
            router: () => ({ dir: [], name: "page", ext: ".html" }),
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => ({ data: "" }),
            readFile: () => ({ metadata: {} })
          }]
        }
      ]
    }

    const queue = await bundler(config)
    const { cache } = await queue()

    assert.ok(cache.target.get("page.html"))
  })
})

test("bundle: an existing on-disk database is opened in WAL mode and each build is one transaction", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "first")

    const databasePath = path.join(sourceFolder, ".votive.db")
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath,
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    // First run: no database on disk, so this builds in memory and
    // saveDB() writes .votive.db at the end.
    const first = await bundler(config)
    await first()

    // Second bundler() opens that file. This is the path the dev server
    // and the desktop app always take, and the one the pragmas are for.
    await writeFile(path.join(sourceFolder, "a.md"), "second")
    const second = await bundler(config)
    const result = await second()

    // `cache` is the database; entry-point-api.md renames it to `database`.
    assert.equal(typeof result.cache, "object")

    const { DatabaseSync } = await import("node:sqlite")
    const reopened = new DatabaseSync(databasePath, { readOnly: true })
    const [{ journal_mode: mode }] = reopened.prepare("PRAGMA journal_mode").all()
    reopened.close()

    assert.equal(mode.toLowerCase(), "wal")
  })
})

test("bundle: a writeFile that throws rolls the build back, leaving the database as it was", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "first")

    const databasePath = path.join(sourceFolder, ".votive.db")
    /** @type {boolean} */
    let explode = false

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath,
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => {
            if (explode) throw new Error("plugin exploded")
            return { data: target.abstract?.text ?? "" }
          }
        }]
      }]
    }

    const first = await bundler(config)
    await first()

    const { DatabaseSync } = await import("node:sqlite")
    const countRows = () => {
      const reopened = new DatabaseSync(databasePath, { readOnly: true })
      const [{ n }] = reopened.prepare("SELECT COUNT(*) AS n FROM targets").all()
      reopened.close()
      return n
    }
    const before = countRows()

    // A new source file plus a throwing writeFile: without the rollback,
    // b's target row would survive the failed build.
    await writeFile(path.join(sourceFolder, "b.md"), "second")
    explode = true

    const second = await bundler(config)
    await assert.rejects(() => second(), /plugin exploded/)

    assert.equal(countRows(), before)
  })
})

test("hooks: a readFolder that returns {} doesn't crash the build", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          // The whole point: no urls, no targets, no settings.
          readFolder: () => ({}),
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    const step = await bundler(config)
    await step()
  })
})

test("hooks: a readFolder that returns nothing at all doesn't crash the build", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          readFolder: () => undefined,
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    const step = await bundler(config)
    await step()
  })
})

test("hooks: a readFolder returning urls but no targets still has its urls fetched", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    // A *subfolder*, deliberately: the root branch always pushed its urls,
    // but the per-folder branch only returned them when `targets` was also
    // truthy, so a readFolder producing urls alone had them dropped.
    await mkdir(path.join(sourceFolder, "blog"))
    await writeFile(path.join(sourceFolder, "blog", "a.md"), "hello")

    /** @type {string[]} */
    const fetched = []
    const server = await withServer((req, res) => {
      fetched.push(req.url)
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
    })

    try {
      const config = {
        sourceFolder,
        targetFolder: path.join(sourceFolder, "_out"),
        verbose: false,
        plugins: [{
          name: "test-plugin",
          processors: [{
            router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
            extensions: [".md", ".html"],
            format: "text",
            readFile: (source) => ({ data: source.text, metadata: {} }),
            // urls, deliberately with no `targets` alongside them.
            // Note the trailing slash: readFolder receives "blog/", not "blog".
            readFolder: ({ path: folderPath }) =>
              folderPath.startsWith("blog") ? { urls: [{ url: `${server.baseUrl}/from-folder` }] } : {},
            readURL: async (response) => ({ body: await response.text() }),
            writeFile: (target) => ({ data: target.data ?? "" })
          }]
        }]
      }

      const step = await bundler(config)
      const result = await step()
      if (result.runFetches) await result.runFetches()

      assert.deepEqual(fetched, ["/from-folder"])
    } finally {
      await server.close()
    }
  })
})

test("hooks: a writeFile returning nothing leaves the target alone instead of deleting it", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          // No return at all - used to mean "delete this target".
          writeFile: () => undefined
        }]
      }]
    }

    const step = await bundler(config)
    const result = await step()

    assert.ok(result.cache.target.get("a.html"), "the target row should survive a writeFile that returns nothing")
  })
})

test("hooks: a writeFile returning { delete: true } removes the target and its file", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    /** @type {boolean} */
    let remove = false
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => remove ? { delete: true } : { data: target.abstract?.text ?? "" }
        }]
      }]
    }

    const step = await bundler(config)
    const first = await step()
    assert.ok(first.cache.target.get("a.html"))

    // Force another write pass over the same target, this time deleting.
    remove = true
    first.cache.target.markStale("a.html")
    const second = await step()

    assert.equal(second.cache.target.get("a.html"), undefined)
  })
})

test("hooks: a target whose output is an empty string is written and marked fresh", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: () => ({ data: "" })
        }]
      }]
    }

    const step = await bundler(config)
    const result = await step()

    // Written despite being empty...
    const written = await readFile(path.join(sourceFolder, "_out", "a.html"), "utf-8")
    assert.equal(written, "")

    // ...and marked fresh, so it isn't rebuilt forever.
    assert.deepEqual(result.cache.target.getStale().map(t => t.path), [])
  })
})

test("hooks: every hook's context is exactly { api, settings, config }, and readFile's settings is undefined", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    /** @type {Record<string, string[]>} */
    const seen = {}
    const record = (hook) => (subject, context) => {
      seen[hook] = Object.keys(context).sort()
      if (hook === "readFile") seen.readFileSettings = context.settings === undefined
      return hook === "writeFile" ? { data: "x" } : undefined
    }

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source, context) => { record("readFile")(source, context); return { data: source.text, metadata: {} } },
          transformFile: record("transformFile"),
          readFolder: record("readFolder"),
          writeFile: record("writeFile")
        }]
      }]
    }

    const step = await bundler(config)
    await step()

    for (const hook of ["readFile", "transformFile", "readFolder", "writeFile"]) {
      assert.deepEqual(seen[hook], ["api", "config", "settings"], `${hook} context keys`)
    }
    assert.equal(seen.readFileSettings, true, "readFile's settings is undefined")
  })
})

test("hooks: an object-valued metadata key re-created with an equal value does not stale its dependents", async () => {
  const createDatabase = (await import("../lib/createDatabase.js")).default
  const database = createDatabase(":memory:")

  database.target.create({ path: "page.html", metadata: { author: { name: "Sam" } } })
  database.target.create({ path: "reader.html", metadata: {} })

  // Reading a property through the tracking getter is what registers the
  // dependency - there is no separate create call.
  const tracked = database.target.getWithTrackers("page.html", "reader.html")
  void tracked.metadata.author
  database.target.markFresh("reader.html")

  // A deep-equal but distinct object. Reference inequality used to make
  // this look changed on every read, restaling every dependent - which
  // would now hit hastAbstract on every markdown page on every pass.
  database.target.create({ path: "page.html", metadata: { author: { name: "Sam" } } })

  const stale = database.target.getStale().map(target => target.path)
  assert.ok(!stale.includes("reader.html"), `reader.html should not be stale, got ${stale.join(", ")}`)
})

test("hooks: a metadata key set to 0, false or empty string is not deleted", async () => {
  const createDatabase = (await import("../lib/createDatabase.js")).default
  const database = createDatabase(":memory:")

  database.target.create({ path: "page.html", metadata: { count: 5, flag: "yes", note: "hi" } })
  // The deletion check was `if (!target.metadata[key])`, so a falsy new
  // value looked like an absent key.
  database.target.create({ path: "page.html", metadata: { count: 0, flag: "", note: "hi" } })

  const metadata = database.target.get("page.html").metadata
  assert.equal(metadata.count, 0)
  assert.equal(metadata.flag, "")
  assert.equal(metadata.note, "hi")
})

test("hooks: target.get() returns a target whose data is null", async () => {
  const createDatabase = (await import("../lib/createDatabase.js")).default
  const database = createDatabase(":memory:")

  // A copy-through target (image, font) has no data at all. The old
  // `if (!abstract) return` guard made target.get() return undefined here.
  database.target.create({ path: "photo.jpg", metadata: { uuid: "abc" }, source: "photo.jpg" })

  const target = database.target.get("photo.jpg")
  assert.ok(target, "a target with no data is still a target")
  assert.equal(target.data, null)
  assert.deepEqual(target.metadata, { uuid: "abc" })
})

test("hooks: a second build after a clean one writes nothing (the data write-back doesn't loop)", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    let writes = 0
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => { writes++; return { data: `<p>${target.data}</p>` } }
        }]
      }]
    }

    const step = await bundler(config)
    await step()
    const afterFirst = writes

    // writeTargets stores what writeFile produced back onto the target.
    // Routed through target.create() that would mark the target stale
    // again, and every build would rewrite every page forever.
    await step()
    assert.equal(writes, afterFirst, "the second build should write nothing")
  })
})

test("hooks: a readURL that never reads the body leaves it unread", async () => {
  const database = (await import("../lib/createDatabase.js")).default(":memory:")
  const fetchURLs = (await import("../lib/fetchURLs.js")).default

  let bodyRead = false
  const server = await withServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("a body nobody wanted")
  })

  try {
    // Only the headers are touched. The body methods are lazy, which is
    // the boundary the old `runner` name on the task tried to express
    // before anyone had seen the response.
    const readURL = (response) => {
      bodyRead = false
      return { status: response.status }
    }
    const request = { task: { url: `${server.baseUrl}/x` }, processor: { readURL } }

    const { runFetches } = await fetchURLs([request], { plugins: [] }, database)
    await runFetches()

    assert.equal(bodyRead, false)
    assert.deepEqual(database.url.get(`${server.baseUrl}/x`), { status: 200 })
  } finally {
    await server.close()
  }
})
