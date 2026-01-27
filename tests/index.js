import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as votive from "votive/internals"
import { stopwatch } from "./../lib/utils/index.js"
import { readFolders, runJobs } from "../lib/index.js"

/** @import {VotiveConfig, VotivePlugin, FlatProcessors, VotiveProcessor, Runner, Job} from "./../lib/bundle.js" */

process.chdir("./tests")

test("empty directory", async () => {
  const temp = fs.mkdtempDisposableSync("destination-")

  try {
    const stop = stopwatch("Bundle empty folder")
    await votive.bundle({
      sourceFolder: "./empty",
      destinationFolder: temp.path
    })

    stop()

    const dir = fs.readdirSync(temp.path)
    assert(dir.length === 0, "Destination directory is not empty.")
  } catch (error) {
    temp.remove()
    console.error(error)

  }

  temp.remove()
})

test("create empty database", () => {
  const stop = stopwatch("Create empty database")
  const database = votive.createDatabase()
  stop()

  database.createSource('exampleSource', 'exampleDestination', 123)
  const [source] = database.getAllSources()
  
  assert(source.destination === 'exampleDestination')
})

test("read sources", async () => {
  const temp = fs.mkdtempDisposableSync("destination-")

  /** @type {Job} */
  const testJob = {
    data: "123",
    runner: "testRunner"
  }

  /** @type {VotiveProcessor} */
  const testProcessor = {
    syntax: "txt",
    filter: {
      extensions: [".md"]
    },
    read: {
      path: (filePath, database, config) => undefined,
      text: (text, database, config) => ({ metadata: { foo: "bar", bang: "baz" }, abstract: { baz: "bang" } }),
      abstract: (abstract, database, config) => ({ abstract: { ...abstract, newAddition: true }, jobs: [testJob] }),
      folder: (folder, database, config) => [testJob]
    },
    write: (destination, database, config) => {
      return {
        data: "yo there",
      }
    }
  }

  /** @type {VotivePlugin} */
  const testPlugin = {
    name: "test plugin",
    runners: {
      testRunner
    },
    router: (path) => path,
    processors: [testProcessor]
  }

  /** @type {Runner} */
  async function testRunner(data, database) {
    const waiting = await new Promise((resolve) => setTimeout(() => resolve(data), 1000))

    return waiting
  }

  /** @type {VotiveConfig} */
  const config = {
    sourceFolder: "./markdown",
    destinationFolder: temp.path,
    plugins: [testPlugin]
  }

  /** @type {FlatProcessors} */
  const processors = [
    {
      plugin: testPlugin,
      processor: testProcessor
    }
  ]

  try {
    const database = votive.createDatabase()

    const moresources = database.getAllSources()
    console.log({ moresources })

    const stop = stopwatch("Read sources")
    const { folders, sources } = await votive.readSources(config, database, processors)
    stop()

    const sourcesJobs = sources.flatMap(source => source.jobs)
    const { processedAbstracts, abstractsJobs } = votive.readAbstracts(sources, config, database, processors)

    const foldersJobs = readFolders(folders, config, database, processors)

    database.createOrUpdateDestination({ metadata: { a: 1, b: 2 }, path: "abc.txt", abstract: { c: 3 }, syntax: "txt" })
    const destination = database.getDestinationDependently("abc.txt", ["a"], "def")
    database.createOrUpdateDestination({ metadata: { a: 3, b: 4 }, path: "def.txt", abstract: { c: 5 }, syntax: "txt" })
    database.createOrUpdateDestination({ metadata: { a: 3, b: 9 }, path: "abc.txt", abstract: { c: 4 }, syntax: "txt" })
    database.createOrUpdateDestination({ metadata: { a: 3, b: 9 }, path: "abc/def.txt", abstract: { c: 4 }, syntax: "txt" })


    const setting = database.setSetting("abc", "theme", "blue")
    const newSetting = database.setSetting("def", "category", "Dog")
    const sameSetting = database.setSetting("def", "category", "Dog")
    const oldSetting = database.setSetting("abc", "theme", "green")

    const settings = database.getSettings("abc", "def")

    const jobs = [...sourcesJobs, ...abstractsJobs, ...foldersJobs]
    runJobs(jobs, config, database)

    const dbResults = database.getAllSources()

    const written = await votive.writeDestinations(config, database)

    // const everything = database.getEverything()
    // console.log(everything)

    const newsources = database.getAllSources()
    console.log({ newsources })

    assert(true, "Read test tk")
    temp.remove()
  } catch (error) {
    temp.remove()
    throw error
  }
})