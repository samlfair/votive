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
    database.target.create({ path: "blog/a.html", metadata: { title: "A" } })
    database.target.create({ path: "blog/sub/b.html", metadata: {} })

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
    database.target.create({ path: "blog/a.html", metadata: { title: "A" } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    assert.equal(isStale(database, "nav.html"), false)

    database.target.create({ path: "blog/b.html", metadata: {} })
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("a non-recursive 'folder' dependency ignores changes in a deeper subfolder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { title: "A" } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    database.target.create({ path: "blog/sub/deep.html", metadata: {} })

    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("a 'folder_recursive' dependency on an ancestor catches a change several levels deeper", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { title: "A" } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "", recursive: true, dependent: "nav.html" })
    database.target.create({ path: "blog/sub/deep.html", metadata: {} })

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("changing a property a folder dependent actually read stales it (lazy per-property tracking)", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { status: "draft" } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    const results = database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    results.forEach(target => target.metadata.status) // simulate a template reading this property

    database.target.create({ path: "blog/a.html", metadata: { status: "published" } })

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("changing a property a folder dependent never read does NOT stale it", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { status: "draft", views: 1 } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    const results = database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    results.forEach(target => target.metadata.status) // only reads `status`, never `views`

    database.target.create({ path: "blog/a.html", metadata: { status: "draft", views: 2 } })

    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("deleting a target stales its folder's dependents", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { title: "A" } })
    database.target.create({ path: "nav.html", metadata: {} })
    database.target.markFresh("nav.html")

    database.target.getByFolder({ folder: "blog", recursive: false, dependent: "nav.html" })
    database.target.delete("blog/a.html")

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("url.request records a type='url' dependency, and url.create stales every target that asked", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "post.html", metadata: {} })
    database.target.create({ path: "other.html", metadata: {} })
    database.target.markFresh("post.html")
    database.target.markFresh("other.html")

    database.url.request("https://example.com/embed", "post.html")

    const rows = database.dependency.getAllByTarget("https://example.com/embed")
    assert.deepEqual(rows.map(r => ({ dependent: r.dependent, type: r.type })), [
      { dependent: "post.html", type: "url" }
    ])

    database.url.create("https://example.com/embed", { title: "Example" })
    assert.deepEqual(database.url.get("https://example.com/embed"), { title: "Example" })
    const stale = database.target.getStale().map(target => target.path)
    assert.deepEqual(stale, ["post.html"])
  })

  await t.test("deleting a target cleans up its own metadata and dependency rows via the cleanup trigger", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: { title: "A" } })
    database.target.create({ path: "b.html", metadata: {} })
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
    database.target.create({ path: "home.html", data: "page", metadata: { title: "Home" } })
    database.target.markFresh("home.html")
    assert.equal(isStale(database, "home.html"), false)

    database.target.create({ path: "home.html", data: "page", metadata: { title: "Home Updated" } })

    assert.equal(isStale(database, "home.html"), true)
  })

  await t.test("editing an existing target's data also marks the target itself stale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "home.html", data: "page", metadata: {} })
    database.target.markFresh("home.html")

    database.target.create({ path: "home.html", data: "page-extra", metadata: {} })

    assert.equal(isStale(database, "home.html"), true)
  })

  await t.test("re-creating an existing target with unchanged data does NOT mark it stale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "home.html", data: "page", metadata: { title: "Home" } })
    database.target.markFresh("home.html")

    database.target.create({ path: "home.html", data: "page", metadata: { title: "Home" } })

    assert.equal(isStale(database, "home.html"), false)
  })
})

