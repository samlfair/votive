import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function seed(database) {
  database.target.create({ path: "a.html", metadata: { date: "2024-01-01" } })
  database.target.create({ path: "b.html", metadata: { date: "2024-06-01" } })
  database.target.create({ path: "c.html", metadata: { title: "C" } })
  database.target.create({ path: "d.html", metadata: { date: "2024-03-01" } })
}

test("target.getByFolder: orderBy", async (t) => {
  await t.test("orders descending by a metadata property, undated entries last", () => {
    const database = createDatabase(":memory:")
    seed(database)

    const results = database.target.getByFolder({
      folder: "", recursive: true, dependent: "d.html",
      orderBy: { property: "date", direction: "desc" }
    })

    assert.deepEqual(results.map(r => r.path), ["b.html", "d.html", "a.html", "c.html"])
  })

  await t.test("orders ascending by default", () => {
    const database = createDatabase(":memory:")
    seed(database)

    const results = database.target.getByFolder({
      folder: "", recursive: true, dependent: "d.html",
      orderBy: { property: "date" }
    })

    assert.deepEqual(results.map(r => r.path), ["a.html", "d.html", "b.html", "c.html"])
  })

  await t.test("no orderBy leaves SQL's own order (by path) untouched", () => {
    const database = createDatabase(":memory:")
    seed(database)

    const results = database.target.getByFolder({ folder: "", recursive: true, dependent: "d.html" })

    assert.deepEqual(results.map(r => r.path), ["a.html", "b.html", "c.html", "d.html"])
  })
})

test("target.getByFolder: limit", async (t) => {
  await t.test("limit alone (no orderBy) takes the first N in SQL's path order", () => {
    const database = createDatabase(":memory:")
    seed(database)

    const results = database.target.getByFolder({ folder: "", recursive: true, dependent: "d.html", limit: 2 })

    assert.deepEqual(results.map(r => r.path), ["a.html", "b.html"])
  })

  await t.test("limit + orderBy applies the limit AFTER sorting, not before", () => {
    const database = createDatabase(":memory:")
    seed(database)

    // Regression: limit used to be bound into the SQL query, which orders
    // by path - applying it before the client-side orderBy sort truncated
    // the wrong rows whenever both were used together (e.g. "most recent
    // 2 posts", which is exactly this combination).
    const results = database.target.getByFolder({
      folder: "", recursive: true, dependent: "d.html",
      orderBy: { property: "date", direction: "desc" },
      limit: 2
    })

    assert.deepEqual(results.map(r => r.path), ["b.html", "d.html"])
  })

  await t.test("no limit returns everything in scope", () => {
    const database = createDatabase(":memory:")
    seed(database)

    const results = database.target.getByFolder({ folder: "", recursive: true, dependent: "d.html" })

    assert.equal(results.length, 4)
  })
})

test("getByFolder: data is lazy - not in the listing's row, fetched and tracked on access", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", data: "<p>a</p>", metadata: { title: "A" } })
  database.target.create({ path: "nav.html", metadata: {} })
  database.target.markFresh("nav.html")

  const [target] = database.target.getByFolder({ folder: "", dependent: "nav.html" })
  assert.equal(Object.keys(target).includes("data"), true, "data is still an enumerable property")
  assert.equal(database.dependency.getAllByTarget("a.html").some(row => row.property === "data"), false, "not tracked until read")
  assert.equal(target.data, "<p>a</p>")
  assert.equal(database.dependency.getAllByTarget("a.html").some(row => row.property === "data"), true, "tracked once read")

  database.target.setData("a.html", "<p>changed</p>")
  assert.equal(database.raw.prepare("SELECT stale FROM targets WHERE path = 'nav.html'").get().stale, 1)

  // Untracked (no dependent): still readable.
  const [plain] = database.target.getByFolder({ folder: "" })
  assert.equal(plain.data, "<p>changed</p>")
})

test("every metadata property is lazy: fetched and tracked on access, whole object still iterable and serializable", () => {
  const database = createDatabase(":memory:")
  const tree = { type: "root", children: [{ type: "text", value: "big" }] }
  database.target.create({ path: "a.html", metadata: { title: "A", tags: ["x", "y"], draft: false, hastAbstract: tree } })
  database.target.create({ path: "reader.html", metadata: {} })
  database.target.markFresh("reader.html")

  // A listing.
  const [listed] = database.target.getByFolder({ folder: "", query: { title: "A" }, dependent: "reader.html" })
  const tracked = () => database.dependency.getAllByTarget("a.html").map(row => row.property).sort()
  assert.deepEqual(tracked(), [], "nothing tracked before a property is read")
  assert.equal(listed.metadata.title, "A")
  assert.deepEqual(tracked(), ["title"], "only what was read")
  assert.deepEqual(listed.metadata.tags, ["x", "y"])
  assert.equal(listed.metadata.draft, false, "a boolean round-trips")
  assert.deepEqual(listed.metadata.hastAbstract, tree)
  assert.deepEqual(Object.keys(listed.metadata).sort(), ["draft", "hastAbstract", "tags", "title"])
  assert.deepEqual(JSON.parse(JSON.stringify(listed.metadata)).tags, ["x", "y"])
  assert.equal("title" in listed.metadata, true)
  assert.equal("missing" in listed.metadata, false)

  // A single target, tracked and untracked.
  database.target.create({ path: "other.html", metadata: {} })
  database.target.markFresh("other.html")
  const one = database.target.getWithTrackers("a.html", "other.html")
  assert.equal(database.dependency.getAllByTarget("a.html").some(row => row.dependent === "other.html" && row.property === "tags"), false)
  assert.deepEqual(one.metadata.tags, ["x", "y"])
  assert.equal(database.dependency.getAllByTarget("a.html").some(row => row.dependent === "other.html" && row.property === "tags"), true)
  assert.equal(database.target.get("a.html").metadata.title, "A")

  // An unrelated change leaves the reader alone; the property it read does not.
  database.target.create({ path: "a.html", metadata: { title: "A", tags: ["x", "y"], draft: false, hastAbstract: tree, views: 1 } })
  assert.equal(database.raw.prepare("SELECT stale FROM targets WHERE path = 'other.html'").get().stale, 0)
  database.target.create({ path: "a.html", metadata: { title: "A", tags: ["x"], draft: false, hastAbstract: tree, views: 1 } })
  assert.equal(database.raw.prepare("SELECT stale FROM targets WHERE path = 'other.html'").get().stale, 1)
})

test("getByFolder: a target with no metadata at all is still listed", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "bare.html", metadata: {} })
  database.target.create({ path: "a.html", metadata: { title: "A" } })
  assert.deepEqual(database.target.getByFolder({ folder: "" }).map(target => target.path).sort(), ["a.html", "bare.html"])
  assert.deepEqual(database.target.getByFolder({ folder: "" }).find(target => target.path === "bare.html").metadata, {})
})
