import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

// coerceJSON isn't exported - it's exercised through the metadata read
// path, which is where a null/absent column reaches it.

test("coerceJSON: a target with no metadata reads back as {} instead of throwing", async () => {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-coerce-"))
  try {
    await writeFile(path.join(sourceFolder, "a.md"), "hello")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          // No `metadata` key at all: the column stays null, and the read
          // path used to call JSON.parse(undefined), which throws
          // `"undefined" is not valid JSON`.
          readFile: (source) => ({ data: source.text }),
          writeFile: (target) => ({ data: target.data ?? "" })
        }]
      }]
    }

    const site = await bundler(config)
    const result = await site.build({ defer: false })

    const target = site.database.target.get("a.html")
    assert.ok(target)
    assert.deepEqual(target.metadata, {})
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
})
