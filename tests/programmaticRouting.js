import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import bundler from "../lib/bundle.js"

/** @param {(sourceFolder: string) => Promise<void>} run */
async function withTempSourceFolder(run) {
  const sourceFolder = await mkdtemp(path.join(tmpdir(), "votive-routing-"))
  try {
    await run(sourceFolder)
  } finally {
    await rm(sourceFolder, { recursive: true, force: true })
  }
}

/** @param {string} filePath */
async function exists(filePath) {
  try {
    await stat(filePath)
    return true
  } catch (e) {
    return false
  }
}

test("readFile: a returned filePath does not move the target - routing decides where it lands", async () => {
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
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
                        metadata: {},
            filePath: "custom/moved.html"
          })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred
    const cache = site.database

    // read() is handed the routed path and cannot rewrite it. A stray
    // `filePath` in the returned object is inert, not an escape hatch.
    assert.ok(cache.target.get("page.html"))
    assert.equal(cache.target.get("custom/moved.html"), undefined)

    const written = await import("node:fs/promises")
      .then(fs => fs.readFile(path.join(config.targetFolder, "page.html"), "utf-8"))
    assert.equal(written, "written:page.html")
    assert.equal(await exists(path.join(config.targetFolder, "custom/moved.html")), false)
  })
})

test("readFile: write: false creates a target without writing a file to disk", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "partial.md"), "content")

    let writeFileCalls = 0

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "partial", ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => { writeFileCalls++; return { data: "should never land on disk" } },
          readFile: () => ({
            metadata: { kind: "partial" },
            metadata: {},
            write: false
          })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred
    const cache = site.database

    // The target exists and is readable...
    const target = cache.target.get("partial.html")
    assert.ok(target)
    assert.equal(target.write, false)

    // ...its processor's writeFile still ran normally (side effects,
    // e.g. api.createTarget() calls, aren't skipped)...
    assert.equal(writeFileCalls, 1)

    // ...but nothing was written to disk.
    assert.equal(await exists(path.join(config.targetFolder, "partial.html")), false)
  })
})

test("readFile: write can flip an existing target between virtual and written across builds", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const sourcePath = path.join(sourceFolder, "toggle.md")
    await writeFile(sourcePath, "v1")

    let virtual = true

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "toggle", ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: () => ({ data: "toggled content" }),
          readFile: () => ({
                        metadata: {},
            write: virtual ? false : true
          })
        }]
      }]
    }

    const site = await bundler(config)
    const first = await (await site.build()).deferred

    assert.equal(site.database.target.get("toggle.html").write, false)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), false)

    // Flip it, then touch the source file so it's re-read.
    virtual = false
    await writeFile(sourcePath, "v2")

    const second = await (await site.build()).deferred

    assert.equal(site.database.target.get("toggle.html").write, true)
    assert.equal(await exists(path.join(config.targetFolder, "toggle.html")), true)
  })
})

test("readFile (buffer format): a returned filePath does not move the target either", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "asset.bin"), "binary content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: () => ({ dir: [], name: "asset", ext: ".html" }),
          extensions: [".bin", ".html"],
          format: "buffer",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: () => ({
                        metadata: {},
            filePath: "buffers/renamed.html"
          })
        }]
      }]
    }

    const site = await bundler(config)
    await (await site.build()).deferred

    assert.ok(site.database.target.get("asset.html"))
    assert.equal(site.database.target.get("buffers/renamed.html"), undefined)
    assert.equal(await exists(path.join(config.targetFolder, "asset.html")), true)
    assert.equal(await exists(path.join(config.targetFolder, "buffers/renamed.html")), false)
  })
})

test("readFile: an api.url() call attributes to the routed target path", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      plugins: [{
        name: "test-plugin",
        processors: [{
          router: ({ name }) => ({ dir: [], name, ext: ".html" }),
          extensions: [".md", ".html"],
          format: "text",
          writeFile: (target) => ({ data: `written:${target.path}` }),
          readFile: (source, { api }) => {
            // The api is real and pre-bound to targetPath - the path the
            // request attributes to is settled before read() is even
            // called.
            api.url("https://example.com/thing")
            return { metadata: {} }
          }
        }]
      }]
    }

    const site = await bundler(config)
    const first = await (await site.build()).deferred

    assert.ok(site.database.target.get("page.html"))

    const deps = site.database.dependency.getAllByTarget("https://example.com/thing")
    assert.ok(deps.some(d => d.dependent === "page.html"), "expected page.html to depend on the linked URL")
  })
})

/**
 * A config-level router rewrites a source path before any processor's
 * router sees it. Vowel uses it for secret paths: a segment beginning
 * with "-" is replaced by a hash. It has to live above the processors,
 * because a secret folder contains images and fonts as well as pages, and
 * nine processors each implementing the rule means whichever one forgets
 * leaks the folder name. See tasks/2-in-progress/synthetic-sources.md.
 */
function hashSecretSegments(sourcePath) {
  return sourcePath
    .split("/")
    // Lowercase, like a real md5 hex digest: canonicalTargetPath
    // lowercases every stored target path.
    .map(segment => segment.startsWith("-") ? `h${segment.slice(1)}h` : segment)
    .join("/")
}

