import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import votive from "../lib/bundle.js"

/**
 * A folder with `files`, built once with `plugins`; the output's file
 * names, sorted, and what was logged as an error.
 */
async function build(files, plugins) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-router-"))
  try {
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(sourceFolder, name), text)
    const errors = []
    const site = await votive({
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      databasePath: ":memory:",
      plugins,
      log: (level, message) => { if (level === "error") errors.push(message) }
    })
    try {
      await (await site.build()).deferred
      const output = await readdir(path.join(sourceFolder, "_out"), { recursive: true }).catch(() => [])
      return { output: output.filter(name => name.includes(".")).sort(), errors }
    } finally {
      await site.close()
    }
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

const reader = (extensions) => ({
  extensions,
  format: "text",
  readFile: (source) => ({ data: source.text, metadata: {} }),
  writeFile: (target) => ({ data: target.data })
})

test("a plugin's router runs on all its processors; each processor's router gets what the plugin's returned", async () => {
  const seen = []
  const plugin = {
    name: "chain",
    router: (info) => ({ ...info, dir: ["", "site", ...info.dir.filter(Boolean)] }),
    processors: [
      { ...reader([".txt", ".html"]), router: (info) => { seen.push(info.dir); return { dir: info.dir, name: info.name, ext: ".html" } } },
      { ...reader([".md", ".htm"]), router: ({ dir, name }) => ({ dir, name, ext: ".htm" }) }
    ]
  }
  const { output, errors } = await build({ "a.txt": "a", "b.md": "b" }, [plugin])
  assert.deepEqual(errors, [])
  assert.deepEqual(output, [path.join("site", "a.html"), path.join("site", "b.htm")])
  assert.deepEqual(seen, [["", "site"]], "the processor router receives the plugin's result, dir as an array")
})

test("a plugin's router alone routes; nothing from either means no target; either can say no", async () => {
  const alone = { name: "alone", router: ({ dir, name }) => ({ dir, name, ext: ".html" }), processors: [reader([".txt", ".html"])] }
  assert.deepEqual((await build({ "a.txt": "a" }, [alone])).output, ["a.html"])

  const none = { name: "none", processors: [reader([".txt", ".html"])] }
  assert.deepEqual((await build({ "a.txt": "a" }, [none])).output, [])

  const pluginSaysNo = { name: "no", router: () => false, processors: [{ ...reader([".txt", ".html"]), router: () => { throw new Error("never asked") } }] }
  const refused = await build({ "a.txt": "a" }, [pluginSaysNo])
  assert.deepEqual(refused, { output: [], errors: [] }, "a plugin router's no means the processor's isn't asked")

  const processorSaysNo = { name: "no", router: (info) => info, processors: [{ ...reader([".txt", ".html"]), router: () => null }] }
  assert.deepEqual((await build({ "a.txt": "a" }, [processorSaysNo])).output, [])
})

test("a plugin router that returns the wrong thing is named in the error", async () => {
  const bad = { name: "bad", router: ({ dir, name }) => `${dir}/${name}.html`, processors: [reader([".txt", ".html"])] }
  const { output, errors } = await build({ "a.txt": "a" }, [bad])
  assert.deepEqual(output, [])
  assert.match(errors.join("\n"), /"bad"'s plugin router must return a parsed path or nothing/)
})

test("the README's example plugin builds a page", async () => {
  const text = {
    name: "text",
    processors: [{
      extensions: [".txt", ".html"],
      format: "text",
      router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
      readFile: (source) => ({ data: source.text, metadata: { title: source.text.split("\n")[0] } }),
      writeFile: (target, { api }) => {
        const others = api.targets({ folder: "" })
        return { data: `<h1>${target.metadata.title}</h1><p>${others.length} pages</p>` }
      }
    }]
  }
  assert.deepEqual((await build({ "hello.txt": "Hello\nworld" }, [text])).output, ["hello.html"])
})

test("a processor that reads without a format is refused when the site is made; one that only declares stubs needs none", async () => {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-router-"))
  try {
    const make = (processor) => votive({ sourceFolder, targetFolder: path.join(sourceFolder, "_out"), databasePath: ":memory:", plugins: [{ name: "p", processors: [processor] }] })
    await assert.rejects(() => make({ extensions: [".txt"], router: (info) => info, readFile: () => ({}) }), /Plugin "p" has a processor for \[".txt"\] that reads but has no format \(got none\)/)
    await assert.rejects(() => make({ extensions: [".txt"], format: "txt", readFile: () => ({}) }), /got "txt"/)
    const site = await make({ createStubs: () => [] })
    await site.close()
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
})
