import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-transform-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("readAbstracts: a transformFile processor's result persists to the target's abstract", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

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
          writeFile: () => ({ data: "" }),
          readFile: () => ({ abstract: { tag: "p", children: [] }, metadata: {} }),
          transformFile: (abstract) => ({ abstract: { ...abstract, transformed: true } })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.deepEqual(first.cache.target.get("page.html").abstract, {
      tag: "p",
      children: [],
      transformed: true
    })
  })
})

test("readAbstracts: multiple transformer processors chain, each seeing the previous one's output", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: () => ({ dir: [], name: "page", ext: ".html" }),
        processors: [
          {
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => ({ data: "" }),
            readFile: () => ({ abstract: { steps: [] }, metadata: {} }),
            transformFile: (abstract) => ({ abstract: { steps: [...abstract.steps, "first"] } })
          },
          {
            extensions: [".md", ".html"],
            format: "text",
            transformFile: (abstract) => ({ abstract: { steps: [...abstract.steps, "second"] } })
          }
        ]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.deepEqual(first.cache.target.get("page.html").abstract.steps, ["first", "second"])
  })
})

test("readAbstracts: a transformFile hook can still queue jobs alongside transforming the abstract", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

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
          writeFile: () => ({ data: "" }),
          readFile: () => ({ abstract: { scanned: false }, metadata: {} }),
          transformFile: (abstract) => ({
            abstract: { scanned: true },
            urls: [{ data: "https://example.com", runner: "text", target: "page.html" }]
          })
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    assert.deepEqual(first.cache.target.get("page.html").abstract, { scanned: true })
  })
})
