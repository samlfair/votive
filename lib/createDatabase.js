import { DatabaseSync, backup } from "node:sqlite"
import { splitURL, checkFile } from "./utils/index.js"
import path from "node:path"

/** @typedef {ReturnType<createDatabase>} Database */

/**
 * @typedef {object | array} Abstract
 */

/**
 * @typedef {any} MetadataProperty
 */

/**
 * @typedef {Record<string, MetadataProperty>} Metadata 
 */

/**
 * @typedef {object} TargetOutput
 * @property {number} key
 * @property {string} path
 * @property {string} dir
 * @property {string} syntax
 * @property {number} stale
 * @property {Abstract} abstract
 * @property {Metadata} metadata
 */

/**
 * @typedef {object} TargetInput
 * @property {string} path
 * @property {Abstract} abstract
 * @property {Metadata} metadata
 */


/**
 * @param {string} json
 * @returns {object | array}
 */
function coerceJSON(json) {
  const parsed = JSON.parse(json)
  if (!json) return {}
  if (Array.isArray(json)) return parsed
  if (typeof parsed === "object") return parsed
  else return {}
}

/** @param {string} dbPath */
function loadDB(dbPath) {
  if (checkFile(dbPath)) return new DatabaseSync(dbPath)
  return new DatabaseSync(":memory:")
}


