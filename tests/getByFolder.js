import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function seed(database) {
  database.target.create({ path: "a.html", abstract: {}, metadata: { date: "2024-01-01" } })
  database.target.create({ path: "b.html", abstract: {}, metadata: { date: "2024-06-01" } })
  database.target.create({ path: "c.html", abstract: {}, metadata: { title: "C" } })
  database.target.create({ path: "d.html", abstract: {}, metadata: { date: "2024-03-01" } })
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
