import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/** @param {ReturnType<createDatabase>} database */
function isStale(database, targetPath) {
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get(targetPath)
  return Boolean(row && row.stale)
}

test("settings: one writer per folder and label, cascading by ancestor", async (t) => {
  await t.test("a root-level contribution appears at index 0 of a descendant's ancestor array", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { title: "My Site" }, "settings.md")

    const settings = database.setting.getByFolder("blog/2024")
    assert.deepEqual(settings.title[0], ["My Site"])
    assert.equal(settings.title[1], null)
    assert.equal(settings.title[2], null)
  })

  await t.test("a folder-level contribution only appears at that folder's own index", () => {
    const database = createDatabase(":memory:")
    database.setting.write("blog", { layout: "post" }, "settings.md")

    const settings = database.setting.getByFolder("blog/2024")
    assert.equal(settings.layout[0], null) // root
    assert.deepEqual(settings.layout[1], ["post"]) // blog
    assert.equal(settings.layout[2], null) // blog/2024

    const unrelated = database.setting.getByFolder("other")
    assert.equal(unrelated.layout, undefined) // "layout" has no row anywhere in "other"'s ancestor chain
  })

  await t.test("write: a second source writing the same folder+label replaces it - last write wins - and records the new source", () => {
    const seen = []
    const database = createDatabase(":memory:", { log: (level, message) => seen.push([level, message]) })
    database.setting.write("", { stylesheets: "reset.css" }, "a.css")
    database.setting.write("", { stylesheets: "typography.css" }, "b.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["typography.css"])
    const row = database.setting.getAll().find(row => row.label === "stylesheets")
    assert.equal(row.source, "b.css")
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], "warn")
    assert.match(seen[0][1], /previously written by "a.css"/)
  })

  await t.test("write: an array value is stored as-is; a scalar becomes a one-element array", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { stylesheets: ["reset.css", "typography.css"], theme: "default" }, "settings.md")

    const settings = database.setting.getByFolder("")
    assert.deepEqual(settings.stylesheets[0], ["reset.css", "typography.css"])
    assert.deepEqual(settings.theme[0], ["default"])
  })

  await t.test("write: an empty array is not a contribution - the label is pruned as if it had been dropped", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { stylesheets: ["a.css"] }, "settings.md")
    database.setting.write("", { stylesheets: [] }, "settings.md")

    assert.equal(database.setting.getByFolder("").stylesheets, undefined)
  })

  await t.test("metadata rows written for a target (class='target') don't leak into settings.getAll", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: { title: "A" } })
    database.setting.write("", { title: "Site" }, "settings.md")

    const all = database.setting.getAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].label, "title")
    assert.equal(all[0].class, "folder_recursive")
  })

  await t.test("a target's own metadata query doesn't pick up folder-scoped settings", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", metadata: { status: "published" } })
    database.setting.write("", { title: "Site" }, "settings.md")

    const target = database.target.get("a.html")
    assert.deepEqual(target.metadata, { status: "published" })
  })

  await t.test("deleteBySource removes exactly that source's rows and no others", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { title: "Site", theme: "default" }, "settings.md")
    database.setting.write("blog", { layout: "post" }, "blog/settings.md")

    database.setting.deleteBySource("settings.md")

    assert.deepEqual(database.setting.getAll().map(row => [row.target, row.label]), [["blog", "layout"]])
  })

  await t.test("deleteBySource leaves nothing behind for a source that wrote one row", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { title: "Site" }, "settings.md")

    database.setting.deleteBySource("settings.md")

    assert.deepEqual(database.setting.getAll(), [])
  })

  await t.test("deleteBySource stales the dependents that read the row it touched", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("", { title: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").title[0] // simulate a template reading this

    database.setting.deleteBySource("settings.md")

    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: a value obtained via indexing is a fresh array each read, never a shared reference", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { stylesheets: "a.css" }, "settings.md")

    const settings = database.setting.getByFolder("")
    const snapshot = settings.stylesheets[0]
    snapshot.push("should-not-save.css")

    assert.deepEqual(database.setting.getByFolder("").stylesheets[0], ["a.css"])
  })

  await t.test("getByFolder: reading a specific ancestor index tracks a dependency scoped to exactly that folder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("", { theme: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme[0] // reads only the root ancestor

    // A change at "blog" (a different ancestor than the one read, and already
    // a known label there once it exists at root) should NOT stale nav.html.
    // A distinct source, matching what a real second file (blog/settings.md)
    // would actually be - reusing "settings.md" here would make this
    // accumulate() call's own cleanup step (see tasks/folder-staling-bug.md)
    // scan for and incidentally touch root's "settings.md"-contributed row
    // too, since deleteBySource() isn't folder-scoped.
    database.setting.write("blog", { theme: "Dark" }, "blog/settings.md")
    assert.equal(isStale(database, "nav.html"), false)

    // A change at "" (root, the one actually read) should stale it.
    database.setting.write("", { theme: "Light" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: iterating the whole array tracks every ancestor level it touches", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("", { theme: "Initial" }, "settings.md")
    database.target.markFresh("nav.html")

    const settings = database.setting.getByFolder("blog/travel", "nav.html")
    settings.theme.map(v => v) // touches every index, not just one

    // Distinct source, matching a real blog/settings.md file - see the
    // identical note in the previous test.
    database.setting.write("blog", { theme: "Dark" }, "blog/settings.md")
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("getByFolder: a change to a different, already-known label does not stale a dependent that only read another label", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("", { theme: "Initial" }, "settings.md")
    // A separate source for stylesheets, never touching "theme" at all -
    // accumulate() re-stales every label it touches on every call
    // regardless of whether the value actually changed (unrelated,
    // pre-existing behavior - not something to route around here), so
    // re-including "theme" in the second call below would stale nav.html
    // for a reason unrelated to what this test is actually checking.
    database.setting.write("", { stylesheets: "reset.css" }, "a.css")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("", "nav.html").theme[0]

    database.setting.write("", { stylesheets: "typography.css" }, "a.css") // stylesheets already known - a plain update, not a first appearance
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("getByFolder: Object.keys()/for-in/spread list every label set anywhere in the ancestor chain", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { title: "My Site" }, "settings.md")
    // Distinct source, matching a real blog/settings.md file - see the
    // identical note further up this file.
    database.setting.write("blog", { layout: "post" }, "blog/settings.md")

    const settings = database.setting.getByFolder("blog/2024")

    assert.deepEqual(Object.keys(settings).sort(), ["layout", "title"])

    const seen = []
    for (const label in settings) seen.push(label)
    assert.deepEqual(seen.sort(), ["layout", "title"])

    assert.deepEqual(Object.keys({ ...settings }).sort(), ["layout", "title"])
  })

  await t.test("getByFolder: a folder with no settings anywhere in its ancestor chain enumerates empty", () => {
    const database = createDatabase(":memory:")
    database.setting.write("other", { title: "Unrelated" }, "settings.md")

    assert.deepEqual(Object.keys(database.setting.getByFolder("blog/2024")), [])
  })

  await t.test("getByFolder: merely enumerating keys (no value read) does not register a dependency", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("", { title: "My Site" }, "settings.md")
    database.target.markFresh("nav.html")

    Object.keys(database.setting.getByFolder("", "nav.html"))

    database.setting.write("", { title: "Renamed Site" }, "settings.md")
    assert.equal(isStale(database, "nav.html"), false)
  })

  await t.test("getByFolder: a label with no row anywhere in the ancestor chain has no property at all", () => {
    const database = createDatabase(":memory:")
    const settings = database.setting.getByFolder("")

    assert.equal(settings.neverSet, undefined)
  })

  await t.test("getByFolder: plain assignment to any label throws - there is no write path through this object", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { theme: "default" }, "settings.md")
    const settings = database.setting.getByFolder("")

    assert.throws(() => { settings.theme = "updated" }, TypeError)
    assert.throws(() => { settings.neverSet = "x" }, TypeError)
  })

  await t.test("write: a label appearing for the first time in a folder's ancestor chain stales every existing target under that folder, recursively", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "index.html", metadata: {} })
    database.target.create({ path: "blog/index.html", metadata: {} })
    database.target.create({ path: "blog/travel/index.html", metadata: {} })
    database.target.create({ path: "products/index.html", metadata: {} })
    for (const path of ["index.html", "blog/index.html", "blog/travel/index.html", "products/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.write("blog", { accent_color: "Blue" }, "settings.md") // never set anywhere before

    assert.equal(isStale(database, "blog/index.html"), true) // blog itself
    assert.equal(isStale(database, "blog/travel/index.html"), true) // descendant of blog
    assert.equal(isStale(database, "index.html"), false) // root, not under blog
    assert.equal(isStale(database, "products/index.html"), false) // unrelated sibling folder

    for (const path of ["blog/index.html", "blog/travel/index.html"]) {
      database.target.markFresh(path)
    }

    database.setting.write("blog", { accent_color: "Green" }, "settings.md") // already known now - a plain update

    assert.equal(isStale(database, "blog/index.html"), false)
    assert.equal(isStale(database, "blog/travel/index.html"), false)
  })

  // tasks/folder-staling-bug.md: a source going from "contributes X" to
  // "contributes nothing" (or "contributes everything except X") has to
  // be reflected immediately - not deferred, and not silently dropped
  // just because the caller happened to skip calling accumulate() when
  // it had nothing new to say.

  await t.test("write: a source that stops contributing entirely removes everything it contributed and stales real dependents", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "nav.html", metadata: {} })
    database.setting.write("blog", { theme: "Dark", stylesheets: "reset.css" }, "blog/settings.md")
    database.target.markFresh("nav.html")

    database.setting.getByFolder("blog", "nav.html").theme[1] // index 1 = "blog" itself (folderAncestors("blog") is ["", "blog"])

    database.setting.write("blog", {}, "blog/settings.md") // settings.md deleted, or its frontmatter emptied entirely

    assert.deepEqual(database.setting.getByFolder("blog").theme, undefined)
    assert.deepEqual(database.setting.getByFolder("blog").stylesheets, undefined)
    assert.equal(isStale(database, "nav.html"), true)
  })

  await t.test("write: a source that drops one label while keeping another only stales the dropped label's dependents", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "theme-reader.html", metadata: {} })
    database.target.create({ path: "stylesheets-reader.html", metadata: {} })
    database.setting.write("blog", { theme: "Dark", stylesheets: "reset.css" }, "blog/settings.md")
    database.target.markFresh("theme-reader.html")
    database.target.markFresh("stylesheets-reader.html")

    database.setting.getByFolder("blog", "theme-reader.html").theme[1] // index 1 = "blog" itself
    database.setting.getByFolder("blog", "stylesheets-reader.html").stylesheets[1]

    database.setting.write("blog", { stylesheets: "reset.css" }, "blog/settings.md") // theme: dropped, stylesheets: unchanged

    assert.deepEqual(database.setting.getByFolder("blog").theme, undefined)
    assert.equal(isStale(database, "theme-reader.html"), true)
    // stylesheets-reader.html reads a label that's still present *and
    // unchanged* ("reset.css" both times) - accumulate() only stales
    // real dependents when the value actually differs from what was
    // already stored, not on every touch. See
    // tasks/folder-staling-bug.md's follow-up fix.
    assert.equal(isStale(database, "stylesheets-reader.html"), false)
  })

  await t.test("write: re-contributing the identical value does not stale a dependent, but a real change does", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "reader.html", metadata: {} })
    database.setting.write("blog", { theme: "Dark" }, "blog/settings.md")
    database.target.markFresh("reader.html")

    database.setting.getByFolder("blog", "reader.html").theme[1] // index 1 = "blog" itself

    // Same value, same source - simulates readFolders.js recomputing and
    // re-calling accumulate() on a pass triggered by something unrelated.
    database.setting.write("blog", { theme: "Dark" }, "blog/settings.md")
    assert.equal(isStale(database, "reader.html"), false)

    database.target.markFresh("reader.html")

    // A real change still correctly stales.
    database.setting.write("blog", { theme: "Light" }, "blog/settings.md")
    assert.equal(isStale(database, "reader.html"), true)
  })

  await t.test("write: dropping a label entirely does not resurrect it as a fresh 'first appearance' if re-added later", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "blog/index.html", metadata: {} })
    database.target.markFresh("blog/index.html")

    database.setting.write("blog", { theme: "Dark" }, "blog/settings.md") // first appearance - stales blog/index.html (under blog's subtree)
    database.target.markFresh("blog/index.html")

    database.setting.write("blog", {}, "blog/settings.md") // dropped
    database.target.markFresh("blog/index.html")

    database.setting.write("blog", { theme: "Light" }, "blog/settings.md") // re-added

    // Still a real, if surprising, characteristic of the "known labels"
    // check: it asks "does a live row exist anywhere in the ancestor
    // chain right now", not "has this exact label ever existed before" -
    // once dropped, a label's row is really gone, so re-adding it later
    // is indistinguishable from a genuine first appearance and correctly
    // re-triggers the coarse subtree sweep. Documented here as the
    // actual, intentional behavior - not something this fix was trying
    // to change.
    assert.equal(isStale(database, "blog/index.html"), true)
  })
})

