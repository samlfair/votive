import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import createDatabase from "../lib/createDatabase.js"
import cleanupDatabase from "../lib/cleanupDatabase.js"
import { checkFile } from "../lib/utils/index.js"

/** @param {(sourceFolder: string, targetFolder: string) => Promise<void>} run */
async function withFolders(run) {
  const root = await mkdtemp(path.join(tmpdir(), "votive-cleanup-"))
  const sourceFolder = path.join(root, "source")
  const targetFolder = path.join(root, "target")
  await mkdir(sourceFolder, { recursive: true })
  await mkdir(targetFolder, { recursive: true })
  try {
    await run(sourceFolder, targetFolder)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("cleanupDatabase: prunes a target whose file and source are both gone", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "gone.html", metadata: {}, source: "gone.md" })
    // Neither gone.html nor gone.md exist on disk.

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedTargets, ["gone.html"])
    assert.deepEqual(summary.healedTargets, [])
    assert.equal(database.target.get("gone.html"), undefined)
  })
})

test("cleanupDatabase: heals (marks stale) a target whose source still exists but whose file is missing", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const sourcePath = path.join(sourceFolder, "still-here.md")
    await writeFile(sourcePath, "content")

    const database = createDatabase(":memory:")
    // Relative, as the database stores it (see CLAUDE.md: everything
    // in the database is relative to sourceFolder). This test used to
    // store the absolute path, which is how a cwd-relative check in the
    // sweep stayed green while pruning every target in production.
    database.target.create({ path: "still-here.html", metadata: {}, source: "still-here.md" })
    database.target.markFresh("still-here.html")
    // still-here.html was never actually written to targetFolder.

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.healedTargets, ["still-here.html"])
    assert.deepEqual(summary.prunedTargets, [])
    const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get("still-here.html")
    assert.equal(Boolean(row.stale), true)
  })
})

test("cleanupDatabase: heals a synthetic target (no source) whose file is missing", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "sitemap.xml", metadata: {} }) // no source
    database.target.markFresh("sitemap.xml")

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.healedTargets, ["sitemap.xml"])
    assert.deepEqual(summary.prunedTargets, [])
  })
})

test("cleanupDatabase: leaves a virtual (write: false) target alone even with no file", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "partial.html", metadata: {}, write: false })

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedTargets, [])
    assert.deepEqual(summary.healedTargets, [])
    assert.ok(database.target.get("partial.html"))
  })
})

test("cleanupDatabase: leaves a healthy target (file present) untouched", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const sourcePath = path.join(sourceFolder, "healthy.md")
    await writeFile(sourcePath, "content")
    await writeFile(path.join(targetFolder, "healthy.html"), "<html></html>")

    const database = createDatabase(":memory:")
    database.target.create({ path: "healthy.html", metadata: {}, source: sourcePath })
    database.target.markFresh("healthy.html")

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedTargets, [])
    assert.deepEqual(summary.healedTargets, [])
    const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get("healthy.html")
    assert.equal(Boolean(row.stale), false)
  })
})

test("cleanupDatabase: prunes a dependency row whose dependent no longer exists", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: {} })
    await writeFile(path.join(targetFolder, "a.html"), "<html></html>")
    database.target.markFresh("a.html")

    // "b.html" reads from "a.html" but was never itself created as a
    // target - simulates a target having been deleted directly (only
    // edges *pointing at* the deleted target get cleaned by the DB
    // trigger, not edges *from* it).
    database.raw.prepare(
      `INSERT INTO dependencies (target, property, dependent, type) VALUES (?, ?, ?, ?)`
    ).run("a.html", "abstract", "b.html", "target")

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedDependencies, ["a.html:abstract -> b.html"])
    const remaining = database.raw.prepare(
      `SELECT * FROM dependencies WHERE target = ? AND dependent = ?`
    ).get("a.html", "b.html")
    assert.equal(remaining, undefined)
  })
})

