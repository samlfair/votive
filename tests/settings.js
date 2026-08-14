import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function isStale(database, targetPath) {
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get(targetPath)
  return Boolean(row && row.stale)
}

test("settings, now backed by accumulating folder-scoped metadata rows", async (t) => {
  await t.test("a root-level contribution appears at index 0 of a descendant's ancestor array", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { title: "My Site" }, "settings.md")

    const settings = database.setting.getByFolder("blog/2024")
    assert.deepEqual(settings.title[0], ["My Site"])
    assert.deepEqual(settings.title[1], [])
    assert.deepEqual(settings.title[2], [])
  })

  await t.test("a folder-level contribution only appears at that folder's own index", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("blog", { layout: "post" }, "settings.md")

    const settings = database.setting.getByFolder("blog/2024")
    assert.deepEqual(settings.layout[0], []) // root
    assert.deepEqual(settings.layout[1], ["post"]) // blog
    assert.deepEqual(settings.layout[2], []) // blog/2024

    const unrelated = database.setting.getByFolder("other")
    assert.equal(unrelated.layout, undefined) // "layout" has no row anywhere in "other"'s ancestor chain
  })

  await t.test("accumulate: a second contribution to the same folder+label appends rather than replacing", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { stylesheets: "reset.css" }, "a.css")
    database.setting.accumulate("", { stylesheets: "typography.css" }, "b.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["reset.css", "typography.css"])
  })

  await t.test("accumulate: an array value is spread - each element becomes its own contribution", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { stylesheets: ["reset.css", "typography.css"] }, "settings.md")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["reset.css", "typography.css"])
  })

  await t.test("accumulate: a non-array value is pushed as a single contribution", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { theme: "default" }, "settings.md")

    assert.deepEqual(database.setting.getByFolder("").theme[0], ["default"])
  })

  await t.test("metadata rows written for a target (class='target') don't leak into settings.getAll", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: { title: "A" } })
    database.setting.accumulate("", { title: "Site" }, "settings.md")

    const all = database.setting.getAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].label, "title")
    assert.equal(all[0].class, "folder_recursive")
  })

  await t.test("a target's own metadata query doesn't pick up folder-scoped settings", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: { status: "published" } })
    database.setting.accumulate("", { title: "Site" }, "settings.md")

    const target = database.target.get("a.html")
    assert.deepEqual(target.metadata, { status: "published" })
  })

  await t.test("deleteBySource removes only that source's contributions, leaving other sources' contributions to the same row intact", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { stylesheets: "reset.css" }, "a.css")
    database.setting.accumulate("", { stylesheets: "typography.css" }, "b.css")

    database.setting.deleteBySource("a.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["typography.css"])
  })

  await t.test("deleteBySource deletes the row outright once its last contribution is removed", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { title: "Site" }, "settings.md")

    database.setting.deleteBySource("settings.md")

    assert.deepEqual(database.setting.getAll(), [])
  })

  await t.test("deleteBySource stales the dependents that read the row it touched", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.accumulate("", { title: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").title[0] // simulate a template reading this

    database.setting.deleteBySource("settings.md")

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: a value obtained via indexing is a fresh array each read, never a shared reference", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { stylesheets: "a.css" }, "settings.md")

    const settings = database.setting.getByFolder("")
    const snapshot = settings.stylesheets[0]
    snapshot.push("should-not-save.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["a.css"])
  })

  await t.test("getByFolder: reading a specific ancestor index tracks a dependency scoped to exactly that folder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.accumulate("", { theme: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme[0] // reads only the root ancestor

    // A change at "blog" (a different ancestor than the one read, and already
    // a known label there once it exists at root) should NOT stale nav.html.
    database.setting.accumulate("blog", { theme: "Dark" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), false)

    // A change at "" (root, the one actually read) should stale it.
    database.setting.accumulate("", { theme: "Light" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: iterating the whole array tracks every ancestor level it touches", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.accumulate("", { theme: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme.map(v => v) // touches every index, not just one

    database.setting.accumulate("blog", { theme: "Dark" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: a change to a different, already-known label does not stale a dependent that only read another label", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.accumulate("", { theme: "Initial", stylesheets: "reset.css" }, "settings.md")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").theme[0]

    database.setting.accumulate("", { stylesheets: "typography.css" }, "settings.md") // stylesheets already known - a plain update, not a first appearance
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("getByFolder: Object.keys()/for-in/spread list every label set anywhere in the ancestor chain", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { title: "My Site" }, "settings.md")
    database.setting.accumulate("blog", { layout: "post" }, "settings.md")

    const settings = database.setting.getByFolder("blog/2024")

    assert.deepEqual(Object.keys(settings).sort(), ["layout", "title"])

    const seen = []
    for (const label in settings) seen.push(label)
    assert.deepEqual(seen.sort(), ["layout", "title"])

    assert.deepEqual(Object.keys({ ...settings }).sort(), ["layout", "title"])
  })

  await t.test("getByFolder: a folder with no settings anywhere in its ancestor chain enumerates empty", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("other", { title: "Unrelated" }, "settings.md")

    assert.deepEqual(Object.keys(database.setting.getByFolder("blog/2024")), [])
  })

  await t.test("getByFolder: merely enumerating keys (no value read) does not register a dependency", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", abstract: {}, metadata: {} })
    database.setting.accumulate("", { title: "My Site" }, "settings.md")
    database.target.markFresh("nav.html")

    Object.keys(database.setting.getByFolder("", "nav.html"))

    database.setting.accumulate("", { title: "Renamed Site" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("getByFolder: a label with no row anywhere in the ancestor chain has no property at all", () => {
    const database = createDatabase(":memory:")
    const settings = database.setting.getByFolder("")

    assert.equal(settings.neverSet, undefined)
  })

  await t.test("getByFolder: plain assignment to any label throws - there is no write path through this object", () => {
    const database = createDatabase(":memory:")
    database.setting.accumulate("", { theme: "default" }, "settings.md")
    const settings = database.setting.getByFolder("")

    assert.throws(() => { settings.theme = "updated" }, TypeError)
    assert.throws(() => { settings.neverSet = "x" }, TypeError)
  })

  await t.test("accumulate: a label appearing for the first time in a folder's ancestor chain stales every existing target under that folder, recursively", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "blog/index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "blog/travel/index.html", abstract: {}, metadata: {} })
    database.target.create({ path: "products/index.html", abstract: {}, metadata: {} })
    for (const path of ["index.html", "blog/index.html", "blog/travel/index.html", "products/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.accumulate("blog", { accent_color: "Blue" }, "settings.md") // never set anywhere before

    assert.equal(isStale(database, "blog/index.html"), true) // blog itself
    assert.equal(isStale(database, "blog/travel/index.html"), true) // descendant of blog
    assert.equal(isStale(database, "index.html"), false) // root, not under blog
    assert.equal(isStale(database, "products/index.html"), false) // unrelated sibling folder

    for (const path of ["blog/index.html", "blog/travel/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.accumulate("blog", { accent_color: "Green" }, "settings.md") // already known now - a plain update

    assert.equal(isStale(database, "blog/index.html"), false)
    assert.equal(isStale(database, "blog/travel/index.html"), false)
  })
})
