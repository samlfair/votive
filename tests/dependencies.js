import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function isStale(database, targetPath) {
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get(targetPath)
  return Boolean(row && row.stale)
}

test("dependencies: folder/folder_recursive typing and invalidation", async (t) => {
  await t.test("getByFolder registers a 'folder' dependency and returns scoped targets", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "blog/sub/b.html", abstract: {}, metadata: {} })

    const results = database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })

    assert.deepEqual(results.map(r => r.path).sort(), ["blog/a.html"])

    const rows = database.dependency.getAllByTarget("blog")
    assert.deepEqual(rows.map(r => ({ dependent: r.dependent, type: r.type })), [
      { dependent: "nav.html", type: "folder" }
    ])
  })

  await t.test("getByFolder(recursive: true) registers a 'folder_recursive' dependency", () => {
    const database = createDatabase(":memory:")
    database.target.getByFolder({ folder: "blog", recursive: true, dependent: "nav.html" })

    const rows = database.dependency.getAllByTarget("blog")
    assert.equal(rows[0].type, "folder_recursive")
  })

  await t.test("a new target in a non-recursive 'folder' scope stales the dependent", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    assert.equal(isStale(database, "nav.html"), false)

    database.target.create({ path: "blog/b.html", abstract: {}, metadata: {} })
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("a non-recursive 'folder' dependency ignores changes in a deeper subfolder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    database.target.create({ path: "blog/sub/deep.html", abstract: {}, metadata: {} })

    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("a 'folder_recursive' dependency on an ancestor catches a change several levels deeper", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "", recursive: true, dependent: "nav.html" })
    database.target.create({ path: "blog/sub/deep.html", abstract: {}, metadata: {} })

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("changing a property a folder dependent actually read stales it (lazy per-property tracking)", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { status: "draft" } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    const results = database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    results.forEach(target => target.metadata.status) // simulate a template reading this property

    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { status: "published" } })

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("changing a property a folder dependent never read does NOT stale it", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { status: "draft", views: 1 } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    const results = database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    results.forEach(target => target.metadata.status) // only reads `status`, never `views`

    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { status: "draft", views: 2 } })

    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("deleting a target stales its folder's dependents", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    database.target.delete("blog/a.html")

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("url.create with a target records a type='url' dependency", () => {
    const database = createDatabase(":memory:")
    database.url.create("https://example.com/embed", { title: "Example" }, "post.html")

    const rows = database.dependency.getAllByTarget("https://example.com/embed")
    assert.deepEqual(rows.map(r => ({ dependent: r.dependent, type: r.type })), [
      { dependent: "post.html", type: "url" }
    ])
    assert.deepEqual(database.url.get("https://example.com/embed"), { title: "Example" })
  })

  await t.test("deleting a target cleans up its own metadata and dependency rows via the cleanup trigger", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: { title: "A" } })
    database.target.create({ path: "b.html", abstract: {}, metadata: {} })
    const tracked = database.target.getWithTrackers("a.html", "b.html")
    tracked.metadata.title // simulate a template reading this, registering a type='target' dependency

    database.target.delete("a.html")

    const metadataRows = database.raw.prepare("SELECT * FROM metadata WHERE target = ?").all("a.html")
    assert.deepEqual(metadataRows, [])

    const dependencyRows = database.raw.prepare("SELECT * FROM dependencies WHERE target = ?").all("a.html")
    assert.deepEqual(dependencyRows, [])
  })

  await t.test("editing an existing target's own metadata marks the target itself stale, not just its dependents", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "home.html", abstract: { type: "page" }, metadata: { title: "Home" } })
    database.target.markFresh("home.html")
    assert.equal(isStale(database, "home.html"), false)

    database.target.create({ path: "home.html", abstract: { type: "page" }, metadata: { title: "Home Updated" } })

    assert.equal(isStale(database, "home.html"), true)
  })

  await t.test("editing an existing target's abstract also marks the target itself stale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "home.html", abstract: { type: "page" }, metadata: {} })
    database.target.markFresh("home.html")

    database.target.create({ path: "home.html", abstract: { type: "page", extra: true }, metadata: {} })

    assert.equal(isStale(database, "home.html"), true)
  })

  await t.test("re-creating an existing target with unchanged data does NOT mark it stale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "home.html", abstract: { type: "page" }, metadata: { title: "Home" } })
    database.target.markFresh("home.html")

    database.target.create({ path: "home.html", abstract: { type: "page" }, metadata: { title: "Home" } })

    assert.equal(isStale(database, "home.html"), false)
  })
})
