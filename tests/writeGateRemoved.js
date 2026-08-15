import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-writegate-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("writeDestinations: a target with an empty abstract is still written - the plugin decides, not a generic gate", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "trigger.md"), "content")

    const config = {
      sourceFolder,
      destinationFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        router: ({ name, dir }) => name === "trigger" ? { dir: [], name: "trigger", ext: ".html" } : false,
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          readFile: (text, filePath, destinationPath, settings, api) => {
            // Deliberately empty abstract, matching the shape a
            // dispatch-by-path writer (like xml/index.js's sitemap/feed
            // targets) uses today - it never reads `abstract` at all.
            api.createTarget({ path: "always-written.html", abstract: {}, metadata: {} })
            return { abstract: {}, metadata: {} }
          },
          writeFile: (destination) => ({ data: `written:${destination.path}` })
        }]
      }]
    }

    const queue = await bundler(config)
    await queue()

    const triggerContent = await readFile(path.join(config.destinationFolder, "trigger.html"), "utf-8")
    const alwaysContent = await readFile(path.join(config.destinationFolder, "always-written.html"), "utf-8")

    assert.equal(triggerContent, "written:trigger.html")
    assert.equal(alwaysContent, "written:always-written.html")
  })
})
