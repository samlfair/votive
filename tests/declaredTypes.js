import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/**
 * A metadata value may be written as `{ $type, $value }`. Votive stores
 * `$value` as the value - reads are unchanged - and `$type` beside it,
 * exposed as `target.types[label]`. An unwrapped key's type is JSON's,
 * derived as it always was. See tasks/2-in-progress/declared-types.md.
 */

const seed = {
  date: { $type: "date", $value: "2026-09-16" },
  homepage: { $type: "url", $value: "https://example.com" },
  title: "Great",
  tags: ["flower", "tree"],
  count: 3,
  live: true
}

function assertShape(target, label) {
  assert.equal(target.metadata.date, "2026-09-16", `${label}: the value is unwrapped`)
  assert.equal(target.metadata.homepage, "https://example.com", label)
  assert.equal(target.metadata.title, "Great", label)
  assert.deepEqual(target.metadata.tags, ["flower", "tree"], label)
  assert.deepEqual(target.types, {
    date: "date",
    homepage: "url",
    title: "text",
    tags: "array",
    count: "integer",
    live: "true"
  }, `${label}: declared where given, JSON's otherwise`)
}

test("declared types: unwrapped at the write, exposed beside metadata on every read path", async (t) => {
  await t.test("target.get", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: seed })
    assertShape(database.target.get("a.html"), "target.get")
    assert.ok(!("$type" in database.target.get("a.html").metadata))
  })

  await t.test("target.getBySource", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", source: "a.md", metadata: seed })
    assertShape(database.target.getBySource("a.md"), "getBySource")
  })

  await t.test("target.getAll and getStale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: seed })
    assertShape(database.target.getAll()[0], "getAll")
    assertShape(database.target.getStale()[0], "getStale")
  })

  await t.test("target.getByFolder, filtered and not", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: seed })
    assertShape(database.target.getByFolder({ folder: "", dependent: "x" })[0], "getByFolder")
    const [found] = database.target.getByFolder({ folder: "", dependent: "x", query: { date: { ">": "2026-01-01" } } })
    assertShape(found, "getByFolder(query)")
    assert.equal(database.target.getByFolder({ folder: "", dependent: "x", query: { date: { ">": "2027-01-01" } } }).length, 0)
  })

  await t.test("a tracked read carries types too", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: seed })
    const target = database.target.getWithTrackers("a.html", "nav.html")
    assert.equal(target.types.date, "date")
    assert.equal(target.metadata.date, "2026-09-16")
  })
})

test("declared types: an update keeps, changes and drops the declaration with the key", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", metadata: seed })
  database.target.create({ path: "nav.html", metadata: {} })
  database.target.markFresh("nav.html")
  database.target.markFresh("a.html")

  const read = database.target.getWithTrackers("a.html", "nav.html")
  read.metadata.date

  // Same value, type dropped: the key's dependents are stale, since a
  // consumer that read a date now reads a string.
  database.target.create({ path: "a.html", metadata: { ...seed, date: "2026-09-16" } })
  assert.equal(database.target.get("a.html").types.date, "text")
  assert.equal(database.raw.prepare("SELECT stale FROM targets WHERE path = 'nav.html'").get().stale, 1)

  // Declared again with a different type.
  database.target.create({ path: "a.html", metadata: { ...seed, date: { $type: "datetime", $value: "2026-09-16" } } })
  assert.equal(database.target.get("a.html").types.date, "datetime")

  // Same declaration twice is not a change.
  database.target.markFresh("a.html")
  database.target.create({ path: "a.html", metadata: { ...seed, date: { $type: "datetime", $value: "2026-09-16" } } })
  assert.equal(database.raw.prepare("SELECT stale FROM targets WHERE path = 'a.html'").get().stale, 0)
})

test("declared types: only an exact { $type, $value } is a declaration, and $type is a lowercase name", () => {
  const database = createDatabase(":memory:")
  // An object that happens to have a $type key but other keys too is a value.
  database.target.create({ path: "a.html", metadata: { shape: { $type: "geo", $value: 1, extra: 2 } } })
  assert.deepEqual(database.target.get("a.html").metadata.shape, { $type: "geo", $value: 1, extra: 2 })
  assert.equal(database.target.get("a.html").types.shape, "object")

  // A malformed name is logged and the declaration kept as the plain
  // object it is - a bad value is coerced, never a reason to lose the
  // file (lib/attempt.js).
  const logged = []
  const logging = createDatabase(":memory:", { log: (level, message) => logged.push([level, message]) })
  logging.target.create({ path: "b.html", metadata: { date: { $type: "Date", $value: "x" } } })
  logging.target.create({ path: "c.html", metadata: { date: { $type: "", $value: "x" } } })
  assert.deepEqual(logging.target.get("b.html").metadata.date, { $type: "Date", $value: "x" })
  assert.equal(logging.target.get("b.html").types.date, "object")
  assert.equal(logged.length, 2)
  assert.match(logged[0][1], /lowercase/)
  assert.equal(logged[0][0], "error")
})

test("declared types: an object or array $value still reads back as a real object or array", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", metadata: { where: { $type: "geo", $value: { lat: 1, lng: 2 } }, when: { $type: "range", $value: [1, 2] } } })
  const target = database.target.get("a.html")
  assert.deepEqual(target.metadata.where, { lat: 1, lng: 2 })
  assert.deepEqual(target.metadata.when, [1, 2])
  assert.equal(target.types.where, "geo")
  assert.equal(target.types.when, "range")
})

test("declared types: an on-disk database from before the column gets it on open", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const { DatabaseSync } = await import("node:sqlite")
  const folder = await mkdtemp(path.join(tmpdir(), "votive-declared-"))
  const file = path.join(folder, ".votive.db")
  try {
    // Lay the schema down on disk, then take the column away, as an
    // older votive would have left it.
    const first = createDatabase(file)
    first.target.create({ path: "old.html", metadata: { title: "Old" } })
    await first.saveDB(true)
    first.close()
    const raw = new DatabaseSync(file)
    raw.exec("ALTER TABLE metadata DROP COLUMN declared_type")
    raw.close()

    const database = createDatabase(file)
    database.target.create({ path: "a.html", metadata: { date: { $type: "date", $value: "2026-01-01" } } })
    assert.equal(database.target.get("a.html").types.date, "date")
    assert.equal(database.target.get("old.html").types.title, "text")
    database.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("a new database path opens on disk from the first build, so nothing is backed up per pass", async () => {
  const path = await import("node:path")
  const { existsSync } = await import("node:fs")
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const folder = await mkdtemp(path.join(tmpdir(), "votive-ondisk-"))
  const file = path.join(folder, "nested", ".votive.db")
  try {
    const database = createDatabase(file)
    assert.equal(existsSync(file), true, "the file exists before any save")
    database.target.create({ path: "a.html", metadata: { title: "A" } })
    await database.saveDB(true)
    database.close()

    const reopened = createDatabase(file)
    assert.equal(reopened.target.get("a.html").metadata.title, "A")
    reopened.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