test("settings resolvers: last(), lastNonNull(), firstNonNull(), flat(), raw()", async (t) => {
  await t.test("lastNonNull(): the nearest folder's value, leaf-upward, skipping empty levels", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { theme: "root" }, "settings.md")
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")

    assert.equal(database.setting.getByFolder("blog/travel").lastNonNull("theme"), "blog") // travel unset -> blog
    assert.equal(database.setting.getByFolder("blog").lastNonNull("theme"), "blog")
    assert.equal(database.setting.getByFolder("other").lastNonNull("theme"), "root")
    assert.equal(database.setting.getByFolder("").lastNonNull("theme"), "root")
  })

  await t.test("last(): the folder's own slot, literally - null when the folder itself set nothing", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { theme: "root" }, "settings.md")
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")

    assert.equal(database.setting.getByFolder("blog").last("theme"), "blog")
    // travel set nothing: null, not blog. That is the ambiguity that
    // used to hide behind one `last`.
    assert.equal(database.setting.getByFolder("blog/travel").last("theme"), null)
    assert.equal(database.setting.getByFolder("blog/travel").lastNonNull("theme"), "blog")
    assert.equal(database.setting.getByFolder("").last("theme"), "root")
    assert.equal(database.setting.getByFolder("").last("neverSet"), undefined)
  })

  await t.test("firstNonNull(): the root-most value, skipping empty levels downward", () => {
    const database = createDatabase(":memory:")
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")
    database.setting.write("blog/travel", { theme: "travel" }, "blog/travel/settings.md")

    // root set nothing, so the first non-null is blog's, not travel's.
    assert.equal(database.setting.getByFolder("blog/travel").firstNonNull("theme"), "blog")
    assert.equal(database.setting.getByFolder("blog/travel").lastNonNull("theme"), "travel")
    assert.equal(database.setting.getByFolder("blog/travel").last("theme"), "travel")
    assert.equal(database.setting.getByFolder("other").firstNonNull("theme"), undefined)
  })

  await t.test("flat(): every value at every level, root first", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { stylesheets: ["reset.css", "default.css"] }, "settings.md")
    database.setting.write("blog", { stylesheets: "blog.css" }, "blog/styles.css")

    assert.deepEqual(database.setting.getByFolder("blog/travel").flat("stylesheets"), ["reset.css", "default.css", "blog.css"])
    assert.deepEqual(database.setting.getByFolder("other").flat("stylesheets"), ["reset.css", "default.css"])
  })

  await t.test("raw(): the ancestor array exactly as the property gives it", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { breadcrumb: "Home" }, "settings.md")
    database.setting.write("blog", { breadcrumb: "Blog" }, "blog/settings.md")

    const settings = database.setting.getByFolder("blog/travel")
    assert.deepEqual(settings.raw("breadcrumb"), [["Home"], ["Blog"], null])
    assert.deepEqual(settings.raw("breadcrumb"), settings.breadcrumb)
  })

  await t.test("an unset label resolves to undefined / [] / undefined rather than throwing", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { theme: "root" }, "settings.md")

    const settings = database.setting.getByFolder("blog")
    assert.equal(settings.lastNonNull("neverSet"), undefined)
    assert.deepEqual(settings.flat("neverSet"), [])
    assert.equal(settings.raw("neverSet"), undefined)
  })

  await t.test("the resolvers are not labels: Object.keys, for-in and JSON.stringify show only labels", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { theme: "root" }, "settings.md")

    const settings = database.setting.getByFolder("")
    assert.deepEqual(Object.keys(settings), ["theme"])
    const seen = []
    for (const label in settings) seen.push(label)
    assert.deepEqual(seen, ["theme"])
    assert.equal(JSON.stringify(settings), JSON.stringify({ theme: [["root"]] }))
  })

  await t.test("a label named after a resolver fails loudly rather than shadowing it", () => {
    const database = createDatabase(":memory:")
    database.setting.write("", { last: "x" }, "settings.md")
    assert.throws(() => database.setting.getByFolder(""), /cannot be labelled "last"/)
  })

  await t.test("lastNonNull() tracks the deciding level: a change there stales the dependent", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", metadata: {} })
    database.setting.write("", { theme: "root" }, "settings.md")
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")
    database.target.markFresh("page.html")

    database.setting.getByFolder("blog/travel", "page.html").lastNonNull("theme") // decided at "blog"

    database.setting.write("blog", { theme: "blog-2" }, "blog/settings.md")
    assert.equal(isStale(database, "page.html"), true)
  })

  await t.test("lastNonNull() does not track a level above the deciding one: a change there leaves the dependent fresh", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", metadata: {} })
    database.setting.write("", { theme: "root" }, "settings.md")
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")
    database.target.markFresh("page.html")

    database.setting.getByFolder("blog/travel", "page.html").lastNonNull("theme") // decided at "blog"; root never read

    database.setting.write("", { theme: "root-2" }, "settings.md")
    assert.equal(isStale(database, "page.html"), false)
  })

  await t.test("lastNonNull() tracks the empty levels below the deciding one: a value appearing there stales the dependent", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", metadata: {} })
    database.setting.write("", { theme: "root" }, "settings.md")
    database.target.markFresh("page.html")

    database.setting.getByFolder("blog/travel", "page.html").lastNonNull("theme") // read travel (empty), blog (empty), root

    // The label is already known in the chain, so this is not a
    // first-appearance subtree stale - it has to come from the tracked
    // read of the empty "blog" slot.
    database.setting.write("blog", { theme: "blog" }, "blog/settings.md")
    assert.equal(isStale(database, "page.html"), true)
  })

  await t.test("flat() tracks every level", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "page.html", metadata: {} })
    database.setting.write("", { stylesheets: "root.css" }, "settings.md")
    database.setting.write("blog", { stylesheets: "blog.css" }, "blog/styles.css")
    database.target.markFresh("page.html")

    database.setting.getByFolder("blog/travel", "page.html").flat("stylesheets")

    database.setting.write("", { stylesheets: "root-2.css" }, "settings.md")
    assert.equal(isStale(database, "page.html"), true)
  })
})

