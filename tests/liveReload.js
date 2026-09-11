import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import WebSocket from "faye-websocket"
import startServer from "../lib/serve.js"

/**
 * The live-reload client decides between patching the DOM and reloading
 * the page by comparing the <head> it has against the <head> in the
 * pushed payload. So the payload has to be the page the browser would
 * get if it re-requested - anything else is a guaranteed reload.
 *
 * This has now gone wrong twice for different reasons: once a hardcoded
 * `data: "hello"` placeholder won over the real file, and once
 * target.data held the markdown a readFile had stored rather than the
 * HTML writeTargets wrote. Both were invisible to every other test,
 * because the files on disk were correct throughout.
 */
test("live reload: an edited page is pushed as its rendered HTML, not its source", async () => {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-reload-"))
  /** @type {{close: () => Promise<void>} | undefined} */
  let server
  /** @type {any} */
  let socket

  try {
    await writeFile(path.join(sourceFolder, "page.md"), "# Page\n\nBody text.\n")

    const config = {
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
          // Exactly the shape that broke it: data is the source on the
          // way in, and the rendered page on the way out.
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) =>
            ({ data: `<!doctype html><html><head><title>T</title></head><body><main>${target.data}</main></body></html>` })
        }]
      }]
    }

    server = await startServer(config)

    /** @type {any[]} */
    const pushes = []
    socket = new WebSocket.Client(`ws://127.0.0.1:${server.port}/`)
    socket.on("message", (event) => pushes.push(JSON.parse(event.data)))
    await new Promise(resolve => socket.on("open", resolve))

    // Let the startup build's own watcher events drain before measuring.
    await new Promise(resolve => setTimeout(resolve, 2000))
    pushes.length = 0

    await appendFile(path.join(sourceFolder, "page.md"), "\nMore text.\n")

    const pushed = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10000)
      const check = setInterval(() => {
        const found = pushes.find(push => push.path === "page.html")
        if (!found) return
        clearTimeout(timer); clearInterval(check); resolve(found)
      }, 100)
    })

    assert.ok(pushed, "the edited page should be pushed")
    assert.ok(pushed.data, "the push must carry data, or the client reloads unconditionally")
    assert.ok(pushed.data.includes("<head>"), `pushed data should be the rendered page, got: ${pushed.data.slice(0, 80)}`)
    assert.ok(pushed.data.includes("More text."), "and should reflect the edit")
    assert.ok(!pushed.data.startsWith("# Page"), "it must not be the markdown source")
  } finally {
    if (socket) socket.close()
    if (server) await server.close()
    await rm(sourceFolder, { recursive: true, force: true })
  }
})
