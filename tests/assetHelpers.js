import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-assets-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("target.create records the source file path on a newly-created target", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "doc.pdf"), "raw-pdf-bytes")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "doc", ext: ".pdf" }),
          extensions: [".pdf"],
          format: "buffer",
          writeFile: (target) => ({ data: target.buffer() }),
          readFile: () => ({ metadata: { kind: "pdf" } })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred

    const target = site.database.target.get("doc.pdf")
    assert.equal(target.source, "doc.pdf")
  })
})

test("writeFile's target.buffer() reads the source file's raw bytes", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "doc.pdf"), "raw-pdf-bytes")

    let writtenBuffer

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "doc", ext: ".pdf" }),
          extensions: [".pdf"],
          format: "buffer",
          writeFile: (target) => {
            writtenBuffer = target.buffer()
            return { data: writtenBuffer }
          },
          readFile: () => ({ metadata: { kind: "pdf" } })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.equal(writtenBuffer.toString(), "raw-pdf-bytes")

    const written = await import("node:fs/promises").then(fs =>
      fs.readFile(path.join(sourceFolder, "_out", "doc.pdf"))
    )
    assert.equal(written.toString(), "raw-pdf-bytes")
  })
})

test("writeFile's target.stream() opens a readable stream over the source file", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "movie.mp4"), "raw-video-bytes")

    let streamedChunks = []

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "movie", ext: ".mp4" }),
          extensions: [".mp4"],
          format: "buffer",
          writeFile: async (target) => {
            for await (const chunk of target.stream()) streamedChunks.push(chunk)
            return { data: Buffer.concat(streamedChunks) }
          },
          readFile: () => ({ metadata: { kind: "video" } })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.equal(Buffer.concat(streamedChunks).toString(), "raw-video-bytes")
  })
})
