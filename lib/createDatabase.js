import { DatabaseSync, backup } from "node:sqlite"
import { splitURL, checkFile } from "./utils/index.js"
import { statSync } from "node:fs"
import path from "node:path"

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

  const store = databaseSync.createTagStore()

  databaseSync.exec(sqlCreateTables)

  const database = {}

  database.saveDB = async () => {
    if (databaseSync.location()) return // Only save if running in memory
    await backup(databaseSync, dbPath)
  }

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
    createSource.get(source, destination, lastModified)
  }

  const updateSource = databaseSync.prepare(`UPDATE sources SET lastModified = ? WHERE path = ?`)

  /**
   * @param {string} source
   * @param {number} lastModified
   */
  database.updateSource = (source, lastModified) => {
    updateSource.get(lastModified, source)
  }

  const getSettingsBySource = databaseSync.prepare(`SELECT * FROM settings WHERE source = ?`)


  // These statements are cached, no need to refactor
  const createDest = databaseSync.prepare(`INSERT INTO destinations (path, dir, syntax, stale, abstract) VALUES (?, ?, ?, 1, ?)`)
  const updateDest = databaseSync.prepare(`UPDATE destinations SET abstract = ? WHERE path = ?`)
  const createMeta = databaseSync.prepare(`INSERT INTO metadata (destination, label, value, type) VALUES (?, ?, ?, ?)`)
  const updateMeta = databaseSync.prepare(`UPDATE metadata SET value = ? WHERE destination = ? AND label = ?`)
  const getDepends = databaseSync.prepare(`SELECT * FROM dependencies WHERE destination = ? AND property = ?`)
  const getDependenciesByDestination = databaseSync.prepare(`SELECT * FROM dependencies WHERE destination = ?`)
  const getAllDeps = databaseSync.prepare(`SELECT * FROM dependencies`)
  const staleDepen = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path = ?`)
  const freshDepen = databaseSync.prepare(`UPDATE destinations SET stale = 0 WHERE path = ? RETURNING *`)
  const staleDescendents = databaseSync.prepare(`UPDATE destinations SET stale = 1 WHERE path LIKE ? RETURNING *`)
  const getAllSettings = databaseSync.prepare(`SELECT * FROM settings`)

  database.getAllSettings = () => {
    return getAllSettings.all()
  }

  /** @param {string} path */
  database.freshenDependency = (path) => {
    freshDepen.get(path)
  }

  database.getDependencies = () => {
    return getAllDeps.all()
  }

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

    let changedMetadata = false


    // TODO: This is redundant with `getDestinationIndependently`
    const cachedMetadata = getMetadataByPath.all(dest.path)

    for (const key in metadata) {
      const index = cachedMetadata.findIndex(el => el.label === key)
      cachedMetadata.splice(index, 1)
      if (JSON.stringify(metadata[key]) !== JSON.stringify(extant.metadata[key])) {
        changedMetadata = true
        updateMeta.get(metadata[key], dest.path, key)
        const dependencies = getDepends.all(dest.path, key)
        dependencies.forEach(({ dependent }) => {
          staleDepen.get(dependent)
        })
      }
    }

    cachedMetadata.forEach(deletedDatum => {
      changedMetadata = true
      const dependencies = getDepends.all(dest.path, deletedDatum.label)
      dependencies.forEach(({ dependent }) => {
        staleDepen.get(dependent)
      })
      deleteMetadata.get(deletedDatum.destination, deletedDatum.label)
    })

    if (changedAbstract || changedMetadata) staleDepen.get(dest.path)

    if (changedAbstract) {
      updateDest.get(JSON.stringify(dest.abstract), dest.path)
      const dependencies = getDepends.all(dest.path, "abstract")
      dependencies.forEach(({ dependent }) => {
        staleDepen.get(dependent)
      })
    }
  }

  const getMetadataByPath = databaseSync.prepare(`
      SELECT * FROM metadata WHERE destination = ?
    `)

  /** @param {string} path */
  database.getAllMetadataByPath = (path) => {
    return getMetadataByPath.get(path)
  }

  /** @param {string[]} params */
  database.getMetadataIndependently = (params) => {
    return databaseSync.prepare(`
      SELECT * FROM destinations d
      LEFT JOIN metadata m ON d.path = m.destination AND m.label IN (${params.map(p => `'${p}'`).join(", ")})
      WHERE d.path = ?
    `)
  }

  database.getDestinationWithoutMetadata = () => {
    return databaseSync.prepare(`
        SELECT * FROM destinations
        WHERE path = ?
      `)
  }

  /**
   * @param {string} path
   * @param {string[]} [params]
   */
  database.getDestinationIndependently = (path, params) => {
    // TODO: Could potentially speed up the next two db queries by using the tag store

    const metadatas = (params && params.length)
      ? database.getMetadataIndependently(params).all(path)
      : [database.getDestinationWithoutMetadata().get(path)]

    if (!metadatas) return

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
        return [label, originalValue]
      })
    )


    const result = {
      path: first.path,
      dir: first.dir,
      syntax: first.syntax,
      metadata
    }

    const includeAbstract = params && params.includes("abstract")
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
    databaseSync.prepare(`INSERT INTO dependencies (destination, property, dependent) VALUES ${deps.join(", ")} RETURNING *`).all()
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

  const deleteSource = databaseSync.prepare(`DELETE FROM sources WHERE path = ? RETURNING *`)
  const deleteAllDependenciesByDestination = databaseSync.prepare(`DELETE FROM dependencies WHERE destination = ? RETURNING dependent`)
  const deleteAllMetadataByDestination = databaseSync.prepare(`DELETE FROM metadata WHERE destination = ?`)
  const deleteMetadata = databaseSync.prepare(`DELETE FROM metadata WHERE destination = ? AND label = ?`)
  const deleteDestination = databaseSync.prepare(`DELETE FROM destinations WHERE path = ?`)

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

  database.getAllDestinations = () => {
    return store.all`SELECT * FROM destinations`
  }

  database.getStaleDestinations = () => {
    const metadatas = store.all`
      SELECT * FROM destinations d
      LEFT JOIN metadata m on d.path = m.destination
      WHERE stale = 1`

    const grouped = metadatas.map((value, index, array) => {
      if (array.slice(0, index)
        .find(prior => prior.path === value.path)
      ) {
        return null
      } else {
        return {
          path: value.path,
          dir: value.dir,
          syntax: value.syntax,
          stale: value.stale,
          abstract: JSON.parse(value.abstract),
          metadata: Object.fromEntries(
            array.slice(index)
              .filter(following => following.path === value.path)
              .map(succeeding => {
                return reconstituteMetadata(succeeding)
              })
          )

        }
      }
    }).filter(a => a)

    function reconstituteMetadata({ label, value, type }) {
      const originalValue = type === "undefined"
        ? undefined
        : type === "string"
          ? String(value)
          : type === "boolean"
            ? Boolean(value)
            : typeof value !== "string"
              ? value
              : JSON.parse(value)
      return [label, originalValue]
    }
   
    return grouped
  }

  const createSetting = databaseSync.prepare(`INSERT INTO settings (destination, label, value, source) VALUES (?, ?, ?, ?) RETURNING *`)
  const selectSetting = databaseSync.prepare(`SELECT * FROM settings WHERE label = ? AND destination = ?`)
  const updateSetting = databaseSync.prepare(`UPDATE settings SET value = ? WHERE destination = ? AND label = ? RETURNING *`)
  const deleteSettings = databaseSync.prepare(`DELETE FROM settings WHERE source = ?`)

  // const updateDest = databaseSync.prepare(`UPDATE destinations SET abstract = ? WHERE path = ?`)

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
    const extant = selectSetting.get(key, destinationFolder)

    if (!extant) return createSetting.get(destinationFolder, key, value, source)
    if (extant.value === value) return
    updateSetting.get(value, destinationFolder, key)

    destinationFolder === ""
      ? staleDescendents.all("%")
      : staleDescendents.all(`${destinationFolder}/%`)
  }


  /**
   * @param {string} destinationFolder
   */
  database.getSettings = (destinationFolder) => {
    const segments = destinationFolder.split(path.sep)
      .map((_, index, array) => `'${array.slice(0, index + 1).join(path.sep)}'`)

    segments.unshift("''")
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
  value STRING
);

`

export default createDatabase