test("cleanupDatabase: doesn't crash on the route()-less \"0\" placeholder target", async () => {
  // Regression test: targets.path used to be declared STRING, which
  // SQLite gives NUMERIC affinity (not a recognized affinity keyword -
  // see the comment on the targets table in createDatabase.js). The
  // literal path "0" (route()'s placeholder for a file with no router,
  // e.g. settings.md) round-tripped as the *integer* 0, and
  // path.join(targetFolder, 0) threw - reproduced live against a real
  // build before the STRING -> TEXT fix.
  await withFolders(async (sourceFolder, targetFolder) => {
    const sourcePath = path.join(sourceFolder, "settings.md")
    await writeFile(sourcePath, "content")

    const database = createDatabase(":memory:")
    database.target.create({ path: "0", metadata: {}, source: sourcePath })

    const row = database.raw.prepare("SELECT path, typeof(path) as t FROM targets WHERE path = '0'").get()
    assert.equal(row.t, "text")

    assert.doesNotThrow(() => cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database))
  })
})

test("cleanupDatabase: resolves a target's source against sourceFolder, not cwd", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    await writeFile(path.join(sourceFolder, "page.md"), "content")

    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", metadata: {}, source: "page.md" })
    database.target.markFresh("page.html")
    // page.html was never written. page.md exists - but only under
    // sourceFolder, never under process.cwd(). A cwd-relative check
    // would call the source gone and delete the row instead of healing.

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedTargets, [])
    assert.deepEqual(summary.healedTargets, ["page.html"])
    assert.notEqual(database.target.get("page.html"), undefined)
  })
})

test("cleanupDatabase: deletes a file in the target folder that no target row claims", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    await mkdir(path.join(targetFolder, "old"), { recursive: true })
    await writeFile(path.join(targetFolder, "kept.html"), "kept")
    await writeFile(path.join(targetFolder, "old", "stranded.html"), "left behind by a rename")
    await writeFile(path.join(targetFolder, "recursive.ttf"), "a font nothing links any more")

    const database = createDatabase(":memory:")
    database.target.create({ path: "kept.html", metadata: {} })
    database.target.markFresh("kept.html")

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedFiles.sort(), ["old/stranded.html", "recursive.ttf"])
    assert.equal(checkFile(path.join(targetFolder, "kept.html")) !== null, true)
    assert.equal(checkFile(path.join(targetFolder, "old", "stranded.html")), null)
    assert.equal(checkFile(path.join(targetFolder, "recursive.ttf")), null)
  })
})

test("cleanupDatabase: a virtual target's path is not expected on disk, and a stray file there is deleted", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    await writeFile(path.join(targetFolder, "secret.html"), "should never have been written")

    const database = createDatabase(":memory:")
    database.target.create({ path: "secret.html", metadata: {}, write: false })
    database.target.markFresh("secret.html")

    const summary = cleanupDatabase({ sourceFolder, targetFolder, verbose: false }, database)

    assert.deepEqual(summary.prunedFiles, ["secret.html"])
    assert.notEqual(database.target.get("secret.html"), undefined) // the row is untouched
  })
})

test("cleanupDatabase: leaves the database and cache alone when they live inside the target folder", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const databasePath = path.join(targetFolder, ".votive.db")
    const cacheDirectory = path.join(targetFolder, ".cache")
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(databasePath, "db")
    await writeFile(databasePath + "-wal", "wal")
    await writeFile(path.join(cacheDirectory, "abc.json"), "{}")

    const database = createDatabase(":memory:")
    const summary = cleanupDatabase({ sourceFolder, targetFolder, databasePath, cacheDirectory, verbose: false }, database)

    assert.deepEqual(summary.prunedFiles, [])
    assert.notEqual(checkFile(databasePath), null)
    assert.notEqual(checkFile(databasePath + "-wal"), null)
    assert.notEqual(checkFile(path.join(cacheDirectory, "abc.json")), null)
  })
})

test("cleanupDatabase: a missing target folder is not an error", async () => {
  await withFolders(async (sourceFolder, targetFolder) => {
    const database = createDatabase(":memory:")
    const summary = cleanupDatabase({ sourceFolder, targetFolder: path.join(targetFolder, "never-created"), verbose: false }, database)
    assert.deepEqual(summary.prunedFiles, [])
  })
})
