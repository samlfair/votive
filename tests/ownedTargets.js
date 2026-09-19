import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/**
 * A read may return `targets`: the source's owned targets beside its
 * routed one. Each is stored with the source as its owner, so at write
 * its buffer() reads the owner's file, and the read replaces the set it
 * owns - what it stops returning is deleted with its file, and a deleted
 * source takes everything it owned.
 */

async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-owned-"))
  try { await run(sourceFolder) } finally { await rm(sourceFolder, { recursive: true, force: true }) }
}

const exists = (file) => stat(file).then(() => true).catch(() => false)

/** A "picture" processor: a .pic source owns one .small and one .big, each written from the owner's bytes. */
function pictureProcessor(sizes) {
  return {
    extensions: [".pic", ".small", ".big"],
    format: "buffer",
    router: ({ dir, name, ext }) => ({ dir, name, ext }),
    readFile: (source) => {
      const stamp = source.buffer().toString().trim()
      return {
        metadata: { stamp },
        targets: sizes().map(size => ({ path: `${path.basename(source.path, ".pic")}-${stamp}.${size}`, metadata: { derivative: { size } } }))
      }
    },
    writeFile: (target) => {
      const bytes = target.buffer()
      if (!target.metadata.derivative) return { data: bytes }
      return { data: Buffer.from(`${target.metadata.derivative.size}:${bytes.toString().trim()}`) }
    }
  }
}

function configFor(sourceFolder, processor) {
  return {
    sourceFolder,
    targetFolder: path.join(sourceFolder, "_out"),
    cacheDirectory: path.join(sourceFolder, "_cache"),
    verbose: false,
    plugins: [{ name: "pictures", processors: [processor] }]
  }
}

test("owned targets: created with the source as owner, written from the owner's bytes, in the read's own pass", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.pic"), "v1\n")
    const site = await bundler(configFor(sourceFolder, pictureProcessor(() => ["small", "big"])))
    await (await site.build()).deferred

    for (const [file, content] of [["photo.pic", "v1\n"], ["photo-v1.small", "small:v1"], ["photo-v1.big", "big:v1"]]) {
      assert.equal(await readFile(path.join(sourceFolder, "_out", file), "utf-8"), content, file)
    }
    for (const rel of ["photo-v1.small", "photo-v1.big"]) {
      assert.equal(site.database.target.get(rel).source, "photo.pic", `${rel} is owned by photo.pic`)
    }
    assert.deepEqual(site.database.target.ownedBy("photo.pic").sort(), ["photo-v1.big", "photo-v1.small", "photo.pic"])
    assert.equal(site.database.target.getBySource("photo.pic").path, "photo.pic", "targetBySource is still the routed one")
    assert.equal(site.database.raw.prepare("SELECT COUNT(*) AS n FROM sources").get().n, 1, "owned targets are not sources")
    await site.close()
  })
})

test("owned targets: a re-read replaces the set - what it no longer returns is deleted, row and file", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.pic"), "v1\n")
    let sizes = ["small", "big"]
    const site = await bundler(configFor(sourceFolder, pictureProcessor(() => sizes)))
    await (await site.build()).deferred
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo-v1.big")), true)

    // The bytes change: a new stamp, a new set; the old set goes.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(path.join(sourceFolder, "photo.pic"), "v2\n")
    await (await site.build()).deferred
    assert.equal(await readFile(path.join(sourceFolder, "_out", "photo-v2.small"), "utf-8"), "small:v2")
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo-v1.small")), false, "the old derivative's file is gone")
    assert.equal(site.database.target.get("photo-v1.small"), undefined, "and its row")

    // The read returns fewer: the one it dropped goes.
    sizes = ["small"]
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(path.join(sourceFolder, "photo.pic"), "v3\n")
    await (await site.build()).deferred
    assert.deepEqual(site.database.target.ownedBy("photo.pic").sort(), ["photo-v3.small", "photo.pic"])
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo-v3.big")), false)
    await site.close()
  })
})

test("owned targets: deleting the source takes everything it owned; a warm start keeps them", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.pic"), "v1\n")
    const config = { ...configFor(sourceFolder, pictureProcessor(() => ["small"])), databasePath: path.join(sourceFolder, "_db.sqlite") }
    let site = await bundler(config)
    await (await site.build()).deferred
    await site.close()

    // A second launch: nothing is stale, nothing is rewritten, the file stays.
    site = await bundler(config)
    await (await site.build()).deferred
    assert.equal(site.database.raw.prepare("SELECT COUNT(*) AS n FROM targets WHERE stale = 1").get().n, 0)
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo-v1.small")), true)

    await rm(path.join(sourceFolder, "photo.pic"))
    await (await site.build()).deferred
    assert.equal(site.database.target.get("photo-v1.small"), undefined)
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo-v1.small")), false)
    assert.equal(await exists(path.join(sourceFolder, "_out", "photo.pic")), false)
    await site.close()
  })
})

test("owned targets: a path another source produces is a conflict that names both", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "a.pic"), "same\n")
    await writeFile(path.join(sourceFolder, "b.pic"), "same\n")
    const processor = pictureProcessor(() => ["small"])
    // Both reads return "shared.small".
    processor.readFile = (source) => ({ metadata: {}, targets: [{ path: "shared.small", metadata: { derivative: { size: "small" } } }] })
    const site = await bundler(configFor(sourceFolder, processor))
    await assert.rejects(async () => { await (await site.build()).deferred }, /shared\.small.*already produces/s)
    await site.close()
  })
})

test("owned targets: a transform's merged result does not touch the owned set", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "photo.pic"), "v1\n")
    // A text-format variant: transforms run over the pass's read sources,
    // and a buffer read is deferred past that stage.
    const processor = { ...pictureProcessor(() => ["small"]), format: "text" }
    processor.readFile = (source) => ({ metadata: { stamp: source.text.trim() }, targets: [{ path: `photo-${source.text.trim()}.small`, metadata: { derivative: { size: "small" } } }] })
    processor.transformFile = () => ({ metadata: { transformed: true } })
    const site = await bundler(configFor(sourceFolder, processor))
    await (await site.build()).deferred
    assert.equal(site.database.target.get("photo.pic").metadata.transformed, true)
    assert.ok(site.database.target.get("photo-v1.small"), "still owned after the transform")
    await site.close()
  })
})