test("config.router: rewrites the path every processor's router then routes", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(sourceFolder, "-key"), { recursive: true })
    await writeFile(path.join(sourceFolder, "-key", "hello.md"), "page")
    await writeFile(path.join(sourceFolder, "-key", "photo.png"), "bytes")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      cacheDirectory: path.join(sourceFolder, "_cache"),
      verbose: false,
      router: hashSecretSegments,
      plugins: [{
        name: "test-plugin",
        processors: [
          {
            extensions: [".md", ".html"],
            format: "text",
            router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
            readFile: (source) => ({ data: source.text, metadata: {} }),
            writeFile: (target) => ({ data: target.data })
          },
          {
            // A different processor entirely, with its own router. The
            // rewrite has to reach it too, or the asset leaks the folder.
            extensions: [".png"],
            format: "text",
            router: ({ dir, name, ext }) => ({ dir, name, ext }),
            readFile: (source) => ({ data: source.text, metadata: {} }),
            writeFile: (target) => ({ data: target.data })
          }
        ]
      }]
    }

    const site = await bundler(config)
    await site.build()

    assert.equal(await exists(path.join(sourceFolder, "_out", "hkeyh", "hello.html")), true)
    assert.equal(await exists(path.join(sourceFolder, "_out", "hkeyh", "photo.png")), true)
    assert.equal(await exists(path.join(sourceFolder, "_out", "-key", "hello.html")), false)
    assert.equal(await exists(path.join(sourceFolder, "_out", "-key", "photo.png")), false)
    await site.close()
  })
})

test("config.router: the source path is stored and looked up unrewritten", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(sourceFolder, "-key"), { recursive: true })
    await writeFile(path.join(sourceFolder, "-key", "hello.md"), "page")

    let seenSourcePath
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      router: hashSecretSegments,
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
          readFile: (source) => {
            // readFile sees the path as the author wrote it, which is how
            // it can tell the page is secret at all.
            seenSourcePath = source.path
            return { data: source.text, metadata: {} }
          },
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    const site = await bundler(config)
    await site.build()

    assert.equal(seenSourcePath, path.join("-key", "hello.md"))

    // Stored under the original path, so targetBySource still resolves -
    // which is what relative-link resolution and the editor's save path
    // both rely on.
    const target = site.database.target.getBySource(path.join("-key", "hello.md"))
    assert.notEqual(target, undefined)
    assert.equal(target.path, path.join("hkeyh", "hello.html"))
    assert.notEqual(site.database.source.get(path.join("-key", "hello.md")), undefined)
    await site.close()
  })
})

test("config.router: a stub's path goes through the cascade too", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      router: hashSecretSegments,
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
          createStubs: () => [{ path: "-secret/index.md" }],
          expandStubs: () => ({ text: "generated" }),
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    const site = await bundler(config)
    await site.build()

    assert.equal(await exists(path.join(sourceFolder, "_out", "hsecreth", "index.html")), true)
    await site.close()
  })
})

test("config.router: returning nothing leaves the path unchanged", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      router: () => undefined,
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    const site = await bundler(config)
    await site.build()
    assert.equal(await exists(path.join(sourceFolder, "_out", "page.html")), true)
    await site.close()
  })
})

test("config.router: returning a non-string is an error that names the path", async () => {
  await withTempSourceFolder(async (sourceFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      router: () => ({ dir: "nope" }),
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          router: ({ dir, name }) => ({ dir, name, ext: ".html" }),
          readFile: (source) => ({ data: source.text, metadata: {} }),
          writeFile: (target) => ({ data: target.data })
        }]
      }]
    }

    const site = await bundler(config)
    await assert.rejects(() => site.build(), /page\.md/)
  })
})

test("config.router: a settings.md in a rewritten folder scopes to where its pages land", async () => {
  // Settings are contributed by source and read by target folder. With
  // the cascade those differ for a secret folder, so the contribution
  // has to follow the rewrite or the pages beside it never see it.
  await withTempSourceFolder(async (sourceFolder) => {
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(sourceFolder, "-key"), { recursive: true })
    await writeFile(path.join(sourceFolder, "-key", "settings.md"), "secret settings")
    await writeFile(path.join(sourceFolder, "-key", "page.md"), "page")

    let seen
    const config = {
      sourceFolder,
      targetFolder: path.join(sourceFolder, "_out"),
      verbose: false,
      router: hashSecretSegments,
      plugins: [{
        name: "test-plugin",
        processors: [{
          extensions: [".md", ".html"],
          format: "text",
          router: ({ dir, name }) => name === "settings" ? false : { dir, name, ext: ".html" },
          readFile: (source) => ({
            data: source.text,
            metadata: {},
            settings: path.basename(source.path) === "settings.md" ? { tone: "hushed" } : undefined
          }),
          writeFile: (target, { settings }) => {
            seen = settings.last("tone")
            return { data: target.data }
          }
        }]
      }]
    }

    const site = await bundler(config)
    await site.build()

    assert.equal(seen, "hushed", "the page in the hashed folder reads the settings.md beside it")
    assert.deepEqual(site.database.setting.getByFolder("hkeyh").tone, [null, ["hushed"]])
    assert.equal(site.database.setting.getByFolder("-key").tone, undefined, "nothing is scoped to the unrewritten name")
    await site.close()
  })
})
