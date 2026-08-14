import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-settings-scope-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("readSources: a settings contribution is scoped to the source file's own folder, not its (possibly nonexistent) target's folder", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await mkdir(path.join(sourceFolder, "shop"), { recursive: true })
    await writeFile(path.join(sourceFolder, "settings.md"), "root settings")
    await writeFile(path.join(sourceFolder, "shop", "settings.md"), "shop settings")
    await writeFile(path.join(sourceFolder, "shop", "page.md"), "a real page")

    const config = {
      sourceFolder,
      destinationFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        // Mirrors vowel's markdown plugin: a file named "settings" routes
        // to no real target (router returns false), while everything
        // else keeps its folder.
        router: ({ name, dir }) => name === "settings" ? false : { dir, name, ext: ".html" },
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => ({ data: "" }),
          readFile: (text, filePath) => {
            const isSettings = path.basename(filePath) === "settings.md"
            return {
              abstract: {},
              metadata: {},
              settings: isSettings ? { title: text } : undefined
            }
          }
        }]
      }]
    }

    const queue = await bundler(config)
    const first = await queue()

    const rootSettings = first.cache.setting.getByFolder("")
    const shopSettings = first.cache.setting.getByFolder("shop")

    assert.deepEqual(rootSettings.title[0], ["root settings"])
    assert.deepEqual(shopSettings.title[0], ["root settings"]) // still visible via the ancestor chain
    assert.deepEqual(shopSettings.title[1], ["shop settings"]) // shop's own row, not mixed with root's
  })
})
