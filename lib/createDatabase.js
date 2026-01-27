import { DatabaseSync, backup } from "node:sqlite"
import { splitURL } from "./utils/index.js"
import { statSync } from "node:fs"

/**
 * @typedef {ReturnType<createDatabase>} Database
 */


function checkFile(path) {
  try {
    return statSync(path)
  } catch(e) {
    return null
  }
}


function createDatabase() {
  const databaseSync = new DatabaseSync(".votive.db")

  const store = databaseSync.createTagStore()

  databaseSync.exec(sqlCreateTables)

  const database = {}

  /**
   * @param {string} folderPath 
   * @param {string} urlPath
   */
  database.createFolder = (folderPath, urlPath) => {
    return store.get`INSERT INTO folders (folderPath, urlPath) VALUES :${folderPath} :${urlPath} RETURNING *`
  }

  const createSource = databaseSync.prepare(`INSERT INTO sources (path, destination, lastModified) VALUES (?, ?, ?)`)

  /**
   * @param {string} source - Source file path.
   * @param {string} destination - Destination file path.
   * @param {number} lastModified - Source file date last modified.
   */
  database.createSource = (source, destination, lastModified) => {
    databaseSync.prepare(``) // SQLite bug. Query fails without this.
    const inserted = createSource.get(source, destination, lastModified)
  }


  // These statements are cached, no need to refactor
  const createDest = databaseSync.prepare(`INSERT INTO destinations (path, dir, syntax, stale, abstract) VALUES (?, ?, ?, 1, ?)`)
  const updateDest = databaseSync.prepare(`UPDATE destinations SET abstract = ? WHERE path = ?`)
  const createMeta = databaseSync.prepare(`INSERT INTO metadata (destination, label, value, type) VALUES (?, ?, ?, ?)`)
  const updateMeta = databaseSync.prepare(`UPDATE metadata SET value = ? WHERE destination = ? AND label = ?`)
  const getDepends = databaseSync.prepare(`SELECT * FROM dependencies WHERE destination = ? AND property = ?`)
  const staleDepen = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path = ?`)
  const staleDescendents = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path LIKE ? RETURNING *`)

  /**
   * @param {object} params
   * @param {string} params.path - Destination file path
   * @param {object} params.abstract
   * @param {object} params.metadata
   * @param {string} params.syntax - Destination abstract syntax
   */
  database.createOrUpdateDestination = ({ metadata, ...dest }) => {
    const [dir] = dest.path ? splitURL(dest.path) : []
    const params = Object.keys(metadata)
    if (dest.abstract) params.push("abstract")
    const extant = database.getDestinationIndependently(dest.path, params)

    if (!extant) {
      createDest.get(dest.path, dir, dest.syntax, JSON.stringify(dest.abstract))
      Object.entries(metadata).map(([k, v]) => createMeta.get(dest.path, k, v, typeof v))
      return
    }

    const changedAbstract = JSON.stringify(dest.abstract) !== JSON.stringify(extant.abstract)
    const changedMetadata = []

    for (const key in metadata) {
      if (JSON.stringify(metadata[key]) !== JSON.stringify(extant.metadata[key])) {
        updateMeta.get(metadata[key], dest.path, key)
        const dependencies = getDepends.all(dest.path, key)
        dependencies.forEach(({ dependent }) => {
          staleDepen.get(dependent)
        })
      }
    }

    if (changedAbstract) {
      const updated = updateDest.get(JSON.stringify(dest.abstract), dest.path)
      const dependencies = getDepends.all(dest.path, "abstract")
      dependencies.forEach(({ dependent }) => {
        staleDepen.get(dependent)
      })
    }
  }

  /**
   * @param {string} path
   * @param {string[]} params
   */
  database.getDestinationIndependently = (path, params) => {
    // TODO: Could potentially speed up the next two db queries by using the tag store
    const metadatas = databaseSync.prepare(`
      SELECT * FROM destinations d
      LEFT JOIN metadata m ON d.path = m.destination AND m.label IN (${params.map(p => `'${p}'`).join(", ")})
      WHERE d.path = ?
    `).all(path)

    const [first] = metadatas

    if (!first) return

    const metadata = Object.fromEntries(
      metadatas.map(({ label, value, type }) => {
        const originalValue = type === "undefined"
          ? undefined
          : type === "string"
            ? String(value)
            : type === "boolean"
              ? Boolean(value)
              : typeof value !== "string"
                ? value
                : JSON.parse(value)
        return [label, value]
      })
    )


    const result = {
      path: first.path,
      dir: first.dir,
      syntax: first.syntax,
      metadata
    }

    const includeAbstract = params.includes("abstract")
    if (includeAbstract) result.abstract = JSON.parse(first.abstract)

    return result
  }

  /**
   * @param {string} path
   * @param {string[]} properties
   * @param {string} dependent
   */
  database.getDestinationDependently = (path, properties, dependent) => {
    const params = []
    const deps = []

    properties.forEach(p => {
      params.push(p)
      deps.push(`('${path}', '${p}', '${dependent}')`)
    })

    const result = database.getDestinationIndependently(path, params)
    if (result.abstract) deps.push(`('${path}, 'abstract', '${dependent}')`)
    const createDepp = databaseSync.prepare(`INSERT INTO dependencies (destination, property, dependent) VALUES ${deps.join(", ")}`).all()
  }

  const selectSource = databaseSync.prepare(`SELECT * FROM sources WHERE path = ?`)

  /**
   * @param {string} path
   */
  database.getSource = (path) => {
    const source = selectSource.get(path)
    return source
  }

  database.getAllSources = () => {
    const sources = store.all`SELECT * FROM sources`
    return sources
  }

  database.getAllDestinations = () => {
    return store.all`SELECT * FROM destinations`
  }

  database.getStaleDestinations = () => {
    return store.all`SELECT * FROM destinations WHERE stale = 1`
  }

  const createSetting = databaseSync.prepare(`INSERT INTO settings (destination, label, value) VALUES (?, ?, ?) RETURNING *`)
  const selectSetting = databaseSync.prepare(`SELECT * FROM settings WHERE label = ? AND destination = ?`)
  const updateSetting = databaseSync.prepare(`UPDATE settings SET value = ? WHERE destination = ? AND label = ?`)

  // const updateDest = databaseSync.prepare(`UPDATE destinations SET abstract = ? WHERE path = ?`)

  /**
   * @param {string} destination
   * @param {string} key
   * @param {string} value
   */
  database.setSetting = (destination, key, value) => {
    // TODO: Check if already exists
    const extant = selectSetting.get(key, destination)

    if (!extant) return createSetting.get(destination, key, value)
    if (extant.value === value) return

    updateSetting.get(value, destination, key)
    const stale = staleDescendents.all(`${destination}/%`)
  }


  /**
   * @param {string} destination
   * @param {string} dependent
   */
  database.getSettings = (destination, dependent) => {
    return Object.fromEntries(databaseSync.prepare(`SELECT * FROM settings WHERE destination = '${destination}' OR destination LIKE '${destination}/%';`)
      .all()
      .map(({ label, value }) => [label, value]))
  }

  database.getEverything = () => {
    return Object.fromEntries(
      databaseSync.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map(table => [
          table.name,
          databaseSync.prepare(`SELECT * FROM ${table.name}`).all()
        ])
    )
  }

  return database
}

