import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import startServer from "../lib/serve.js"

test("serve: a url with no extension is a page unless a file exists at exactly that path, served as text", async () => {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-exact-"))
  let server
  try {
    await writeFile(path.join(sourceFolder, "about.md"), "about")
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath: path.join(sourceFolder, ".votive.db"),
      logging: "silent",
      plugins: [{
        name: "test-plugin",
        processors: [{
          // Extension-less sources route to extension-less targets, under
          // a well-known folder; everything else to a page.
          router: ({ dir, name, ext }) => dir.includes(".well-known") ? { dir, name, ext } : { dir, name, ext: ".html" },
          extensions: [".md", ".html", ""],
          format: "text",
          createStubs: () => [{ path: path.join(".well-known", "atproto-did"), params: { did: "did:plc:test" } }],
          expandStubs: () => ({ text: "did:plc:test" }),
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    server = await startServer(config)
    const base = `http://127.0.0.1:${server.port}`

    const page = await fetch(`${base}/about`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-type"), /text\/html/)
    assert.equal(await page.text(), "about")

    const wellKnown = await fetch(`${base}/.well-known/atproto-did`)
    assert.equal(wellKnown.status, 200, "the exact file wins over about.html-style defaulting")
    assert.match(wellKnown.headers.get("content-type"), /^text\/plain/)
    assert.equal(await wellKnown.text(), "did:plc:test")
  } finally {
    if (server) await server.close()
    await rm(sourceFolder, { recursive: true, force: true })
  }
})
