import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as votive from "votive/internals"
import { stopwatch } from "./../lib/utils/index.js"
import { readFolders, runJobs } from "../lib/index.js"
import { readdir, rm } from "node:fs/promises"
import { checkFile } from "./../lib/utils/index.js"

/** @import {VotiveConfig, VotivePlugin, FlatProcessors, VotiveProcessor, Runner, Job} from "./../lib/bundle.js" */
/** @import {ProcessorRead, ProcessorWrite, ReadAbstract, ReadText, ReadTextResult, ReadFolder} from "./../lib/bundle.js" */

process.chdir("./tests")

test("empty directory", async () => {
  const tempDest = fs.mkdtempDisposableSync("destination-")
  const tempSource = fs.mkdtempDisposableSync("source-")

  try {
    const stop = stopwatch("Bundle empty folder")
    await votive.bundle({
      sourceFolder: tempSource.path,
      destinationFolder: tempDest.path,
      plugins: []
    })

    stop()

    const dir = fs.readdirSync(tempDest.path)
    assert(dir.length === 0, "Destination directory is not empty.")
  } catch (error) {
    tempDest.remove()
    tempSource.remove()
    console.error(error)

  }

  tempDest.remove()
  tempSource.remove()
})

test("internals", async (t) => {
  const dbExists = checkFile(".votive.db")
  if (dbExists) await rm(".votive.db")

  const temp = fs.mkdtempDisposableSync("destination-")

  /** @returns {Job} */
  function createExampleJob() {
    return {
      data: Math.floor(Math.random() * 1000),
      runner: "exampleRunner"
    }
  }


  /** @type {ReadText} */
  function exampleTextReader(text, filePath, destinationPath, database, config) {
    const matches = text.match(/\b\w+\b/)
    const title = matches ? matches[0] : "Untitled"

    /** @type {ReadTextResult} */
    return {
      abstract: {
        content: text,
      },
      metadata: {
        title
      },
      jobs: [
        createExampleJob()
      ]
    }
  }

  /** @type {ReadAbstract} */
  function exampleAbstractReader(abstract, database, config) {
    abstract.exampleAppend = true
    return { abstract, jobs: [createExampleJob()] }
  }

  /** @type {ReadFolder} */
  function exampleFolderReader(folder, database, config) {
    return {
      jobs: [createExampleJob()],
      destinations: [
        {
          path: "index.html",
          abstract: { content: "" },
          metadata: {
            title: "home"
          },
          syntax: "md"
        }
      ]
    }
  }

  /** @type {VotiveProcessor} */
  const exampleProcessor = {
    syntax: "md",
    filter: {
      extensions: [".md"]
    },
    read: {
      text: exampleTextReader,
      abstract: exampleAbstractReader,
      folder: exampleFolderReader
    },
    write: (destination, database, config) => {
      return {
        data: "lorem ipsum",
      }
    }
  }

  /** @param {string} sourcePath */
  function router({ base, ...parsed }) {
    return { ...parsed, ext: ".html" }
  }

  /** @type {VotivePlugin} */
  const examplePlugin = {
    name: "example plugin",
    runners: {
      exampleRunner: exampleRunner
    },
    router,
    processors: [exampleProcessor]
  }

  /** @type {Runner} */
  async function exampleRunner(data, database) {
    return await new Promise((resolve) => setTimeout(() => resolve(data), 1))
  }

  /** @type {VotiveConfig} */
  const config = {
    sourceFolder: "./markdown",
    destinationFolder: temp.path,
    plugins: [examplePlugin]
  }

  /** @type {FlatProcessors} */
  const processors = [
    {
      plugin: examplePlugin,
      processor: exampleProcessor
    }
  ]

  try {
    fs.writeFileSync("markdown/prunee.md", "A little content")

    const database = votive.createDatabase()
    const sourcesOne = database.getAllSources()

    t.test("no sources on startup", () => {
      const isArray = Array.isArray(sourcesOne)
      const isEmpty = !sourcesOne.length
      assert(isArray && isEmpty)
    })



    const stop = stopwatch("Read sources")

    const { folders, sources } = await votive.readSources(config, database, processors)

    t.test('one folder exists', () => {
      assert(folders.length === 1)
    })

    t.test('three sources exist', () => {
      assert(sources.length === 4)
    })

    stop()

    const sourcesJobs = sources.flatMap(source => source.jobs)

    const { processedAbstracts, abstractsJobs } = votive.readAbstracts(sources, config, database, processors)

    t.test('transformation succeeded', () => {
      assert(processedAbstracts.find(abstract => abstract.exampleAppend))
    })

    t.test('abstract jobs exist', () => {
      assert(abstractsJobs.length > 0)
      assert(abstractsJobs.every(job => job.data && job.runner))
    })

    const foldersJobs = readFolders(folders, config, database, processors)

    t.test("folders jobs exist", () => {
      assert(foldersJobs.length > 0)
      assert(foldersJobs.every(job => job.data && job.runner))
    })

    database.createOrUpdateDestination({ metadata: { a: 1, b: 2 }, path: "abc.html", abstract: { c: 3 }, syntax: "md" })
    const firstDestination = database.getDestinationIndependently("abc.html", [])

    t.test('first destination created', () => {
      assert(firstDestination.path === 'abc.html')
    })

    database.createOrUpdateDestination({ metadata: { a: 3, b: 4 }, path: "abc/def.html", abstract: { c: 5 }, syntax: "md" })
    const destination = database.getDestinationDependently("abc.html", "abc/def.html")

    console.info(`'abc/def.html' requests the property 'a' from 'abc.html', creating a dependency: ${destination.metadata.a}`)

    const dependencies = database.getDependencies()

    t.test('dependency created', () => {
      assert(dependencies[0].dependent === 'abc/def.html')
    })


    const setting = database.setSetting("abc.html", "theme", "blue", "markdown/prunee.md")
    const newSetting = database.setSetting("abc", "category", "Dog", "markdown/prunee.md")
    const sameSetting = database.setSetting("abc", "category", "Dog", "markdown/prunee.md")
    const folderSetting = database.setSetting("abc", "theme", "red", "markdown/prunee.md")

    t.test('settings created', () => {
      assert(setting.value === 'blue')
      assert(newSetting.value === 'Dog')
      assert(!sameSetting)
    })

    const abcSettings = database.getSettings("abc.html")

    t.test('settings retrieved', () => {
      assert(abcSettings.theme[0] === "blue")
    })

    const descendentSetting = database.setSetting("abc/def.html", "theme", "green", "abc.md")
    const defSettings = database.getSettings("abc/def.html")

    t.test('settings retrieved', () => {
      assert(abcSettings.theme[0] === "blue")
      assert(defSettings.theme[1] === "green")
    })

    const staleDestinations = database.getStaleDestinations()

    t.test('all destinations are stale', () => {
      assert(staleDestinations.length === 7)
    })

    const written = await votive.writeDestinations(config, database)

    const staleDestinationsAfterWriting = database.getStaleDestinations()

    t.test('all destinations are fresh', () => {
      assert(staleDestinationsAfterWriting.length === 0)
    })

    const updated = database.createOrUpdateDestination({ metadata: { a: 1, b: 9 }, path: "abc.html", abstract: { c: 4 }, syntax: "md" })
    const staleAfterAbstractUpdate = database.getStaleDestinations()

    t.test('updated document with no side effects is stale', () => {
      assert(staleAfterAbstractUpdate.length === 1)
    })

    await votive.writeDestinations(config, database)
    const staleAfterSecondWrite = database.getStaleDestinations()

    t.test('everything fresh again', () => {
      assert(staleAfterSecondWrite.length === 0)
    })

    const updatedWithSideEffects = database.createOrUpdateDestination({ metadata: { a: 4, b: 9 }, path: "abc.html", abstract: { c: 4 }, syntax: "md" })
    const staleAfterSideEffects = database.getStaleDestinations()

    t.test('side effects work', () => {
      assert(staleAfterSideEffects.length === 2)
    })

    const freshDestinations = database.getAllDestinations()

    await votive.writeDestinations(config, database)

    const oldSetting = database.setSetting("abc", "theme", "green")

    const staleAfterSettingsChange = database.getStaleDestinations()

    t.test('setting affects descendents', () => {
      assert(staleAfterSettingsChange.length === 1)
    })

    // TODO: Write tests for jobs
    const jobs = [...sourcesJobs, ...abstractsJobs, ...foldersJobs]
    runJobs(jobs, config, database)

    const destinations = database.getAllDestinations()
    const prunee = database.getDestinationDependently("markdown/prunee.html", "abc/def.html")

    console.info(`'abc/def.html' requests the property 'title' from 'markdown/prunee.html', creating a dependency: ${prunee.metadata.title}`)
    const newDependencies = database.getDependencies()

    fs.rmSync("markdown/prunee.md")

    await votive.pruneSources(config, database)

    const result = database.getDestinationIndependently("markdown/prunee.html")
    const prunedDependencies = database.getDependencies()
    const prunedMetadata = database.getAllMetadataByPath("markdown/prunee.html")

    t.test('source pruned', () => {
      assert(!result)
      assert(newDependencies.length - prunedDependencies.length === 1)
      assert(!prunedMetadata)
    })

    const finalDestinations = database.getDestinations({
      filter: [
        {
          property: "a",
          operator: "gt",
          value: 3
        }
      ]
    }, "markdown/prunee.html")

    const finalDependencies = database.getDependencies()

    // TODO: Write a test for get destinations

    await database.saveDB()

    temp.remove()
  } catch (error) {
    temp.remove()
    throw error
  }
})