import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function isStale(database, targetPath) {
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get(targetPath)
  return Boolean(row && row.stale)
}

test("settings, now backed by folder-scoped metadata rows", async (t) => {
  await t.test("a root-level setting appears at index 0 of a descendant's ancestor array", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "title", "My Site")

    const settings = database.setting.getByFolder("blog/2024")
    assert.equal(settings.title[0], "My Site")
    assert.equal(settings.title[1], null)
    assert.equal(settings.title[2], null)
  })

  await t.test("a folder-level setting only appears at that folder's own index", () => {
    const database = createDatabase(":memory:")
    database.setting.create("blog", "layout", "post")

    const settings = database.setting.getByFolder("blog/2024")
    assert.equal(settings.layout[0], null) // root
    assert.equal(settings.layout[1], "post") // blog
    assert.equal(settings.layout[2], null) // blog/2024

    const unrelated = database.setting.getByFolder("other")
    assert.equal(unrelated.layout, undefined) // "layout" has no row anywhere in "other"'s ancestor chain
  })

  await t.test("re-creating a setting under the same folder+label replaces rather than accumulates", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "stylesheets", "reset.css")
    database.setting.create("", "stylesheets", "typography.css")

    assert.equal(database.setting.getByFolder("").stylesheets[0], "typography.css")
  })

  await t.test("metadata rows written for a target (class='target') don't leak into settings.getAll", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: { title: "A" } })
    database.setting.create("", "title", "Site")

    const all = database.setting.getAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].label, "title")
    assert.equal(all[0].class, "folder_recursive")
  })

  await t.test("a target's own metadata query doesn't pick up folder-scoped settings", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: { status: "published" } })
    database.setting.create("", "title", "Site")

    const target = database.target.get("a.html")
    assert.deepEqual(target.metadata, { status: "published" })
  })

  await t.test("deleteBySource removes only that source's settings and stales the dependents that read it", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.create("", "title", "Initial")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").title[0] // simulate a template reading this

    database.setting.create("", "title", "Site", "settings.md")
    assert.equal(isStale(database, "nav.html"), true)
    database.target.markFresh("nav.html")

    database.setting.deleteBySource("settings.md")

    assert.deepEqual(database.setting.getAll(), [])
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: calling .push() on the array accumulates onto this folder's own row", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "stylesheets", "reset.css") // a label must already exist to be reachable via property access

    const settings = database.setting.getByFolder("")
    settings.stylesheets.push("typography.css")
    settings.stylesheets.push("default.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["reset.css", "typography.css", "default.css"])
  })

  await t.test("getByFolder: .push() upgrades a prior scalar value into an array on first push", () => {
    const database = createDatabase(":memory:")
    database.setting.create("blog", "tags", "only-one")
    database.setting.getByFolder("blog").tags.push("second")

    assert.deepEqual(database.setting.getByFolder("blog").tags[1], ["only-one", "second"])
  })

  await t.test("getByFolder: .push() always targets this folder's own row, regardless of ancestor depth read", () => {
    const database = createDatabase(":memory:")
    database.setting.create("blog", "stylesheets", "seed.css") // known at "blog", not yet at "blog/travel" or root

    const settings = database.setting.getByFolder("blog/travel")
    settings.stylesheets[0] // read root - should not affect where the push below lands
    settings.stylesheets.push("local.css")

    const check = database.setting.getByFolder("blog/travel")
    assert.equal(check.stylesheets[0], null) // root untouched
    assert.deepEqual(check.stylesheets[2], ["local.css"]) // blog/travel got it
  })

  await t.test("getByFolder: plain assignment overwrites this folder's own row", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "theme", "default")

    const settings = database.setting.getByFolder("")
    settings.theme = "updated"

    assert.equal(database.setting.getByFolder("").theme[0], "updated")
  })

  await t.test("getByFolder: a value obtained via indexing is a read-only snapshot", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "stylesheets", ["a.css"])

    const settings = database.setting.getByFolder("")
    const snapshot = settings.stylesheets[0]
    snapshot.push("should-not-save.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["a.css"])
  })

  await t.test("getByFolder: reading a specific ancestor index tracks a dependency scoped to exactly that folder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.create("", "theme", "Initial")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme[0] // reads only the root ancestor

    // A change at "blog" (a different ancestor than the one read, and already
    // a known label there once it exists at root) should NOT stale nav.html.
    database.setting.create("blog", "theme", "Dark")
    assert.equal(isStale(database, "nav.html"), false)

    // A change at "" (root, the one actually read) should stale it.
    database.setting.create("", "theme", "Light")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: iterating the whole array tracks every ancestor level it touches", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.create("", "theme", "Initial")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme.map(v => v) // touches every index, not just one

    database.setting.create("blog", "theme", "Dark")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: a change to a different, already-known label does not stale a dependent that only read another label", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.create("", "theme", "Initial")
    database.setting.create("", "stylesheets", "reset.css")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").theme[0]

    database.setting.create("", "stylesheets", "typography.css") // stylesheets already known - a plain update, not a first appearance
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("merge() sets one field of an object-valued setting without clobbering the rest", () => {
    const database = createDatabase(":memory:")
    database.setting.merge("").author = { name: "A", bio: "hello" }
    database.setting.merge("").author.name = "B"

    assert.deepEqual(database.setting.getByFolder("").author[0], { name: "B", bio: "hello" })
  })

  await t.test("merge() onto a non-object existing value discards it and starts fresh", () => {
    const database = createDatabase(":memory:")
    database.setting.create("x", "list", "a")
    database.setting.merge("x").list.extra = "nope"

    // folderAncestors("x") is ["", "x"] - index 1 is "x" itself.
    assert.deepEqual(database.setting.getByFolder("x").list[1], { extra: "nope" })
  })

  await t.test("getByFolder: Object.keys()/for-in/spread list every label set anywhere in the ancestor chain", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "title", "My Site")
    database.setting.create("blog", "layout", "post")

    const settings = database.setting.getByFolder("blog/2024")

    assert.deepEqual(Object.keys(settings).sort(), ["layout", "title"])

    const seen = []
    for (const label in settings) seen.push(label)
    assert.deepEqual(seen.sort(), ["layout", "title"])

    assert.deepEqual(Object.keys({ ...settings }).sort(), ["layout", "title"])
  })

  await t.test("getByFolder: a folder with no settings anywhere in its ancestor chain enumerates empty", () => {
    const database = createDatabase(":memory:")
    database.setting.create("other", "title", "Unrelated")

    assert.deepEqual(Object.keys(database.setting.getByFolder("blog/2024")), [])
  })

  await t.test("getByFolder: merely enumerating keys (no value read) does not register a dependency", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.create("", "title", "My Site")
    database.target.markFresh("nav.html")

    Object.keys(database.setting.getByFolder("", "nav.html"))

    database.setting.create("", "title", "Renamed Site")
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("getByFolder: a label with no row anywhere in the ancestor chain has no property at all", () => {
    const database = createDatabase(":memory:")
    const settings = database.setting.getByFolder("")

    assert.equal(settings.neverSet, undefined)
    assert.throws(() => settings.neverSet.push("x"), TypeError)
  })

  await t.test("getByFolder: plain assignment to a never-set label throws instead of silently creating an unpersisted property", () => {
    const database = createDatabase(":memory:")
    const settings = database.setting.getByFolder("")

    assert.throws(() => { settings.neverSet = "x" }, TypeError)
  })

  await t.test("setting.create: a label appearing for the first time in a folder's ancestor chain stales every existing target under that folder, recursively", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "blog/index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "blog/travel/index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "products/index.html", abstract: {}, metadata: {} })
    for (const path of ["index.html", "blog/index.html", "blog/travel/index.html", "products/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.create("blog", "accent_color", "Blue") // never set anywhere before

    assert.equal(isStale(database, "blog/index.html"), true) // blog itself
    assert.equal(isStale(database, "blog/travel/index.html"), true) // descendant of blog
    assert.equal(isStale(database, "index.html"), false) // root, not under blog
    assert.equal(isStale(database, "products/index.html"), false) // unrelated sibling folder

    for (const path of ["blog/index.html", "blog/travel/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.create("blog", "accent_color", "Green") // already known now - a plain update

    assert.equal(isStale(database, "blog/index.html"), false)
    assert.equal(isStale(database, "blog/travel/index.html"), false)
  })
})