/**
 * @param {object} data
 * @param {string} table
 * @param {DatabaseSync} databaseSync
 */
function updateColumns(data, table, databaseSync) {
  const keys = new Set(Object.keys(data))
  const columns = listColumns(table, databaseSync)
  const newColumns = keys.difference(columns)
  for (const column of newColumns) addColumn(column, table, databaseSync)
}

/**
 * @param {string} table
 * @param {DatabaseSync} databaseSync
 * @description list the columns on a table.
 */
function listColumns(table, databaseSync) {
  const columns = new Set()
  const tableInfo = databaseSync.prepare(`PRAGMA table_info(${table})`).all()
  for (const column of tableInfo) columns.add(column.name)
  return columns
}

/**
 * @param {string} column
 * @param {string} table
 * @param {DatabaseSync} databaseSync
 * @description Add a column to a table and update binary.
 */
function addColumn(column, table, databaseSync) {
  databaseSync.exec(`ALTER TABLE ${table} ADD COLUMN ${column} STRING;`)
}

const sqlCreateTables = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  pluginName TEXT NOT NULL,
  data STRING NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  runner STRING NOT NULL
);

-- Source/destination relationships
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
  dependent STRING NOT NULL
);

CREATE TABLE IF NOT EXISTS destinations (
  key INTEGER PRIMARY KEY,
  path STRING UNIQUE,
  dir TEXT,
  syntax TEXT,
  stale INTEGER,
  abstract
);

CREATE TABLE IF NOT EXISTS folders (
  path STRING PRIMARY KEY,
  urlPath STRING
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
  label STRING,
  value STRING
);

`

export default createDatabase