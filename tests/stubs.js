import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readFile, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"
import { canonicalParams } from "../lib/stubs.js"
import createDatabase from "../lib/createDatabase.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-stubs-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * A minimal text processor that reads whatever it is handed and writes it
 * straight back out, so a test can watch a stub travel the whole pipeline.
 */
function textProcessor(overrides = {}) {
  return {
    // Reads .md and writes the .html its router produces. In vowel those
    // are two processors; one is enough to exercise the pipeline, and
    // writeTargets matches a write processor on the *target's* extension.
    extensions: [".md", ".html"],
    format: "text",
    router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
    readFile: (source) => ({ data: source.text, metadata: { body: source.text } }),
    writeFile: (target) => ({ data: target.data }),
    ...overrides
  }
}

function configFor(sourceFolder, processors) {
  return {
    sourceFolder,
    targetFolder: path.join(sourceFolder, "_out"),
    cacheDirectory: path.join(sourceFolder, "_cache"),
    verbose: false,
    plugins: [{ name: "stub-plugin", processors }]
  }
}

test("canonicalParams: sorts object keys at every depth and leaves arrays alone", () => {
  assert.equal(canonicalParams({ b: 1, a: 2 }), canonicalParams({ a: 2, b: 1 }))
  assert.equal(
    canonicalParams({ outer: { z: 1, a: { y: 2, b: 3 } } }),
    canonicalParams({ outer: { a: { b: 3, y: 2 }, z: 1 } })
  )
  assert.notEqual(canonicalParams({ list: [1, 2] }), canonicalParams({ list: [2, 1] }))
  assert.equal(canonicalParams(undefined), canonicalParams(null))
})

test("stubs: a declared stub produces a written target", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "404.md" }],
      expand: () => ({ text: "not found" })
    })])

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.equal(await readFile(path.join(sourceFolder, "_out", "404.html"), "utf-8"), "not found")
    assert.equal(site.database.target.get("404.html").metadata.body, "not found")
    await site.close()
  })
})

test("stubs: expand runs once for unchanged params and again when they change", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let expandCalls = 0
    let tag = "foo"

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "tags/page.md", params: { tag } }],
      expand: (stub) => {
        expandCalls++
        return { text: `tag: ${stub.params.tag}` }
      }
    })])

    const site = await bundler(config)
    await (await site.build()).deferred
    assert.equal(expandCalls, 1)

    // Same params: the diff is a string compare and nothing is expanded.
    await (await site.build()).deferred
    await (await site.build()).deferred
    assert.equal(expandCalls, 1)

    tag = "bar"
    await (await site.build()).deferred
    assert.equal(expandCalls, 2)
    assert.equal(await readFile(path.join(sourceFolder, "_out", "tags", "page.html"), "utf-8"), "tag: bar")
    await site.close()
  })
})

test("stubs: params differing only in key order do not re-expand", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let expandCalls = 0
    let flip = false

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{
        path: "a.md",
        // The same params built two different ways, as an enumerator
        // spreading a config object would produce.
        params: flip ? { b: 2, a: 1, nested: { y: 1, x: 0 } } : { a: 1, b: 2, nested: { x: 0, y: 1 } }
      }],
      expand: () => {
        expandCalls++
        return { text: "x" }
      }
    })])

    const site = await bundler(config)
    await (await site.build()).deferred
    flip = true
    await (await site.build()).deferred

    assert.equal(expandCalls, 1)
    await site.close()
  })
})

test("stubs: a stub that stops being declared loses its row, its target and its file", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let declare = true

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => declare ? [{ path: "temporary.md" }] : [],
      expand: () => ({ text: "here" })
    })])

    const site = await bundler(config)
    await (await site.build()).deferred

    const outputPath = path.join(sourceFolder, "_out", "temporary.html")
    assert.equal(await exists(outputPath), true)

    declare = false
    await (await site.build()).deferred

    assert.equal(await exists(outputPath), false, "the output file should be removed")
    assert.equal(site.database.target.get("temporary.html"), undefined, "the target row should be gone")
    assert.equal(site.database.source.get("temporary.md"), undefined, "the source row should be gone")
    await site.close()
  })
})

