import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import YAML from "yaml"
import bundler from "../lib/bundle.js"
import { requestKey, fromRequest, fromURL, isRequestLike } from "../lib/urlRequest.js"

async function withServer(handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })
  }
}

async function withTempFolder(run) {
  const folder = await mkdtemp(path.join(tmpdir(), "votive-urlreq-"))
  try {
    await run(folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

/** Every file under the store, relative to it. */
async function storeFiles(sourceFolder) {
  const folder = path.join(sourceFolder, "links")
  const entries = await readdir(folder, { withFileTypes: true, recursive: true }).catch(() => [])
  return entries.filter(e => e.isFile()).map(e => path.relative(folder, path.join(e.parentPath, e.name))).sort()
}

test("the key: a GET is its url, anything else carries its method and a digest of its body", () => {
  assert.equal(requestKey({ url: "https://a.test/x" }), "https://a.test/x")
  assert.equal(requestKey({ url: "https://a.test/x", method: "GET" }), "https://a.test/x")
  assert.equal(requestKey({ url: "https://a.test/x", method: "delete" }), "DELETE https://a.test/x")

  const one = requestKey({ url: "https://a.test/x", method: "POST", body: '{"a":1}' })
  const two = requestKey({ url: "https://a.test/x", method: "POST", body: '{"a":2}' })
  assert.match(one, /^POST https:\/\/a\.test\/x #[0-9a-f]{8}$/)
  assert.notEqual(one, two, "two bodies are two requests")
  assert.equal(one, requestKey({ url: "https://a.test/x", method: "POST", body: '{"a":1}' }), "the same body is the same request")
})

test("fromRequest reads the body once, leaves the caller's request usable, and sorts the headers", async () => {
  const request = new Request("https://a.test/x", {
    method: "POST",
    headers: { "z-last": "2", "a-first": "1" },
    body: '{"record":1}'
  })
  const record = await fromRequest(request)

  assert.equal(record.method, "POST")
  assert.equal(record.url, "https://a.test/x")
  assert.equal(record.body, '{"record":1}')
  assert.deepEqual(record.headers.map(([name]) => name), ["a-first", "content-type", "z-last"])
  assert.equal(record.key, requestKey({ url: "https://a.test/x", method: "POST", body: '{"record":1}' }))

  assert.equal(request.bodyUsed, false, "the caller's own request was cloned, not consumed")
  assert.equal(await request.text(), '{"record":1}')

  assert.equal(isRequestLike(request), true)
  assert.equal(isRequestLike("https://a.test/x"), false)
  assert.deepEqual(fromURL("https://a.test/x"), { key: "https://a.test/x", url: "https://a.test/x", method: "GET" })
})

test("api.url(Request): the request is sent as written, its data comes back on the next build, and two bodies are two entries", async () => {
  const received = []
  const server = await withServer((req, res) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body, auth: req.headers.authorization, agent: req.headers["user-agent"] })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ uri: `at://did:plc:test/${JSON.parse(body || "{}").rkey}`, cid: `cid-${received.length}` }))
    })
  })

  try {
    await withTempFolder(async (folder) => {
      await writeFile(path.join(folder, "one.md"), "one")
      await writeFile(path.join(folder, "two.md"), "two")

      const asked = {}
      const config = {
        sourceFolder: folder,
        targetFolder: path.join(folder, "_out"),
        urlStore: path.join(folder, "links"),
        urlHostInterval: 0,
        log: () => {},
        plugins: [{
          name: "test-plugin",
          processors: [
            {
              // The record publisher: every page POSTs itself and
              // renders whatever came back.
              extensions: [".md", ".html"],
              format: "text",
              router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
              readFile: (source) => ({ data: source.text, metadata: {} }),
              writeFile: async (target, { api }) => {
                const request = new Request(`${server.baseUrl}/xrpc/com.atproto.repo.createRecord`, {
                  method: "POST",
                  headers: { "content-type": "application/json", authorization: "Bearer token" },
                  // Not target.data: a write stores its own output back
                  // as data, so hashing it would make every build a
                  // different request (see CLAUDE.md, "data is mutable").
                  body: JSON.stringify({ rkey: target.path, text: target.source })
                })
                const result = await api.url(request)
                asked[target.path] = result
                return { data: JSON.stringify(result ?? null) }
              }
            },
            {
              format: "url",
              mediaTypes: ["application/json"],
              readURL: async (response) => {
                const data = await response.json()
                return { path: `records/${data.cid}`, data }
              }
            }
          ]
        }]
      }

      const site = await bundler(config)
      await (await site.build()).deferred

      // Sent as written: method, body and the plugin's own headers.
      assert.equal(received.length, 2, JSON.stringify(received))
      assert.deepEqual(received.map(r => r.method), ["POST", "POST"])
      assert.deepEqual(received.map(r => r.url).sort(), ["/xrpc/com.atproto.repo.createRecord", "/xrpc/com.atproto.repo.createRecord"])
      assert.ok(received.every(r => r.auth === "Bearer token"), "the plugin's headers are sent")
      assert.ok(received.every(r => r.agent === "VotiveBot/1.0"), "with the default user-agent alongside")
      assert.deepEqual(received.map(r => JSON.parse(r.body).rkey).sort(), ["one.html", "two.html"])

      // Two bodies to one endpoint are two entries, two files, two rows.
      const files = await storeFiles(folder)
      assert.equal(files.length, 2, files.join(", "))
      const entries = await Promise.all(files.map(async file => YAML.parse(await readFile(path.join(folder, "links", file), "utf-8"))))
      const keys = entries.map(entry => entry.url).sort()
      assert.ok(keys.every(key => key.startsWith(`POST ${server.baseUrl}/xrpc/com.atproto.repo.createRecord #`)), keys.join(", "))
      assert.notEqual(keys[0], keys[1])

      // The data reached both pages on the follow-up build.
      const one = JSON.parse(await readFile(path.join(folder, "_out", "one.html"), "utf-8"))
      const two = JSON.parse(await readFile(path.join(folder, "_out", "two.html"), "utf-8"))
      assert.match(one.uri, /^at:\/\/did:plc:test\/one\.html$/)
      assert.match(two.uri, /^at:\/\/did:plc:test\/two\.html$/)

      // And a second build asks for the same records and sends nothing:
      // the same request is the same entry, already in the store.
      const before = received.length
      await (await site.build()).deferred
      assert.equal(received.length, before, "a POST already in the store is not sent again")
      await site.close()
    })
  } finally {
    await server.close()
  }
})