test("schema version: an on-disk database from a different user_version is discarded and started fresh", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const { DatabaseSync } = await import("node:sqlite")

  const folder = await mkdtemp(path.join(tmpdir(), "votive-schema-"))
  const databasePath = path.join(folder, ".votive.db")
  try {
    // A database written by an older votive: same tables, rows in the
    // accumulator's {value, source} shape, user_version 0.
    const first = createDatabase(":memory:")
    first.setting.write("", { theme: "default" }, "settings.md")
    first.raw.exec("PRAGMA user_version = 0")
    first.raw.exec("UPDATE metadata SET value = '[{\"value\":\"default\",\"source\":\"settings.md\"}]'")
    await new Promise((resolve, reject) => {
      const out = new DatabaseSync(databasePath)
      out.close()
      import("node:sqlite").then(({ backup }) => backup(first.raw, databasePath)).then(resolve, reject)
    })
    first.raw.close()
    assert.equal(new DatabaseSync(databasePath, { readOnly: true }).prepare("PRAGMA user_version").get().user_version, 0)

    const reopened = createDatabase(databasePath)
    assert.deepEqual(reopened.setting.getAll(), [], "old rows should not survive a schema version change")
    assert.equal(reopened.raw.prepare("PRAGMA user_version").get().user_version, 2)
    reopened.raw.close()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("setting.distinct: every distinct value written for a label at any folder, objects parsed", () => {
  const database = createDatabase(":memory:")
  database.setting.write("", { theme: "default", title: "Site" }, "settings.md")
  database.setting.write("blog", { theme: { name: "default", colors: ["#111", "#222"] } }, "blog/settings.md")
  database.setting.write("shop", { theme: "reset" }, "shop/settings.md")
  database.setting.write("shop/hats", { theme: "reset" }, "shop/hats/settings.md")

  const themes = database.setting.distinct("theme")
  assert.deepEqual(themes.map(value => JSON.stringify(value)).sort(), [
    JSON.stringify({ name: "default", colors: ["#111", "#222"] }),
    JSON.stringify("default"),
    JSON.stringify("reset")
  ].sort())
  assert.deepEqual(database.setting.distinct("nothing"), [])
})
