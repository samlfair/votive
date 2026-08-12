import test from "node:test"
import assert from "node:assert/strict"
import createDatabase from "../lib/createDatabase.js"

test("urls: redirect/canonical lookup and failure tracking", async (t) => {
  await t.test("get() finds a cached result via the original, redirect, or canonical URL", () => {
    const database = createDatabase(":memory:")
    database.url.create("https://example.com/a", { title: "A" }, undefined, {
      redirect: "https://example.com/a-redirected",
      canonical: "https://example.com/canonical-a"
    })

    assert.deepEqual(database.url.get("https://example.com/a"), { title: "A" })
    assert.deepEqual(database.url.get("https://example.com/a-redirected"), { title: "A" })
    assert.deepEqual(database.url.get("https://example.com/canonical-a"), { title: "A" })
    assert.equal(database.url.get("https://example.com/unrelated"), undefined)
  })

  await t.test("get() returns undefined for a URL that has only failed, never succeeded", () => {
    const database = createDatabase(":memory:")
    database.url.recordFailure("https://example.com/dead")

    assert.equal(database.url.get("https://example.com/dead"), undefined)
  })

  await t.test("recordFailure increments failureCount and updates failedAt on repeated calls", () => {
    const database = createDatabase(":memory:")
    database.url.recordFailure("https://example.com/dead", 1000)
    database.url.recordFailure("https://example.com/dead", 2000)
    const status = database.url.recordFailure("https://example.com/dead", 3000)

    assert.equal(status.failureCount, 3)
    assert.equal(status.failedAt, 3000)
    assert.equal(status.data, null)
  })

  await t.test("a later success clears prior failure state", () => {
    const database = createDatabase(":memory:")
    database.url.recordFailure("https://example.com/flaky", 1000)
    database.url.recordFailure("https://example.com/flaky", 2000)

    database.url.create("https://example.com/flaky", { title: "Recovered" })

    const status = database.url.getStatus("https://example.com/flaky")
    assert.equal(status.failedAt, null)
    assert.equal(status.failureCount, 0)
    assert.deepEqual(JSON.parse(status.data), { title: "Recovered" })
  })
})
