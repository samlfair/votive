import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import startServer from "../lib/serve.js"

/**
 * `GET <page>?source` is the read half of the write endpoint: the source
 * file a target was made from, as {path, text}, so an in-page editor can
 * reproduce the whole file - frontmatter it never rendered included -
 * and POST it back to the same path. Loopback only, like handleWrite.
 */
async function withSite(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-source-"))
  let server
  try {
    await writeFile(path.join(sourceFolder, "page.md"), "---\nsecret_key: dog\n---\n\n# Page\n\nBody.\n")
    server = await startServer({
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath: path.join(sourceFolder, ".votive.db"),
      logging: "silent",
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: (info) => ({ dir: info.dir, name: info.name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          readFile: (source, { api }) => {
            // A second target the plugin made up, with no source of its own.
            api.createTarget({ path: "made-up.html", metadata: {} })
            return { data: source.text, metadata: {} }
          },
          writeFile: (target) => ({ data: `<html><body>${target.data ?? ""}</body></html>` })
        }]
      }]
    })
    await run(server, sourceFolder)
  } finally {
    if (server) await server.close()
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

test("?source returns the source file behind a page, path relative to sourceFolder", async () => {
  await withSite(async (server) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/page?source`)
    assert.equal(response.status, 200)
    const { path: sourcePath, text } = await response.json()
    assert.equal(sourcePath, "page.md")
    assert.equal(text, "---\nsecret_key: dog\n---\n\n# Page\n\nBody.\n")
  })
})

test("?source on a target with no source is 404, and on nothing at all is 404", async () => {
  await withSite(async (server) => {
    const madeUp = await fetch(`http://127.0.0.1:${server.port}/made-up?source`)
    assert.equal(madeUp.status, 404)
    assert.match((await madeUp.json()).error, /not made from a source file/)

    const missing = await fetch(`http://127.0.0.1:${server.port}/nowhere?source`)
    assert.equal(missing.status, 404)
  })
})

test("the page itself still serves normally with the query absent", async () => {
  await withSite(async (server) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/page`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /<html>/)
  })
})