/** @param {DatabaseSync} database */
function prepareStatements(database) {

  const { prepare } = database

  /**
   * @typedef {string} JSONString - A string that is actually JSON.
   */

  /**
   * @typedef {object} SQLiteSource
   * @property {number} id
   * @property {string} destination
   * @property {string} filePath
   * @property {number} lastModified
   */

  /**
   * @typedef {object} SQLiteTarget
   * @property {number} key
   * @property {string} path
   * @property {string} dir
   * @property {string} syntax
   * @property {number} stale
   * @property {JSONString} abstract
   * @property {JSONString} metadata
   */

  /**
   * @typedef {object} SQLiteDependency
   * @property {number} key
   * @property {string} destination
   * @property {string} property
   * @property {string} dependent
   */

  /**
   * @typedef {object} SQLiteMetadata
   * @property {number} id
   * @property {string} destination
   * @property {string} label
   * @property {string} value
   * @property {string} type
   */

  /**
   * @typedef {object} SQLiteSetting
   * @typedef {number} id
   * @typedef {string} destination
   * @typedef {string} source
   * @typedef {string} label
   * @typedef {string} value
   */

  /**
   * @typedef {object} SQLiteURL
   * @typedef {string} url
   * @typedef {string} data
   */

  return {

    /* SOURCES */
    source: {

      /**
       * @callback SQLiteSourcesCreate
       * @param {string} path
       * @param {string} destination
       * @param {number} timestamp
       * @returns {SQLiteSource}
       */

      create: /** @type {{get: SQLiteSourcesCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT INTO sources (path, destination, lastModified) VALUES (?, ?, ?)
        RETURNING *
      `))),

      /**
       * @callback SQLiteSourcesDelete
       * @param {string} filePath
       * @returns {SQLiteSource}
       */

      delete: /** @type {{get: SQLiteSourcesDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM sources WHERE path = ? RETURNING *
      `))),

      /**
       * @callback SQLiteSourcesGet
       * @param {string} path
       * @returns {SQLiteSource}
       */

      get: /** @type {{get: SQLiteSourcesGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM sources WHERE path = ?
      `))),

      /**
       * @callback SQLiteSourcesGetAll
       * @returns {SQLiteSource[]}
       */

      getAll: /** @type {{all: SQLiteSourcesGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM sources
      `))),


      /**
       * @callback SQLiteSourcesUpdate
       * @param {number} timestamp
       * @param {string} filePath
       * @returns {void}
       */

      update: /** @type {{get: SQLiteSourcesUpdate}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE sources SET lastModified = ? WHERE path = ?
      `))),
    },

    /* TARGETS */
    target: {

      /**
       * @callback SQLiteTargetCreate
       * @param {string} path
       * @param {string} dir
       * @param {string} syntax
       * @param {string} abstract
       * @returns {SQLiteTarget}
       */

      create: /** @type {{get: SQLiteTargetCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR IGNORE INTO destinations (path, dir, syntax, stale, abstract)
        VALUES (?, ?, ?, 1, ?)
        Returning *
      `))),


      /**
       * @callback SQLiteTargetDelete
       * @param {string} targetFilePath
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteTargetDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM destinations WHERE path = ?
      `))),

      /**
       * @callback SQLiteTargetGet
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      get: /** @type {{get: SQLiteTargetGet}} */ (/** @type {unknown} */ (database.prepare(`
        WITH destination AS (
          SELECT * FROM destinations
          INNER JOIN metadata ON destinations.path = metadata.destination
          WHERE path = ?
        )
        SELECT destination.path, destination.dir, destination.syntax, destination.abstract, json_group_object(destination.label, destination.value) AS metadata
        FROM destination
        GROUP BY destination.path
      `))),

      // TODO Add a limit

      /**
       * @callback SQLiteTargetGetMany
       * @param {{ filter: JSONString, folder: string, recursivePath: string }} params
       * @returns {SQLiteTarget[]}
       */

      getMany: /** @type {{all: SQLiteTargetGetMany}} */ (/** @type {unknown} */ (database.prepare(`
        WITH matches AS (
          SELECT m.destination, COUNT(*) AS match_count
          FROM metadata m
          INNER JOIN json_each(:filter) j ON j.key = m.label AND j.value = m.value
          GROUP BY m.destination
        ),
        filter_count AS (
          SELECT COUNT(*) AS total FROM json_each(:filter)
        )
        SELECT d.*, json_group_object(i.label, i.value) AS metadata
        FROM destinations d
        INNER JOIN metadata i ON d.path = i.destination
        LEFT JOIN matches ON matches.destination = d.path
        CROSS JOIN filter_count f
        WHERE (
          f.total = 0
          OR matches.match_count = f.total
        )
        AND (
          d.dir = :folder
          OR d.dir LIKE :recursivePath
        )
        GROUP BY d.path
      `))),


      /**
       * @callback SQLiteTargetGetAll
       * @returns {SQLiteTarget[]}
       */

      getAll: /** @type {{all: SQLiteTargetGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT destinations.*, json_group_object(i.label, i.value) AS metadata
        FROM destinations
        LEFT JOIN metadata i ON destinations.path = i.destination
        GROUP BY destinations.path
      `))),

      // TODO: Differentiate targets with/without metadata

      /**
       * @callback SQLiteTargetGetAllStale
       * @returns {SQLiteTarget[]}
       */

      getAllStale: /** @type {{all: SQLiteTargetGetAllStale}} */ (/** @type {unknown} */ (database.prepare(`
        WITH destination AS (
          SELECT * FROM destinations
          LEFT JOIN metadata ON destinations.path = metadata.destination
        ) 
        SELECT destination.path, destination.dir, destination.syntax, destination.abstract, json_group_object(destination.label, destination.value) AS metadata
        FROM destination
        WHERE stale = 1
        GROUP BY destination.path
      `))),

      /**
       * @callback SQLiteTargetMarkDescendentsStale
       * @param {string} targetFilePathPattern
       * @returns {SQLiteTarget[]}
       */

      markDescendentsStale: /** @type {{all: SQLiteTargetMarkDescendentsStale}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 1 WHERE path LIKE ? RETURNING *
      `))),

      /**
       * @callback SQLiteTargetMarkFresh
       * @param {string} targetFilePath
       * @returns {SQLiteTarget[]}
       */

      markFresh: /** @type {{get: SQLiteTargetMarkFresh}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 0 WHERE path = ? RETURNING *
      `))),

      /**
       * @callback SQLiteTargetMarkStale
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      markStale: /** @type {{get: SQLiteTargetMarkStale}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 1 WHERE path = ? RETURNING *
      `))),
    },

    /* DEPENDENCIES */
    dependency: {

      /**
       * @callback SQLiteDependencyCreate
       * @param {string} destination
       * @param {string} property
       * @param {string} dependent
       * @returns {void}
       */

      create: /** @type {{get: SQLiteDependencyCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR IGNORE INTO dependencies (destination, property, dependent)
        VALUES (?, ?, ?)
      `))),

      /**
       * @callback SQLiteDependencyDeleteByTarget
       * @param {string} targetFilePath
       * @returns {SQLiteDependency[]}
       */

      deleteByTarget: /** @type {{all: SQLiteDependencyDeleteByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM dependencies WHERE destination = ? RETURNING dependent
      `))),

      /**
       * @callback SQLiteDependencyGetAll
       * @returns {SQLiteDependency[]}
       */

      getAll: /** @type {{all: SQLiteDependencyGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM dependencies
      `))),

      /**
       * @callback SQLiteDependencyGetByTarget
       * @param {string} targetFilePath
       * @returns {SQLiteDependency[]}
       */

      getByTarget: /** @type {{all: SQLiteDependencyGetByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM dependencies WHERE destination = ?
      `))),

      /**
       * @callback SQLiteDependencyGetByTargetAndProperty
       * @param {string} targetFilePath
       * @param {string} property
       * @returns {SQLiteDependency[]}
       */

      getByTargetAndProperty: /** @type {{all: SQLiteDependencyGetByTargetAndProperty}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM dependencies WHERE destination = ? AND property = ?
      `))),

    },

    /* METADATA */
    metadata: {

      /**
       * @callback SQLiteMetadataCreate
       * @param {JSONString} metadataJSON
       * @param {string} targetPath
       * @returns {void}
       */

      create: /** @type {{get: SQLiteMetadataCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR REPLACE INTO metadata (label, value, type, destination)
        SELECT
          json_each.key,
          json_each.value,
          json_each.type,
          ?
        FROM json_each(?);
      `))),

      /**
       * @callback SQLiteMetadataDelete
       * @param {string} targetFilePath
       * @param {string} label
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteMetadataDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE destination = ? AND label = ?
      `))),

      /**
       * @callback SQLiteMetadataDeleteByTarget
       * @param {string} targetFilePath
       * @returns {void}
       */

      deleteByTarget: /** @type {{all: SQLiteMetadataDeleteByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE destination = ?
      `)))
    },

    /* SETTINGS */
    settings: {

      /**
       * @callback SQLiteSettingsCreate
       * @param {string} targetFilePath
       * @param {string} label
       * @param {string} value
       * @param {string} sourceFilePath
       * @returns {SQLiteSetting[]}
       */

      create: /** @type {{get: SQLiteSettingsCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR IGNORE INTO settings (destination, label, value, source) VALUES (?, ?, ?, ?) RETURNING *
      `))),

      /**
       * @callback SQLiteSettingsDelete
       * @param {string} sourceFilePath
       * @returns {SQLiteSetting[]}
       */

      delete: /** @type {{all: SQLiteSettingsDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM settings WHERE source = ?
        RETURNING *
      `))),

      /**
       * @callback SQLiteSettingsGet
       * @param {string} label
       * @param {string} targetFilePath
       * @returns {SQLiteSettings[]}
       */

      get: /** @type {{all: SQLiteSettingsGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM settings WHERE label = ? AND destination = ?
      `))),

      /**
       * @callback SQLiteSettingsGetAll
       * @returns {SQLiteSetting[]}
       */

      getAll: /** @type {{all: SQLiteSettingsGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM settings
      `))),

      /**
       * @callback SQLiteSettingsGetByFolder
       * @param {JSONString} JSONarray - JSON string of an array of target file paths
       * @returns {SQLiteSetting[]}
       */

      getByFolder: /** @type {{all: SQLiteSettingsGetByFolder}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT label, json_group_array(json_object('destination', destination, 'value', value)) AS settings
        FROM settings
        WHERE destination IN (SELECT value FROM json_each(?))
        GROUP BY label
      `))),

      /**
       * @callback SQLiteSettingsUpdate
       * @param {string} value
       * @param {string} targetFilePath
       * @param {string} label
       * @returns {SQLiteSettings}
       */

      update: /** @type {{get: SQLiteSettingsUpdate}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE settings SET value = ? WHERE destination = ? AND label = ? RETURNING *
      `)))
    },

    /* URLS */
    url: {

      /**
       * @callback SQLiteURLCreate
       * @param {string} url
       * @param {string} data
       * @returns {SQLiteURL}
       */

      create: /** @type {{get: SQLiteURLCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR IGNORE INTO urls (url, data) VALUES (?, ?) RETURNING *
      `))),

      /**
       * @callback SQLiteURLGet
       * @param {string} url
       * @returns {SQLiteURL}
       */

      get: /** @type {{get: SQLiteURLGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT data FROM urls WHERE url = ?
      `)))
    }
  }
}

// TODO Better type for sources

/**
 * @param {string} databasePath
 */
function createDatabase(databasePath = ".votive.db") {

  const database = loadDB(databasePath)
  createTables(database)
  const prepared = prepareStatements(database)

  const queries = {
    raw: database,

    /** @param {object[]} sources */
    async saveDB(sources) {
      /*
        FIXME This seems to throw an error sometimes if the backup
        runs too quickly after writing, which maybe happens when
        Votive runs with no changes. To guard against this, I check
        to see if any sources have changed. With no source changes,
        the backup should theoretically be unnecessary.
      */
      if (database.location() || !sources.length) return // Only save if running in memory
      await backup(database, databasePath)
    },

    source: {

      /**
       * @param {string} source - Source file path.
       * @param {string} target - Destination file path.
       * @param {number} lastModified - Source file date last modified.
       */
      create(source, target, lastModified) {
        // TODO: Begin
        const created = prepared.source.create.get(source, target, lastModified)
        // TODO: mark more files as stale
        prepared.target.markDescendentsStale.all("%")
        return created
        // TODO: Commit
        // TODO: Return something
      },

      /** @param {string} filePath */
      delete(filePath) {
        const deletedSource = prepared.source.delete.get(filePath)
        prepared.settings.delete.all(filePath)
        prepared.dependency.deleteByTarget.all(deletedSource.destination)
          .forEach(({ dependent }) => {
            prepared.dependency.markStale.get(dependent)
          })
        prepared.metadata.deleteByTarget.all(deletedSource.destination)
        prepared.target.delete.get(deletedSource.destination)
      },

      getAll() {
        return prepared.source.getAll.all()
      },

      /**
       * @param {string} filePath
       */
      get(filePath) {
        return prepared.source.get.get(filePath)
      },

      /**
       * @param {string} source
       * @param {number} timestamp
       */
      updateTimestamp(source, timestamp) {
        return prepared.source.update.get(timestamp, source)
      },
    },

    // TODO: Delete setting
    // TODO: Update setting on source change
    setting: {

      /**
       * @param {string} folder
       * @param {string} key
       * @param {string} value
       * @param {string} [source]
       */
      create(folder, key, value, source = "") {
        const type = typeof value
        const safeValue = type === "object"
          ? JSON.stringify(value)
          : value

        const descendents = folder === ""
          ? "%"
          : `${folder}/%`

        prepared.target.markDescendentsStale.all(descendents)

        return prepared.settings.create.get(folder, key, safeValue, source)
      },


      /** @param {string} source */
      deleteBySource(source) {
        const deletedSettings = prepared.settings.delete.all(source)

        deletedSettings.forEach(setting => {
          prepared.dependency.markStale.get(setting.destination)
          prepared.dependency.markDescendentTargetsStale.all(setting.destination + "/%")
        })
      },

      getAll() {
        return prepared.settings.getAll.all()
      },

      /** @param {string} folder */
      getByFolder(folder) {
        const segments = ["", ...(folder).split(path.sep)
          .map((_, index, array) => `${array.slice(0, index + 1).join(path.sep)}`)
          .filter(a => a)]

        const settings = prepared.settings.getByFolder.all(JSON.stringify(segments))
        const grouped = Object.fromEntries(
          prepared.settings.getByFolder.all(JSON.stringify(segments)).
            map(({ label, settings }) => {
              const targets = Object.groupBy(JSON.parse(settings), ({ destination }) => destination)
              for (const key in targets) {
                targets[key] = targets[key].map(({ destination, value }) => value)
              }

              return [label, targets]
            })
        )

        return grouped
      }
    },

    dependency: {


      getAll() {
        return prepared.dependency.getAll.all()
      },

      /**
       * @param {object} dependencyFile
       * @param {string} dependencyKey
       * @param {any} dependencyValue
       * @param {string} dependencyPath
       * @param {string} dependentPath
       */
      track(dependencyFile, dependencyKey, dependencyValue, dependencyPath, dependentPath) {
        Object.defineProperty(dependencyFile, dependencyKey, {
          enumerable: true,
          get() {
            prepared.dependency.create.get(dependencyPath, dependencyKey, dependentPath)
            return dependencyValue
          }
        })
      }
    },

    target: {

      /**
       * @param {string} filePath
       * @returns {TargetOutput}
       */
      get(filePath) {
        const target = prepared.target.get.get(filePath)

        if (!target) return

        const { metadata, abstract, ...rest } = target

        if (!abstract) return

        /** @type {TargetOutput} */
        const copy = {
          abstract: coerceJSON(abstract),
          metadata: coerceJSON(metadata),
          ...rest
        }

        return copy
      },


      /**
       * @returns {TargetOutput[]}
       */
      getAll() {
        const targets = prepared.target.getAll.all()
        
        return targets.map(({ metadata, abstract, ...rest }) => {
          return {
            abstract: coerceJSON(abstract),
            metadata: coerceJSON(metadata),
            ...rest
          }
        })
      },

      /**
       * @returns {TargetOutput[]}
       */
      getStale() {
        const targets = prepared.target.getAllStale.all()

        return targets.map(({ metadata, abstract, ...rest }) => {
          return {
            abstract: coerceJSON(abstract),
            metadata: coerceJSON(metadata),
            ...rest
          }
        })
      },

      /**
       * @param {string} filePath
       * @param {string} dependent
       */
      getWithTrackers(filePath, dependent) {
        const target = queries.target.get(filePath)

        const trackedTarget = { metadata: {} }

        queries.dependency.track(
          trackedTarget,
          "abstract",
          target.abstract,
          filePath,
          dependent
        )

        for (const key in target.metadata) {
          queries.dependency.track(
            trackedTarget.metadata,
            key,
            target.metadata[key],
            filePath,
            dependent
          )
        }
      },

      // TODO: Logical operators (gt, etc)

      /**
       * @typedef {object} TargetGetManyWithTrackersParams
       * @property {string | undefined} [folder]
       * @property {boolean | undefined} [recursive]
       * @property {string | undefined} [dependent]
       * @property {Record<string, string> | undefined} [query]
       */

      /** @param {TargetGetManyWithTrackersParams | undefined} params */
      getManyWithTrackers(params) {
        const { folder = "%", recursive, dependent, query = {} } = params

        const many = prepared.target.getMany
          .all({ folder, recursivePath: recursive ? folder + "/%" : folder, filter: JSON.stringify(query) })
          .map(({ abstract, metadata, ...rest }) => {
            const trackedTarget = {
              abstract: coerceJSON(abstract),
              metadata: coerceJSON(metadata),
              ...rest
            }

            queries.dependency.track(
              trackedTarget,
              "abstract",
              trackedTarget.abstract,
              trackedTarget.path,
              dependent
            )

            for (const key in trackedTarget.metadata) {
              queries.dependency.track(
                trackedTarget.metadata,
                key,
                trackedTarget.metadata[key],
                trackedTarget.path,
                dependent
              )
            }

            return trackedTarget
          })

        return many
      },


      /**
       * @param {TargetInput} target
       */
      create(target) {
        // TODO: BEGIN AND COMMIT
        const dir = target.path && splitURL(target.path)
        const ext = path.extname(target.path)
        const relativePath = path.relative("", target.path).toLowerCase()

        const extant = queries.target.get(target.path)

        if (!extant) {
          const created = prepared.target.create.get(
            relativePath,
            dir,
            ext,
            JSON.stringify(target.abstract)
          )
          prepared.metadata.create.get(relativePath, JSON.stringify(target.metadata))
          return created
        }


        prepared.metadata.create.get(relativePath, JSON.stringify(target.metadata))

        /* TODO: Prune metadata */
        /* TODO: Compare metadata and stale deps */
        const changedAbstract = JSON.stringify(target.abstract) !== JSON.stringify(extant.abstract)

        return extant
      },

      /** @param {string} filePath */
      markFresh(filePath) {
        return prepared.target.markFresh.get(filePath)
      }
    },

    // TODO: Write URL logic
    // TODO: Examine JSON logic with URLs
    url: {

      /**
        * @param {string} url
        * @param {string} data
        * @param {string} destination
        */
      create(url, data, destination) {
        prepared.url.create.get(url, JSON.stringify(data))
        // TODO: Staling logic
      },

      /** @param {string} url */
      get(url) {
        const { data } = prepared.url.get.get(url) || {}
        if (!data) return
        return JSON.parse(data)
      }
    }

  }

  return Object.freeze(queries)
}

/** @param {DatabaseSync} databaseSync */
function createTables(databaseSync) {
  databaseSync.exec(`
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
      abstract STRING
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

  `)
}

export default createDatabase