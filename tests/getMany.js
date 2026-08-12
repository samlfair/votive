import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

function stopwatch() {
  const start = performance.now()
  return () => console.log(`${performance.now() - start}ms`)
}

/** @param {ReturnType<createDatabase>} database */
function seed(database, targets) {
  for (const target of targets) database.target.create(target)
}

/** @param {ReturnType<createDatabase>} database */
function paths(database, query) {
  return database.target
    .getByFolder({ query, dependent: "dependent.html" })
    .map(target => target.path)
}

test("target.getMany filters", async (t) => {
  await t.test("bare scalar is equality", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { status: "published" } },
      { path: "b.html", abstract: {}, metadata: { status: "draft" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { status: "published" }), ["a.html"])
    stop()
  })

  await t.test("bare scalar also matches inside an array field", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { tags: ["AI", "Crypto"] } },
      { path: "b.html", abstract: {}, metadata: { tags: ["Crypto"] } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: "AI" }), ["a.html"])
    stop()
  })

  await t.test("bare array is 'all': must contain every listed element", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { tags: ["AI", "Crypto", "Web3"] } },
      { path: "b.html", abstract: {}, metadata: { tags: ["AI"] } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: ["AI", "Crypto"] }), ["a.html"])
    stop()
  })

  await t.test("explicit 'all' operator behaves the same as a bare array", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { tags: ["AI", "Crypto"] } },
      { path: "b.html", abstract: {}, metadata: { tags: ["AI"] } },
    ])


    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: { all: ["AI", "Crypto"] } }), ["a.html"])
    stop()
  })

  await t.test("'!=' negates equality-or-contains, including missing fields", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { status: "published" } },
      { path: "b.html", abstract: {}, metadata: { status: "draft" } },
      { path: "c.html", abstract: {}, metadata: { title: "C" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { status: { "!=": "published" } }).sort(), ["b.html", "c.html"])
    stop()
  })

  await t.test("bare 'null' means the property is absent or explicitly null", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { deletedAt: "2024-01-01" } },
      { path: "b.html", abstract: {}, metadata: { deletedAt: null, title: "B" } },
      { path: "c.html", abstract: {}, metadata: { title: "C" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { deletedAt: null }).sort(), ["b.html", "c.html"])
    stop()
  })

  await t.test("comparison operators", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { rating: 3 } },
      { path: "b.html", abstract: {}, metadata: { rating: 5 } },
    ])

    const stop1 = stopwatch()
    assert.deepEqual(paths(database, { rating: { ">": 4 } }), ["b.html"])
    stop1()

    const stop2 = stopwatch()
    assert.deepEqual(paths(database, { rating: { "<=": 3 } }), ["a.html"])
    stop2()
  })

  await t.test("'in' and 'any' match on overlap with a list", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { country: "Canada" } },
      { path: "b.html", abstract: {}, metadata: { country: "France" } },
    ])


    const stop1 = stopwatch()
    assert.deepEqual(paths(database, { country: { in: ["Canada", "USA"] } }), ["a.html"])
    stop1()

    const stop2 = stopwatch()
    assert.deepEqual(paths(database, { country: { any: ["Canada", "USA"] } }), ["a.html"])
    stop2()
  })

  await t.test("nested paths recurse into sub-objects", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { author: { expertise: ["AI", "Crypto"], country: "Canada" } } },
      { path: "b.html", abstract: {}, metadata: { author: { expertise: ["AI"], country: "France" } } },
    ])

    const stop = stopwatch()
     const results = paths(database, {
      author: { expertise: ["AI", "Crypto"], country: { in: ["Canada", "USA"] } }
    })
    stop()
    assert.deepEqual(results, ["a.html"])
  })

  await t.test("'|' ORs independent filters", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { category: "Tech", rating: 2 } },
      { path: "b.html", abstract: {}, metadata: { category: "Food", rating: 5 } },
      { path: "c.html", abstract: {}, metadata: { category: "Food", rating: 1 } },
    ])

    const stop = stopwatch()
    const results = paths(database, {
      "|": [
        { category: "Tech" },
        { rating: { ">": 4 } }
      ]
    })
    stop()

    assert.deepEqual(results.sort(), ["a.html", "b.html"])
  })

  await t.test("'|' nested under a path inherits that path (author.country, not a fresh 'country')", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "canada.html", abstract: {}, metadata: { status: "published", views: 2000, author: { country: "Canada", theme: "Winter" } } },
      { path: "usa.html", abstract: {}, metadata: { status: "published", views: 2000, author: { country: "USA", theme: "Winter" } } },
      { path: "summer.html", abstract: {}, metadata: { status: "published", views: 2000, author: { country: "France", theme: "Summer" } } },
      { path: "notsummer.html", abstract: {}, metadata: { status: "published", views: 2000, author: { country: "France", theme: "Winter" } } },
      { path: "unpublished.html", abstract: {}, metadata: { status: "draft", views: 2000, author: { country: "Canada", theme: "Winter" } } },
      { path: "lowviews.html", abstract: {}, metadata: { status: "published", views: 500, author: { country: "Canada", theme: "Winter" } } },
    ])
    // The CLAUDE.md example filter: published, enough views, and (Canadian OR American OR not-Summer-themed).

    const stop = stopwatch()
    const results = paths(database, {
      status: "published",
      views: { ">": 1000 },
      author: {
        "|": [
          { country: "Canada" },
          { country: "USA" },
          { "!": { theme: "Summer" } }
        ]
      }
    })
    stop()

    assert.deepEqual(results.sort(), ["canada.html", "notsummer.html", "usa.html"])
  })

  await t.test("empty filter matches every target", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", abstract: {}, metadata: { status: "published" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, {}), ["a.html"])
    stop()
  })
})
