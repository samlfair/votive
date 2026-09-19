import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"
import createDatabase from "../lib/createDatabase.js"
import writeTargets from "../lib/writeTargets.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-writeorder-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/** @param {number} ms */
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A page and a listing that depends on every page's data, as a feed
 * does. The listing's write is slow, the page's is not.
 */
function configFor(sourceFolder, order) {
  return {
    sourceFolder,
    targetFolder: path.join(sourceFolder, "_out"),
    verbose: false,
    plugins: [{
      name: "test-plugin",
      processors: [{
        router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
        extensions: [".md", ".html"],
        format: "text",
        createStubs: () => [{ path: "listing.md" }],
        expandStubs: () => ({ text: "" }),
        readFile: (source) => ({ data: source.text, metadata: {} }),
        writeFile: async (target, { api }) => {
          if (target.path === "listing.html") {
            const bodies = api.targets({ folder: "", recursive: true }).filter(t => t.path !== "listing.html").map(t => t.data)
            await wait(60)
            order.push(target.path)
            return { data: bodies.join("|") }
          }
          order.push(target.path)
          return { data: target.data }
        }
      }]
    }]
  }
}

test("writeTargets: the edited source's own targets are written before its dependents", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "v1")
    await writeFile(path.join(sourceFolder, "other.md"), "o1")
    const order = []
    const site = await bundler(configFor(sourceFolder, order))
    await (await site.build()).deferred

    // Editing page.md stales page.html and, through its data, the
    // listing. The page lands first, whatever the listing costs.
    order.length = 0
    await writeFile(path.join(sourceFolder, "page.md"), "v2")
    await (await site.build({ changed: ["page.md"] })).deferred

    assert.deepEqual(order, ["page.html", "listing.html"])
    assert.equal(await readFile(path.join(sourceFolder, "_out", "page.html"), "utf8"), "v2")
    assert.equal(await readFile(path.join(sourceFolder, "_out", "listing.html"), "utf8"), "o1|v2")
  })
})

test("writeTargets: dependents yield to a waiting build and are written by the pass it starts", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "v1")
    await writeFile(path.join(sourceFolder, "other.md"), "o1")
    const order = []
    const site = await bundler(configFor(sourceFolder, order))
    await (await site.build()).deferred

    // A second edit is already waiting when the first pass reaches its
    // writes (build() marks the queue synchronously). The first pass
    // writes its page and leaves the listing; the trailing pass writes
    // its own page, then the listing - once, with both edits in it.
    order.length = 0
    await writeFile(path.join(sourceFolder, "page.md"), "v2")
    await writeFile(path.join(sourceFolder, "other.md"), "o2")
    const first = site.build({ changed: ["page.md"] })
    const second = site.build({ changed: ["other.md"] })
    await Promise.all([first, second].map(build => build.then(result => result.deferred)))

    assert.deepEqual(order, ["page.html", "other.html", "listing.html"])
    assert.equal(await readFile(path.join(sourceFolder, "_out", "listing.html"), "utf8"), "o2|v2")
    assert.equal(site.database.target.getStale().length, 0)
  })
})

test("writeTargets: with shouldYield true from the start, only the edited source's targets are written and the rest stay stale", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", source: "page.md", data: "p" })
    database.target.create({ path: "listing.html", source: "listing.md", data: "l" })
    const order = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [{ name: "t", processors: [{ extensions: [".html"], format: "text", writeFile: (target) => { order.push(target.path); return { data: target.data } } }] }]
    }

    await writeTargets(config, database, { first: ["page.md"], shouldYield: () => true })

    assert.deepEqual(order, ["page.html"])
    assert.deepEqual(database.target.getStale().map(t => t.path), ["listing.html"])
  })
})

test("writeTargets: a target restaled by another write in the same pass is written again before the pass ends", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    // The listing's row is created before the page's, so the cold pass
    // writes it first; the page's write then stores its data, which
    // stales the listing. The pass must not end with it stale.
    await writeFile(path.join(sourceFolder, "a-listing.md"), "")
    await writeFile(path.join(sourceFolder, "b-page.md"), "v1")
    const order = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: ({ name, dir }) => ({ dir, name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target, { api }) => {
            order.push(target.path)
            if (target.path !== "a-listing.html") return { data: `<p>${target.data}</p>` }
            return { data: api.targets({ folder: "", recursive: true }).filter(t => t.path === "b-page.html").map(t => t.data).join("") }
          }
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.deepEqual(site.database.target.getStale(), [])
    assert.equal(await readFile(path.join(sourceFolder, "_out", "a-listing.html"), "utf8"), "<p>v1</p>")
    assert.equal(order.filter(p => p === "a-listing.html").length, 2, "written, restaled by the page, written again")
  })
})
