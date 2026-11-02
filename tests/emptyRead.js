import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/**
 * A read that returns nothing makes nothing, on every pass: what the
 * source made before - its target, the targets it owned, its settings -
 * goes, as when the source is deleted. A page switched to a draft is
 * the case; its target used to stay until the cache was reset.
 */

async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-empty-read-"))
  try { await run(sourceFolder) } finally { await rm(sourceFolder, { recursive: true, force: true }) }
}

const exists = (file) => stat(file).then(() => true).catch(() => false)

/** A .page whose text starts with "draft" is read as nothing. */
const pageProcessor = {
  extensions: [".page", ".html", ".extra"],
  format: "text",
  router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
  readFile: (source) => {
    if (source.text.startsWith("draft")) return
    return {
      data: source.text,
      settings: { tone: "plain" },
      targets: [{ path: `${path.basename(source.path, ".page")}.extra`, data: "extra" }]
    }
  },
  writeFile: (target) => ({ data: target.data })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test("empty read: a source read as nothing loses its target, owned targets, files and settings; read again, they return", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const out = (file) => path.join(sourceFolder, "_out", file)
    const site = await bundler({
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      plugins: [{ name: "pages", processors: [pageProcessor] }]
    })

    await writeFile(path.join(sourceFolder, "post.page"), "hello\n")
    await (await site.build()).deferred
    assert.equal(await exists(out("post.html")), true)
    assert.equal(await exists(out("post.extra")), true)
    assert.deepEqual(site.database.setting.getByFolder("").tone, [["plain"]])

    await tick()
    await writeFile(path.join(sourceFolder, "post.page"), "draft\n")
    await (await site.build({ changed: ["post.page"] })).deferred
    assert.equal(site.database.target.get("post.html"), undefined, "the routed target's row is gone")
    assert.equal(site.database.target.get("post.extra"), undefined, "and the owned one's")
    assert.equal(await exists(out("post.html")), false, "and their files")
    assert.equal(await exists(out("post.extra")), false)
    assert.equal(site.database.setting.getByFolder("").tone, undefined, "and its settings")

    await tick()
    await writeFile(path.join(sourceFolder, "post.page"), "hello again\n")
    await (await site.build({ changed: ["post.page"] })).deferred
    assert.equal(site.database.target.get("post.html").data, "hello again\n")
    assert.equal(await exists(out("post.extra")), true)
    await site.close()
  })
})