test("stubs: a real file at the stub's path shadows it, and the stub returns when the file is deleted", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let expandCalls = 0

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "404.md" }],
      expand: () => {
        expandCalls++
        return { text: "default 404" }
      }
    })])

    // The author's own file is there from the start.
    const authored = path.join(sourceFolder, "404.md")
    await writeFile(authored, "my 404")

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.equal(expandCalls, 0, "a shadowed stub is never expanded")
    assert.equal(await readFile(path.join(sourceFolder, "_out", "404.html"), "utf-8"), "my 404")

    // Delete the file: the stub takes over on the next pass.
    await rm(authored)
    await (await site.build()).deferred

    assert.equal(expandCalls, 1)
    assert.equal(await readFile(path.join(sourceFolder, "_out", "404.html"), "utf-8"), "default 404")
    await site.close()
  })
})

test("stubs: two processors declaring one path throw, naming both plugins", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [
        { name: "first-plugin", processors: [textProcessor({ stubs: () => [{ path: "clash.md" }], expand: () => ({ text: "a" }) })] },
        { name: "second-plugin", processors: [textProcessor({ stubs: () => [{ path: "clash.md" }], expand: () => ({ text: "b" }) })] }
      ]
    }

    const site = await bundler(config)
    await assert.rejects(
      () => site.build(),
      (error) => {
        assert.match(error.message, /clash\.md/)
        assert.match(error.message, /first-plugin/)
        assert.match(error.message, /second-plugin/)
        return true
      }
    )
  })
})

test("stubs: enumeration still runs on a pass with no stale source", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    // Nothing on disk at all, so no pass ever has a stale file source.
    // Gating enumeration on one would mean a stub declared later never
    // appears - the failure mode the follow-up build after deferred work
    // would hit.
    let declare = false

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => declare ? [{ path: "late.md" }] : [],
      expand: () => ({ text: "late" })
    })])

    const site = await bundler(config)
    await (await site.build()).deferred
    assert.equal(await exists(path.join(sourceFolder, "_out", "late.html")), false)

    declare = true
    await (await site.build()).deferred

    assert.equal(await exists(path.join(sourceFolder, "_out", "late.html")), true)
    await site.close()
  })
})

test("stubs: the enumerator's api reads register no dependency rows", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "post.md"), "hello")

    const config = configFor(sourceFolder, [textProcessor({
      stubs: ({ api }) => {
        // Every read the enumerator can make.
        api.targets({ recursive: true })
        api.target("post.html")
        api.targetBySource("post.md")
        api.distinct("body")
        return [{ path: "index.md" }]
      },
      expand: () => ({ text: "index" })
    })])

    const site = await bundler(config)
    await (await site.build()).deferred

    const rows = site.database.raw.prepare("SELECT dependent FROM dependencies").all()
    assert.equal(rows.some(row => !row.dependent), false, "no row should have an empty dependent")
    await site.close()
  })
})

test("stubs: a buffer-format stub goes through readBuffers, and changed params miss the cache", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let readCalls = 0
    let version = 1

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      plugins: [{
        name: "stub-plugin",
        processors: [{
          extensions: [".bin"],
          format: "buffer",
          router: ({ name, dir, ext }) => ({ dir, name, ext }),
          stubs: () => [{ path: "asset.bin", params: { version } }],
          expand: (stub) => ({ buffer: Buffer.from(`bytes-v${stub.params.version}`) }),
          readFile: (source) => {
            readCalls++
            return { metadata: { size: source.buffer().length }, data: source.buffer().toString() }
          },
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    const site = await bundler(config)
    // Buffer work is deferred, so this one has to wait for it.
    const first = await site.build()
    await first.deferred

    assert.equal(readCalls, 1)
    assert.equal(await readFile(path.join(sourceFolder, "_out", "asset.bin"), "utf-8"), "bytes-v1")

    version = 2
    const second = await site.build()
    await second.deferred

    assert.equal(readCalls, 2, "changed params must miss the buffer cache")
    assert.equal(await readFile(path.join(sourceFolder, "_out", "asset.bin"), "utf-8"), "bytes-v2")
    await site.close()
  })
})

test("stubs: a re-expanded stub leaves exactly one sources row", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    let n = 0

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "counter.md", params: { n } }],
      expand: (stub) => ({ text: `n=${stub.params.n}` })
    })])

    const site = await bundler(config)
    for (n = 0; n < 4; n++) await (await site.build()).deferred

    const rows = site.database.raw.prepare("SELECT path FROM sources WHERE path = ?").all("counter.md")
    assert.equal(rows.length, 1)
    await site.close()
  })
})

