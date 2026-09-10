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

test("transformTargets: a transformFile processor's result persists to the target", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

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
          writeFile: () => ({ data: "" }),
          readFile: () => ({ data: "content", metadata: { tag: "p" } }),
          transformFile: (target) => ({ metadata: { ...target.metadata, transformed: "yes" } })
        }]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    assert.deepEqual(first.database.target.get("page.html").metadata, {
      tag: "p",
      transformed: "yes"
    })
  })
})

test("transformTargets: multiple transformer processors chain, each seeing the previous one's output", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [
          {
            router: () => ({ dir: [], name: "page", ext: ".html" }),
            extensions: [".md", ".html"],
            format: "text",
            writeFile: () => ({ data: "" }),
            readFile: () => ({ data: "content", metadata: { steps: [] } }),
            transformFile: (target) => ({ metadata: { steps: [...target.metadata.steps, "first"] } })
          },
          {
            extensions: [".md", ".html"],
            format: "text",
            transformFile: (target) => ({ metadata: { steps: [...target.metadata.steps, "second"] } })
          }
        ]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    assert.deepEqual(first.database.target.get("page.html").metadata.steps, ["first", "second"])
  })
})

test("transformTargets: a transformFile hook can still queue urls alongside transforming the target", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

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
          writeFile: () => ({ data: "" }),
          readFile: () => ({ data: "content", metadata: { scanned: "no" } }),
          transformFile: () => ({
            metadata: { scanned: "yes" },
            urls: [{ url: "https://example.com", target: "page.html" }]
          })
        }]
      }]
    }

    const site = await bundler(config)
    const first = await site.build({ defer: false })

    assert.deepEqual(first.database.target.get("page.html").metadata, { scanned: "yes" })
  })
})
