import { test } from "node:test"
import assert from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

async function withTempSourceFolder(run) {
  const sourceFolder = await fs.mkdtemp(path.join(os.tmpdir(), "votive-source-"))
  try {
    return await run(sourceFolder)
  } finally {
    await fs.rm(sourceFolder, { recursive: true, force: true })
  }
}

/**
 * A plugin that records the `source` every readFile call receives, so the
 * contract can be asserted rather than inferred from what it produced.
 */
function recordingPlugin(seen, format = "text") {
  return {
    name: "recorder",
    processors: [{
      router: ({ name, dir }) => ({ name, dir, ext: ".html" }),
      extensions: [format === "text" ? ".md" : ".bin"],
      format,
      readFile(source) {
        seen.push(source)
        return { metadata: {} }
      },
      writeFile: () => ({ data: "" })
    }]
  }
}

test("source: readFile receives project-relative paths, never absolute ones", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await fs.mkdir(path.join(sourceFolder, "blog"), { recursive: true })
    await fs.writeFile(path.join(sourceFolder, "settings.md"), "root")
    await fs.writeFile(path.join(sourceFolder, "blog", "post.md"), "hello")

    const seen = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [recordingPlugin(seen)]
    }

    await (await bundler(config))()

    const paths = seen.map(source => source.path).sort()
    assert.deepEqual(paths, ["blog/post.md", "settings.md"])

    // The whole point: this comparison is the one vowel's markdown plugin
    // makes to find the project's root settings file.
    assert.ok(seen.some(source => source.path === "settings.md"))

    for (const source of seen) {
      assert.ok(!path.isAbsolute(source.path), `${source.path} is absolute`)
      assert.ok(!path.isAbsolute(source.target), `${source.target} is absolute`)
      assert.ok(!source.path.includes(sourceFolder))
    }
  })
})

test("source: target is where routing sent the file", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await fs.mkdir(path.join(sourceFolder, "blog"), { recursive: true })
    await fs.writeFile(path.join(sourceFolder, "blog", "post.md"), "hello")

    const seen = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [recordingPlugin(seen)]
    }

    await (await bundler(config))()

    assert.equal(seen[0].target, path.join("blog", "post.html"))
  })
})

test("source: text carries the contents, and buffer() reads the same bytes", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await fs.writeFile(path.join(sourceFolder, "page.md"), "hello there")

    const seen = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [recordingPlugin(seen)]
    }

    await (await bundler(config))()

    assert.equal(seen[0].text, "hello there")
    assert.equal(seen[0].buffer().toString("utf-8"), "hello there")
  })
})

test("source: a buffer processor gets no text, and reads bytes on demand", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await fs.writeFile(path.join(sourceFolder, "photo.bin"), "raw bytes")

    const seen = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [recordingPlugin(seen, "buffer")]
    }

    const { runBuffers } = await (await bundler(config))()
    assert.equal(seen.length, 0, "a buffer read is deferred, not run during the build")

    await runBuffers()

    assert.equal(seen.length, 1)
    assert.equal(seen[0].text, undefined)
    assert.equal(seen[0].path, "photo.bin")
    assert.equal(seen[0].buffer().toString("utf-8"), "raw bytes")
  })
})

test("source: the same shape reaches both formats", async () => {
  // One hook signature for text and buffer processors is the contract -
  // the earlier split (ReadText vs ReadPath) is what let two checks in
  // one file disagree about what they were being handed.
  await withTempSourceFolder(async (sourceFolder) => {
    await fs.writeFile(path.join(sourceFolder, "page.md"), "text")
    await fs.writeFile(path.join(sourceFolder, "photo.bin"), "bytes")

    const text = []
    const buffers = []
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      plugins: [recordingPlugin(text), recordingPlugin(buffers, "buffer")]
    }

    const { runBuffers } = await (await bundler(config))()
    await runBuffers()

    const shape = source => Object.keys(source).filter(key => key !== "text").sort()
    assert.deepEqual(shape(text[0]), ["buffer", "path", "stream", "target"])
    assert.deepEqual(shape(buffers[0]), ["buffer", "path", "stream", "target"])
  })
})
