import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

/**
 * metadata.value is stored as raw JSON text for arrays/objects (see
 * buildFilterQuery.js's header comment), but every read path aggregates
 * rows back into an object via json_group_object/json_object - which
 * treats a TEXT value as an opaque string unless told it's already JSON.
 * These checks make sure array/object-valued properties come back as
 * real JS arrays/objects, not JSON-encoded strings, everywhere metadata
 * gets read.
 */
test("metadata values round-trip as real JS types, not JSON-encoded strings", async (t) => {
  const seedMetadata = { views: 1000, active: true, note: null, tags: ["AI", "Crypto"], author: { name: "A" } }

  function assertShape(metadata, label) {
    assert.equal(typeof metadata.views, "number", `${label}: views should be a number`)
    assert.deepEqual(metadata.tags, ["AI", "Crypto"], `${label}: tags should be a real array`)
    assert.deepEqual(metadata.author, { name: "A" }, `${label}: author should be a real object`)
  }

  await t.test("target.get", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    assertShape(database.target.get("a.html").metadata, "target.get")
  })

  await t.test("target.getAll", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    const target = database.target.getAll().find(t => t.path === "a.html")
    assertShape(target.metadata, "target.getAll")
  })

  await t.test("target.getStale", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    const target = database.target.getStale().find(t => t.path === "a.html")
    assertShape(target.metadata, "target.getStale")
  })

  await t.test("getManyWithTrackers - empty filter path (buildGetManyEmptySQL)", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    const results = database.target.getManyWithTrackers({ query: {}, dependent: "d.html" })
    assertShape(results.find(t => t.path === "a.html").metadata, "getManyWithTrackers (empty)")
  })

  await t.test("getManyWithTrackers - filter engine path (buildGetManySQL)", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    const results = database.target.getManyWithTrackers({ query: { active: true }, dependent: "d.html" })
    assertShape(results.find(t => t.path === "a.html").metadata, "getManyWithTrackers (filtered)")
  })

  await t.test("target.getByFolder", () => {
    const database = createDatabase(":memory:")
    database.target.create({ path: "a.html", abstract: {}, metadata: seedMetadata })
    const results = database.target.getByFolder({ dependent: "d.html" })
    assertShape(results.find(t => t.path === "a.html").metadata, "target.getByFolder")
  })

  await t.test("setting.getByFolder", () => {
    const database = createDatabase(":memory:")
    database.setting.create("", "stylesheets", ["reset.css", "typography.css"])
    const settings = database.setting.getByFolder("")
    assert.deepEqual(settings.stylesheets[0], ["reset.css", "typography.css"])
  })
})
