import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolveProjectFolder } from "../lib/utils/resolveProjectFolder.js"

test("resolveProjectFolder", async (t) => {
  await t.test("returns an already-absolute path unchanged (modulo realpath)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      assert.equal(resolveProjectFolder(dir), dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("resolves a relative path against the given base", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      const child = path.join(dir, "blog")
      await mkdir(child)
      assert.equal(resolveProjectFolder("blog", { base: dir }), child)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("resolves a relative path against process.cwd() by default", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      const originalCwd = process.cwd()
      process.chdir(dir)
      try {
        assert.equal(resolveProjectFolder("."), dir)
      } finally {
        process.chdir(originalCwd)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("expands a ~/ prefix to the home directory", async () => {
    assert.equal(resolveProjectFolder("~/"), os.homedir())
  })

  await t.test("expands a bare ~ to the home directory", async () => {
    assert.equal(resolveProjectFolder("~"), os.homedir())
  })

  await t.test("does not treat a folder merely starting with ~ as a home-relative path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      const weird = path.join(dir, "~notHome")
      await mkdir(weird)
      assert.equal(resolveProjectFolder("~notHome", { base: dir }), weird)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("resolves a symlinked folder to its real path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      const real = path.join(dir, "real")
      const link = path.join(dir, "link")
      await mkdir(real)
      await symlink(real, link)
      assert.equal(resolveProjectFolder(link), real)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("two different-looking paths to the same real folder resolve identically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "votive-resolve-"))
    try {
      const real = path.join(dir, "real")
      const link = path.join(dir, "link")
      await mkdir(real)
      await symlink(real, link)
      assert.equal(resolveProjectFolder(link), resolveProjectFolder(real))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await t.test("throws for a folder that doesn't exist, rather than silently returning a bogus path", async () => {
    assert.throws(() => resolveProjectFolder("/definitely/not/a/real/path/hopefully"))
  })
})
