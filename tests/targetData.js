import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

test("target.create stores a target's own `data`, independent of abstract", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", abstract: {}, metadata: {}, data: "hello world" })

  assert.equal(database.target.get("a.html").data, "hello world")
})

test("target.create: omitting `data` on an update leaves the existing value untouched", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", abstract: {}, metadata: {}, data: "original" })
  database.target.create({ path: "a.html", abstract: {}, metadata: { title: "A" } }) // no `data` key at all

  assert.equal(database.target.get("a.html").data, "original")
})

test("target.create: explicitly changing `data` updates it and marks the target stale", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", abstract: {}, metadata: {}, data: "original" })
  database.target.markFresh("a.html")

  database.target.create({ path: "a.html", abstract: {}, metadata: {}, data: "updated" })

  assert.equal(database.target.get("a.html").data, "updated")
  const row = database.raw.prepare("SELECT stale FROM targets WHERE path = ?").get("a.html")
  assert.equal(Boolean(row.stale), true)
})

test("a target with no `data` ever set reads back as null", () => {
  const database = createDatabase(":memory:")
  database.target.create({ path: "a.html", abstract: {}, metadata: {} })

  assert.equal(database.target.get("a.html").data, null)
})