test("api.url(string) is still synchronous and still keys on the bare url", async () => {
  const server = await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("hello")
  })
  try {
    await withTempFolder(async (folder) => {
      await writeFile(path.join(folder, "page.md"), "x")
      let returnedPromise = null
      const config = {
        sourceFolder: folder,
        targetFolder: path.join(folder, "_out"),
        urlStore: path.join(folder, "links"),
        urlHostInterval: 0,
        log: () => {},
        plugins: [{
          name: "test-plugin",
          processors: [
            {
              extensions: [".md", ".html"],
              format: "text",
              router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
              readFile: (source) => ({ data: source.text, metadata: {} }),
              writeFile: (target, { api }) => {
                // No await anywhere: a string answers in the same tick.
                const result = api.url(`${server.baseUrl}/thing`)
                returnedPromise = result && typeof result.then === "function"
                return { data: JSON.stringify(result ?? null) }
              }
            },
            {
              format: "url",
              mediaTypes: ["text/plain"],
              readURL: async (response) => ({ path: "plain/thing", data: { text: await response.text() } })
            }
          ]
        }]
      }
      const site = await bundler(config)
      await (await site.build()).deferred

      assert.equal(returnedPromise, false, "a string never returns a promise")
      const [file] = await storeFiles(folder)
      const entry = YAML.parse(await readFile(path.join(folder, "links", file), "utf-8"))
      assert.equal(entry.url, `${server.baseUrl}/thing`, "a GET is keyed on the bare url, as before")
      assert.equal(JSON.parse(await readFile(path.join(folder, "_out", "page.html"), "utf-8")).text, "hello")
      await site.close()
    })
  } finally {
    await server.close()
  }
})