test("dependencies: a filtered listing tracks the labels it filters on", async (t) => {
  // A listing's filter is evaluated in SQL, so the labels it names are
  // never read in JS and nothing registered an edge for them. A page that
  // stopped matching was returned last time (so its other properties are
  // tracked) but its `tags` never was; a page that started matching was
  // not returned at all. See
  // tasks/2-in-progress/filtered-listings-dont-track-their-filter.md.

  /** Two tagged posts and a tag page that lists them. */
  function seed() {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { tags: ["foo"], title: "A" } })
    database.target.create({ path: "blog/b.html", metadata: { tags: ["foo"], title: "B" } })
    database.target.create({ path: "tags/foo.html", metadata: {} })
    return database
  }

  /** The tag page's listing, as vowel makes it. */
  function listTagged(database, tag = "foo") {
    return database.target.getByFolder({
      folder: "",
      recursive: true,
      dependent: "tags/foo.html",
      query: { tags: { "~": tag } }
    })
  }

  await t.test("the filter's labels are registered as folder edges", () => {
    const database = seed()
    listTagged(database)

    const rows = database.dependency.getAllByTarget("")
    const properties = rows
      .filter(row => row.dependent === "tags/foo.html")
      .map(row => row.property)
      .sort()

    // "" is the pre-existing membership edge; "tags" is the new one.
    assert.deepEqual(properties, ["", "tags"])
    assert.equal(rows.every(row => row.type === "folder_recursive"), true)
  })

  await t.test("a target that loses the filtered tag stales the listing", () => {
    const database = seed()
    assert.deepEqual(listTagged(database).map(t => t.path), ["blog/a.html", "blog/b.html"])
    database.target.markFresh("tags/foo.html")
    assert.equal(isStale(database, "tags/foo.html"), false)

    // b drops the tag. The row still exists, so no membership edge fires.
    database.target.create({ path: "blog/b.html", metadata: { tags: [], title: "B" } })

    assert.equal(isStale(database, "tags/foo.html"), true)
    assert.deepEqual(listTagged(database).map(t => t.path), ["blog/a.html"])
  })

  await t.test("a target that gains the filtered tag stales the listing", () => {
    const database = seed()
    database.target.create({ path: "blog/c.html", metadata: { tags: [], title: "C" } })
    listTagged(database)
    database.target.markFresh("tags/foo.html")

    // c was never in the result set, so it holds no per-property edge.
    database.target.create({ path: "blog/c.html", metadata: { tags: ["foo"], title: "C" } })

    assert.equal(isStale(database, "tags/foo.html"), true)
  })

  await t.test("deleting the filtered label entirely stales the listing", () => {
    const database = seed()
    listTagged(database)
    database.target.markFresh("tags/foo.html")

    database.target.create({ path: "blog/b.html", metadata: { title: "B" } })

    assert.equal(isStale(database, "tags/foo.html"), true)
  })

  await t.test("a change to an unrelated label does not stale the listing", () => {
    const database = seed()
    listTagged(database)
    database.target.markFresh("tags/foo.html")

    // `views` is named by no filter and read by nobody.
    database.target.create({ path: "blog/b.html", metadata: { tags: ["foo"], title: "B", views: 12 } })

    assert.equal(isStale(database, "tags/foo.html"), false)
  })

  await t.test("labels nested under |, ! and a JSON path are all collected", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/a.html", metadata: { status: "published" } })
    database.target.create({ path: "nav.html", metadata: {} })

    database.target.getByFolder({
      folder: "",
      recursive: true,
      dependent: "nav.html",
      query: {
        "|": { status: "published", featured: true },
        "!": { draft: true },
        author: { country: "Canada" }
      }
    })

    const properties = database.dependency.getAllByTarget("")
      .filter(row => row.dependent === "nav.html")
      .map(row => row.property)
      .sort()

    assert.deepEqual(properties, ["", "author", "draft", "featured", "status"])
  })

  await t.test("a non-recursive filtered listing registers 'folder' edges, not recursive ones", () => {
    const database = seed()
    database.target.getByFolder({
      folder: "blog",
      recursive: false,
      dependent: "tags/foo.html",
      query: { tags: { "~": "foo" } }
    })
    database.target.markFresh("tags/foo.html")

    // A deeper change must not reach a non-recursive dependent.
    database.target.create({ path: "blog/sub/deep.html", metadata: { tags: ["foo"] } })
    assert.equal(isStale(database, "tags/foo.html"), false)

    database.target.create({ path: "blog/a.html", metadata: { tags: [], title: "A" } })
    assert.equal(isStale(database, "tags/foo.html"), true)
  })
})
