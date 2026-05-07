import { DatabaseSync, backup } from "node:sqlite"
import { splitURL, checkFile } from "./utils/index.js"
import { statSync } from "node:fs"
import path from "node:path"
import createStatement from "./sqlite.js"

/**
 * @typedef {ReturnType<createDatabase>} Database
 */


/** @param {string} dbPath */
function loadDB(dbPath) {
  if (checkFile(dbPath)) return new DatabaseSync(dbPath)
  return new DatabaseSync(":memory:")
}


/** @param {string} dbPath */
function createDatabase(dbPath = ".votive.db") {

  const databaseSync = loadDB(dbPath)
  databaseSync.exec(sqlCreateTables)
  const database = {}

  database.saveDB = async (sources) => {
    /*
      FIXME This seems to throw an error sometimes if the backup
      runs too quickly after writing, which maybe happens when
      Votive runs with no changes. To guard against this, I check
      to see if any sources have changed. With no source changes,
      the backup should theoretically be unnecessary.
    */
    if (databaseSync.location() || !sources.length) return // Only save if running in memory
    await backup(databaseSync, dbPath)
  }




  // These statements are cached, no need to refactor
  const updateSource = databaseSync.prepare(`UPDATE sources SET lastModified = ? WHERE path = ?`)
  const createSource = databaseSync.prepare(`INSERT INTO sources (path, destination, lastModified) VALUES (?, ?, ?)`)
  const createDest = databaseSync.prepare(`INSERT OR IGNORE INTO destinations (path, dir, syntax, stale, abstract) VALUES (?, ?, ?, 1, ?)`)
  const getDependenciesByDestination = databaseSync.prepare(`SELECT * FROM dependencies WHERE destination = ?`)
  const staleDepen = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path = ? RETURNING *`)
  const freshDepen = databaseSync.prepare(`UPDATE destinations SET stale = 0 WHERE path = ? RETURNING *`)
  const selectSource = databaseSync.prepare(`SELECT * FROM sources WHERE path = ?`)
  const getAllSources = databaseSync.prepare(`SELECT * FROM sources`)
  const staleDescendents = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path LIKE ? RETURNING *`)
  const getAllSettings = databaseSync.prepare(`SELECT * FROM settings`)
  const deleteSource = databaseSync.prepare(`DELETE FROM sources WHERE path = ? RETURNING *`)
  const deleteAllDependenciesByDestination = databaseSync.prepare(`DELETE FROM dependencies WHERE destination = ? RETURNING dependent`)
  const deleteAllMetadataByDestination = databaseSync.prepare(`DELETE FROM metadata WHERE destination = ?`)
  const deleteMetadata = databaseSync.prepare(`DELETE FROM metadata WHERE destination = ? AND label = ?`)
  const deleteDestination = databaseSync.prepare(`DELETE FROM destinations WHERE path = ?`)
  const createSetting = databaseSync.prepare(`INSERT OR IGNORE INTO settings (destination, label, value, source) VALUES (?, ?, ?, ?) RETURNING *`)
  const selectSetting = databaseSync.prepare(`SELECT * FROM settings WHERE label = ? AND destination = ?`)
  const updateSetting = databaseSync.prepare(`UPDATE settings SET value = ? WHERE destination = ? AND label = ? RETURNING *`)
  const deleteSettings = databaseSync.prepare(`DELETE FROM settings WHERE source = ?`)
  const createURL = databaseSync.prepare(`INSERT OR IGNORE INTO urls (url, data) VALUES (?, ?) RETURNING *`)
  const getURL = databaseSync.prepare(`SELECT data FROM urls WHERE url = ?`)
  const getDestinationWithMetadata = databaseSync.prepare(`
    WITH destination AS (
      SELECT * FROM destinations
      INNER JOIN metadata ON destinations.path = metadata.destination
      WHERE path = ?
    )
    SELECT destination.path, destination.dir, destination.syntax, destination.abstract, json_group_object(destination.label, destination.value) AS metadata
    FROM destination
    GROUP BY destination.path
  `)

  const getStaleDestinationsWithMetadata = databaseSync.prepare(`
    WITH destination AS (
      SELECT * FROM destinations
      INNER JOIN metadata ON destinations.path = metadata.destination
    ) 
    SELECT destination.path, destination.dir, destination.syntax, destination.abstract, json_group_object(destination.label, destination.value) AS metadata
    FROM destination
    WHERE stale = 1
    GROUP BY destination.path
  `)

  const upsertMetadata = databaseSync.prepare(`
    INSERT OR REPLACE INTO metadata (label, value, type, destination)
    SELECT
      json_each.key,
      json_each.value,
      json_each.type,
      ?
    FROM json_each(?);
  `)

  const staleDependencies = databaseSync.prepare(`
    UPDATE destinations
    SET stale = 1
    WHERE path IN (
      SELECT dependent FROM dependencies
      WHERE destination = ? AND property = ?
    )
    RETURNING *
  `)

  const pruneMetadata = databaseSync.prepare(`
      DELETE FROM metadata
      WHERE label NOT IN (
        SELECT
          json_each.key
        FROM json_each(?)
      ) AND destination = ?
    `)

  database.getAllSettings = () => {
    return getAllSettings.all()
  }

  /**
   * @param {string} source - Source file path.
   * @param {string} destination - Destination file path.
   * @param {number} lastModified - Source file date last modified.
   */
  database.createSource = (source, destination, lastModified) => {
    databaseSync.prepare(``) // SQLite bug. Query fails without this.
    createSource.get(source, destination, lastModified)
    const { dir } = path.parse(path.normalize(destination))

    staleDescendents.get("%")
  }


  /**
   * @param {string} source
   * @param {number} lastModified
   */
  database.updateSource = (source, lastModified) => {
    updateSource.get(lastModified, source)
  }

  /** @param {string} path */
  database.freshenDependency = (path) => {
    freshDepen.get(path)
  }

  /**
   * @param {object} params
   * @param {string} params.path - Destination file path
   * @param {object} params.abstract
   * @param {object} params.metadata
   * @param {string} params.syntax - Destination abstract syntax
   */
  database.createOrUpdateDestination = ({ metadata, ...dest }) => {
    const dir = dest.path && splitURL(dest.path)
    const relativePath = path.relative("", dest.path).toLowerCase()

    const extant = getDestinationWithMetadata.get(dest.path)
    if (extant && extant.abstract) extant.abstract = JSON.parse(extant.abstract)
    if (extant && extant.metadata) extant.metadata = JSON.parse(extant.metadata)


    if (!extant) {
      createDest.get(relativePath, dir, dest.syntax, JSON.stringify(dest.abstract))
      upsertMetadata.run(relativePath, JSON.stringify(metadata))
      return
    }

    databaseSync.exec("BEGIN")
    try {
      upsertMetadata.run(relativePath, JSON.stringify(metadata))
      pruneMetadata.run(JSON.stringify(metadata), relativePath)
      databaseSync.exec("COMMIT")
    } catch(e) {
      databaseSync.exec("ROLLBACK")
      console.error(`Error upserting metadata: ${e}`)
    }

    /* TODO: Prune metadata */
    /** TODO: Compare metadata and stale deps */
    const changedAbstract = JSON.stringify(dest.abstract) !== JSON.stringify(extant.abstract)

    const keys = new Set(Object.keys(metadata))
    Object.keys(extant.metadata).forEach(key => keys.add(key))

    /* TODO: Test if this is working */
    keys.forEach(key => {
      if (metadata[key] !== extant.metadata[key]) {
        const depens = staleDependencies.all(dest.path, key)
      }
    })
  }

  /* TODO: Check if this still runs even if no metadata exists */
  /**
   * @param {string} path
   */
  database.getDestinationIndependently = (path) => {

    const destination = getDestinationWithMetadata.get(path)

    if (!destination) return

    if (destination?.abstract) destination.abstract = JSON.parse(destination.abstract)
    if (destination?.metadata) destination.metadata = JSON.parse(destination.metadata)

    return destination
  }

  const createDependency = databaseSync.prepare(`INSERT OR IGNORE INTO dependencies (destination, property, dependent) VALUES (?, ?, ?) `)


  /* TODO: Rewrite with query logic */

  /** @param {import("./sqlite.js").Query} query */
  database.getDestinations = (query = {}, dependent) => {
    const statement = createStatement(query)
    const results = databaseSync.prepare(statement).all()
    const destinations = Object.values(results.reduce((pv, cv) => {
      if (!pv || !pv[cv.path]) {
        pv[cv.path] = {
          dir: cv.dir,
          path: cv.path,
          syntax: cv.syntax,
          metadata: {}
        }

        Object.defineProperty(pv[cv.path], "abstract",
          {
            enumerable: true,
            get() {
              createDependency.get(cv.path, "abstract", dependent)
              return cv.abstract
            }
          }
        )
      }

      Object.defineProperty(pv[cv.path].metadata, cv.label,
        {
          enumerable: true,
          get() {
            createDependency.get(cv.path, cv.label, dependent)
            return [cv.label,
            cv.type === "undefined"
              ? undefined
              : cv.type === "boolean"
                ? Boolean(cv.value)
                : cv.value
            ]
          }
        }
      )

      return pv
    }, {}))

    return destinations
  }

  /**
   * @param {string} path
   */
  database.getSource = (path) => {
    const source = selectSource.get(path)
    return source
  }

  database.getAllSources = () => {
    const sources = getAllSources.all()
    return sources
  }
  /** @param {string} path */
  database.deleteSource = (path) => {
    const deleted = deleteSource.all(path)
    deleted.forEach(source => {
      database.deleteSettings(String(source.path))
      getDependenciesByDestination.all(source.destination)
      deleteAllDependenciesByDestination.all(source.destination)
        .forEach(({ dependent }) => staleDepen.get(dependent))
      deleteAllMetadataByDestination.all(source.destination)
      deleteDestination.get(source.destination)
    })
  }

  // TODO: DELETE SETTING

  database.getStaleDestinations = () => {
    const destinations = getStaleDestinationsWithMetadata.all()

    destinations.forEach(item => {
      if (item && item.abstract) item.abstract = JSON.parse(item.abstract)
      if (item && item.metadata) item.metadata = JSON.parse(item.metadata)
    })

    return destinations
  }

  // WRITE AN UPDATE SETTINGS FUNCTION FOR WHEN A SOURCE CHANGES

  /** @param {string} source */
  database.deleteSettings = (source) => {
    const deleted = deleteSettings.all(source)
    deleted.forEach(setting => {
      staleDepen.get(setting.destination)
      staleDescendents.all(`${setting.destination}/%`)
    })
  }

  /**
   * @param {string} destinationFolder
   * @param {string} key
   * @param {string} value
   * @param {string} [source]
   * @example
   * setSetting("", "theme", "summer", "settings.md")
   * setSetting("data", "format", "csv", "/config.yaml")
   */
  database.setSetting = (destinationFolder, key, value, source = "") => {
    // const extant = selectSetting.get(key, destinationFolder)

    const type = typeof value
    const safeValue = type === "object"
      ? JSON.stringify(value)
      : value

    const descendents = destinationFolder === ""
      ? "%"
      : `${destinationFolder}/%`


    const staled = staleDescendents.all(descendents)

    return createSetting.get(destinationFolder, key, safeValue, source)
    // if (!extant) return createSetting.get(destinationFolder, key, safeValue, source)
    // if (extant.value === safeValue) return
    // updateSetting.get(safeValue, destinationFolder, key)

  }


  /**
   * @param {string} destinationFolder
   */
  database.getSettings = (destinationFolder) => {
    const segments = ["''", ...(destinationFolder).split(path.sep)
      .map((_, index, array) => `'${array.slice(0, index + 1).join(path.sep)}'`)
      .filter(a => a)]

    // if(segments.length === 1 && segments[0].length > 2) {
    // segments.unshift("''")
    // }

    const statement = segments.join(", ")

    const records = databaseSync.prepare(`SELECT * FROM settings WHERE destination IN (${statement})`).all()

    const grouped = {}
    records.sort((a, b) => a.length - b.length)
      .forEach(record => {
        if (!grouped[record.label]) grouped[record.label] = [record.value]
        else grouped[record.label].push(record.value)
      })

    return grouped
  }

  /**
   * @param {string} url
   * @param {string} data
   * @param {string} destination
   */
  database.createURL = (url, data, destination) => {
    const created = createURL.get(url, JSON.stringify(data))
    const staled = staleDepen.get(destination)
    // TODO: Better signal propagation here?
  }

  /**
   * @param {string} url
   */
  database.getURL = (url) => {
    const { data } = getURL.get(url) || {}
    if (!data) return
    return JSON.parse(data)
  }

  return database
}

const sqlCreateTables = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  destination STRING,
  path STRING,
  lastModified INTEGER
);

CREATE TABLE IF NOT EXISTS dependencies (
  key INTEGER PRIMARY KEY,
  destination STRING NOT NULL,
  property STRING NOT NULL,
  dependent STRING NOT NULL,
  UNIQUE(destination, property, dependent)
);

CREATE TABLE IF NOT EXISTS destinations (
  key INTEGER PRIMARY KEY,
  path STRING UNIQUE,
  dir TEXT,
  syntax TEXT,
  stale INTEGER,
  abstract
);

CREATE TABLE IF NOT EXISTS metadata (
  id INTEGER PRIMARY KEY,
  destination STRING,
  label STRING,
  value STRING,
  type STRING,
  UNIQUE(destination, label)
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  destination STRING,
  source STRING,
  label STRING,
  value STRING,
  UNIQUE(destination, label, value, source)
);

CREATE TABLE IF NOT EXISTS urls (
  url STRING PRIMARY KEY,
  data STRING
);

`

export default createDatabase