test("stubs: pruneDeletions leaves stub rows alone on a full pass", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "real.md"), "real page")

    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "generated.md" }],
      expand: () => ({ text: "generated" })
    })])

    const site = await bundler(config)
    await (await site.build()).deferred
    // A second full pass is what would prune a row whose file is missing.
    await (await site.build()).deferred

    assert.equal(await exists(path.join(sourceFolder, "_out", "generated.html")), true)
    assert.notEqual(site.database.source.get("generated.md"), undefined)
    await site.close()
  })
})

test("readSources: deleting the last source file in a project still prunes it", async () => {
  // Surfaced by the shadowing test above. Object.groupBy omits the "files"
  // key entirely when nothing matches, and readSources returned early on
  // that - skipping pruneDeletions, so the final source's row and target
  // survived forever. Not stub-specific; a plain project hits it too.
  await withTempSourceFolder(async (sourceFolder) => {
    const onlyPage = path.join(sourceFolder, "only.md")
    await writeFile(onlyPage, "the only page")

    const config = configFor(sourceFolder, [textProcessor()])
    const site = await bundler(config)
    await (await site.build()).deferred

    assert.equal(await exists(path.join(sourceFolder, "_out", "only.html")), true)

    await rm(onlyPage)
    await (await site.build()).deferred

    assert.equal(site.database.source.get("only.md"), undefined, "the source row should be pruned")
    assert.equal(site.database.target.get("only.html"), undefined, "the target row should go with it")
    assert.equal(await exists(path.join(sourceFolder, "_out", "only.html")), false, "and so should the file")
    await site.close()
  })
})

test("source.delete: only deletes a target the source still owns", () => {
  // Two sources can route to one target path. Vowel avoids it by giving
  // its homepage stub the same source path an author would use, so
  // shadowing applies - but the database should not depend on every
  // plugin getting that right. Deleting a source must not take a target
  // that now belongs to someone else.
  const database = createDatabase(":memory:")

  database.target.create({ path: "index.html", metadata: {}, source: "home.md" })
  database.source.create("index.md", "index.html", 0, "null")

  const deleted = database.source.delete("index.md")

  assert.equal(deleted.path, "index.md", "the source row is still removed")
  assert.notEqual(database.target.get("index.html"), undefined, "the target survives - home.md owns it")
})

test("source.delete: still deletes a target the source does own", () => {
  const database = createDatabase(":memory:")

  database.target.create({ path: "generated.html", metadata: {}, source: "generated.md" })
  database.source.create("generated.md", "generated.html", 0, "null")

  database.source.delete("generated.md")

  assert.equal(database.target.get("generated.html"), undefined)
})

test("stubs: a file created at a stub's path takes the row over, and giving it up hands the row back", async () => {
  // The stub is declared unconditionally, so this is the full round trip:
  // stub -> authored file -> stub again. The row has to change kind in
  // both directions, or shadowing never engages and pruning never fires.
  await withTempSourceFolder(async (sourceFolder) => {
    const config = configFor(sourceFolder, [textProcessor({
      stubs: () => [{ path: "home.md" }],
      expand: () => ({ text: "generated" })
    })])

    const site = await bundler(config)
    await site.build()
    assert.equal(await readFile(path.join(sourceFolder, "_out", "home.html"), "utf-8"), "generated")
    assert.notEqual(site.database.source.get("home.md").stub, null)

    await writeFile(path.join(sourceFolder, "home.md"), "authored")
    await site.build()
    assert.equal(await readFile(path.join(sourceFolder, "_out", "home.html"), "utf-8"), "authored")
    assert.equal(site.database.source.get("home.md").stub, null, "the row is a file row now")

    await rm(path.join(sourceFolder, "home.md"))
    await site.build()
    assert.equal(await readFile(path.join(sourceFolder, "_out", "home.html"), "utf-8"), "generated")
    assert.notEqual(site.database.source.get("home.md").stub, null, "and a stub row again")
    await site.close()
  })
})
