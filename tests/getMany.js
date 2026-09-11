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
      { path: "a.html", metadata: { status: "published" } },
      { path: "b.html", metadata: { status: "draft" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { status: "published" }), ["a.html"])
    stop()
  })

  await t.test("'~' is contains: the field is an array with the value as an element", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { tags: ["AI", "Crypto"] } },
      { path: "b.html", metadata: { tags: ["Crypto"] } },
      { path: "c.html", metadata: { tags: "AI" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: { "~": "AI" } }), ["a.html"])
    stop()
  })

  await t.test("a bare scalar against an array field is equality, not contains", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { tags: ["AI", "Crypto"] } },
      { path: "b.html", metadata: { tags: "AI" } },
    ])

    assert.deepEqual(paths(database, { tags: "AI" }), ["b.html"])
  })

  await t.test("a bare array is '~' with an array: must contain every listed element", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { tags: ["AI", "Crypto", "Web3"] } },
      { path: "b.html", metadata: { tags: ["AI"] } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: ["AI", "Crypto"] }), ["a.html"])
    stop()
  })

  await t.test("'~' with an array behaves the same as a bare array", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { tags: ["AI", "Crypto"] } },
      { path: "b.html", metadata: { tags: ["AI"] } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { tags: { "~": ["AI", "Crypto"] } }), ["a.html"])
    stop()
  })

  await t.test("'!' under a field negates equality, including missing fields (what '!=' used to be)", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { status: "published" } },
      { path: "b.html", metadata: { status: "draft" } },
      { path: "c.html", metadata: { title: "C" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { status: { "!": "published" } }).sort(), ["b.html", "c.html"])
    stop()
  })

  await t.test("bare 'null' means the property is absent or explicitly null", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { deletedAt: "2024-01-01" } },
      { path: "b.html", metadata: { deletedAt: null, title: "B" } },
      { path: "c.html", metadata: { title: "C" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { deletedAt: null }).sort(), ["b.html", "c.html"])
    stop()
  })

  await t.test("comparison operators", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { rating: 3 } },
      { path: "b.html", metadata: { rating: 5 } },
    ])

    const stop1 = stopwatch()
    assert.deepEqual(paths(database, { rating: { ">": 4 } }), ["b.html"])
    stop1()

    const stop2 = stopwatch()
    assert.deepEqual(paths(database, { rating: { "<=": 3 } }), ["a.html"])
    stop2()
  })

  await t.test("'any of these' is '|' over the field (what 'in'/'any' used to be)", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { country: "Canada" } },
      { path: "b.html", metadata: { country: "France" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, { country: { "|": ["Canada", "USA"] } }), ["a.html"])
    stop()
  })

  await t.test("a label spelled like a former operator is just a label", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { in: "stock", all: "yes", any: 1 } },
      { path: "b.html", metadata: { in: "transit" } },
    ])

    assert.deepEqual(paths(database, { in: "stock" }), ["a.html"])
    assert.deepEqual(paths(database, { all: "yes", any: 1 }), ["a.html"])
  })

  await t.test("nested paths recurse into sub-objects", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { author: { expertise: ["AI", "Crypto"], country: "Canada" } } },
      { path: "b.html", metadata: { author: { expertise: ["AI"], country: "France" } } },
    ])

    const stop = stopwatch()
     const results = paths(database, {
      author: { expertise: ["AI", "Crypto"], country: { "|": ["Canada", "USA"] } }
    })
    stop()
    assert.deepEqual(results, ["a.html"])
  })

  await t.test("'|' ORs independent filters", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { category: "Tech", rating: 2 } },
      { path: "b.html", metadata: { category: "Food", rating: 5 } },
      { path: "c.html", metadata: { category: "Food", rating: 1 } },
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
      { path: "canada.html", metadata: { status: "published", views: 2000, author: { country: "Canada", theme: "Winter" } } },
      { path: "usa.html", metadata: { status: "published", views: 2000, author: { country: "USA", theme: "Winter" } } },
      { path: "summer.html", metadata: { status: "published", views: 2000, author: { country: "France", theme: "Summer" } } },
      { path: "notsummer.html", metadata: { status: "published", views: 2000, author: { country: "France", theme: "Winter" } } },
      { path: "unpublished.html", metadata: { status: "draft", views: 2000, author: { country: "Canada", theme: "Winter" } } },
      { path: "lowviews.html", metadata: { status: "published", views: 500, author: { country: "Canada", theme: "Winter" } } },
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
      { path: "a.html", metadata: { status: "published" } },
    ])

    const stop = stopwatch()
    assert.deepEqual(paths(database, {}), ["a.html"])
    stop()
  })
  await t.test("! over a multi-key object is NOT(AND), not NOT(OR)", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "both.html", metadata: { a: 1, b: 2 } },
      { path: "onlya.html", metadata: { a: 1, b: 9 } },
      { path: "neither.html", metadata: { a: 8, b: 9 } },
    ])

    // The previous implementation computed `1 - MAX(children)` - "no child
    // satisfied" - and returned only neither.html.
    assert.deepEqual(paths(database, { "!": { a: 1, b: 2 } }).sort(), ["neither.html", "onlya.html"])
  })

  await t.test("! over a | negates the whole disjunction", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "both.html", metadata: { a: 1, b: 2 } },
      { path: "onlya.html", metadata: { a: 1, b: 9 } },
      { path: "neither.html", metadata: { a: 8, b: 9 } },
    ])

    assert.deepEqual(paths(database, { "!": { "|": [{ a: 1 }, { b: 2 }] } }), ["neither.html"])
  })

  await t.test("nesting deeper than six levels is no longer truncated", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "deep.html", metadata: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } },
      { path: "shallow.html", metadata: { a: { b: 1 } } },
    ])

    // MAX_FILTER_DEPTH was 6, and anything below it was silently ignored -
    // so this filter used to match both rows.
    assert.deepEqual(paths(database, { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }), ["deep.html"])
  })

  await t.test("'~' against a scalar field does not match: contains needs an array", () => {
    const database = createDatabase(":memory:")
    seed(database, [
      { path: "a.html", metadata: { status: "published" } },
      { path: "b.html", metadata: { status: ["published"] } },
    ])

    assert.deepEqual(paths(database, { status: ["published"] }), ["b.html"])
  })

})
