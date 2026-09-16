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

test("serve: deleting a source while the server runs removes its target and does not crash", async () => {
  const { access } = await import("node:fs/promises")
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-rm-"))
  let server
  const rejections = []
  const onRejection = (error) => rejections.push(error)
  process.on("unhandledRejection", onRejection)
  try {
    await writeFile(path.join(sourceFolder, "keep.md"), "keep")
    await writeFile(path.join(sourceFolder, "gone.md"), "gone")
    const targetFolder = path.join(sourceFolder, "_out")
    server = await startServer({
      sourceFolder, targetFolder,
      databasePath: path.join(sourceFolder, ".votive.db"),
      logging: "silent",
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
          extensions: [".md", ".html"], format: "text",
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    })
    await new Promise(resolve => setTimeout(resolve, 1200))
    await access(path.join(targetFolder, "gone.html"))

    await rm(path.join(sourceFolder, "gone.md"))
    await new Promise(resolve => setTimeout(resolve, 1500))

    assert.deepEqual(rejections, [], "an rm must not produce an unhandled rejection")
    await assert.rejects(() => access(path.join(targetFolder, "gone.html")), "the deleted source's target is removed")
    await access(path.join(targetFolder, "keep.html"))
  } finally {
    process.off("unhandledRejection", onRejection)
    if (server) await server.close()
    await rm(sourceFolder, { recursive: true, force: true })
  }
})

test("build({changed}) on a file that vanished before the stat prunes it instead of throwing", async () => {
  const { default: bundler } = await import("../lib/bundle.js")
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-vanish-"))
  try {
    await writeFile(path.join(sourceFolder, "page.md"), "page")
    const site = await bundler({
      sourceFolder, targetFolder: path.join(sourceFolder, "_out"), verbose: false,
      plugins: [{ name: "t", processors: [{
        router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
        extensions: [".md", ".html"], format: "text",
        readFile: (source) => ({ data: source.text, metadata: {} }),
        writeFile: (target) => ({ data: target.data })
      }] }]
    })
    await site.build()
    assert.ok(site.database.target.get("page.html"))

    await rm(path.join(sourceFolder, "page.md"))
    // Named as changed, as a racing watcher would - but it is gone.
    await site.build({ changed: ["page.md"], deleted: [] })

    assert.equal(site.database.target.get("page.html"), undefined)
    assert.equal(site.database.source.get("page.md"), undefined)
    await site.close()
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
})
