import { DatabaseSync, backup } from "node:sqlite"
import { splitURL, checkFile, folderAncestors } from "./utils/index.js"
import buildGetManySQL, { buildGetManyEmptySQL, depthOfFilter, MAX_FILTER_DEPTH } from "./buildFilterQuery.js"
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

/**
 * Parses object or array types from JSON and SQLite.
 * @param {{ value: string, type: string } | undefined} row
 */
function parseSettingValue(row) {
  if (!row) return undefined
  if (row.type === "object" || row.type === "array") return JSON.parse(row.value)
  return row.value
}

/**
 * Marks stale anything that depends on the folder `dir` for `property`:
 * exact-match 'folder' dependents, and 'folder_recursive' dependents.
 * @param {ReturnType<prepareStatements>} prepared
 * @param {string} dir
 * @param {string} property
 */
function staleFolderDependents(prepared, dir, property) {
  prepared.dependency.staleFolder.all(dir, property)
  const ancestors = folderAncestors(dir)
  for (const ancestor of ancestors) {
    prepared.dependency.staleFolderRecursive.all(ancestor, property)
  }
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
   * @property {'target' | 'folder' | 'folder_recursive' | 'url'} type
   */

  /**
   * @typedef {object} SQLiteMetadata
   * @property {number} id
   * @property {string} destination
   * @property {string} label
   * @property {string} value
   * @property {'text' | 'integer' | 'array' | 'object' | 'boolean'} type
   * @property {'target' | 'folder' | 'folder_recursive' | 'url'} class
   * @property {string} source
   */

  /**
   * @typedef {object} SQLiteURL
   * @property {string} url
   * @property {string | null} redirect
   * @property {string | null} canonical
   * @property {string | null} data
   * @property {number | null} failedAt
   * @property {number} failureCount
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
        RETURNING *
      `))),


      /**
       * Delete a target and trigger linked metadata and dependencies deletions.
       * @callback SQLiteTargetDelete
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      delete: /** @type {{get: SQLiteTargetDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM destinations WHERE path = ? RETURNING *
      `))),

      /**
       * @callback SQLiteTargetGet
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      get: /** @type {{get: SQLiteTargetGet}} */ (/** @type {unknown} */ (database.prepare(`
        WITH destination AS (
          SELECT * FROM destinations
          LEFT JOIN metadata ON destinations.path = metadata.destination AND metadata.class = 'target'
          WHERE path = ?
        )
        SELECT destination.path, destination.dir, destination.syntax, destination.abstract,
          json_group_object(destination.label, CASE WHEN destination.type IN ('array', 'object') THEN json(destination.value) ELSE destination.value END) AS metadata
        FROM destination
        GROUP BY destination.path
      `))),

      /**
       * @callback SQLiteTargetGetManyWithoutFilters
       * @param {{ folder: string, recursivePath: string }} params
       * @returns {SQLiteTarget[]}
       */

      getManyWithoutFilters: /** @type {{all: SQLiteTargetGetManyWithoutFilters}} */ (/** @type {unknown} */ (database.prepare(buildGetManyEmptySQL()))),

      /**
       * One prepared statement per filter depth actually seen (see
       * `depthOfFilter`), built lazily and kept for the life of this
       * database — at most MAX_FILTER_DEPTH + 1 of them can ever exist, so
       * this never grows into "a new statement per query".
       * @type {(depth: number) => { all: (params: { filter: string, folder: string, recursivePath: string }) => SQLiteTarget[] }}
       */
      getManyWithFilters: (() => {
        const cache = new Map()
        return (depth) => {
          let statement = cache.get(depth)
          if (!statement) {
            statement = database.prepare(buildGetManySQL(depth))
            cache.set(depth, statement)
          }
          return statement
        }
      })(),

      /**
       * @callback SQLiteTargetGetAll
       * @returns {SQLiteTarget[]}
       */

      getAll: /** @type {{all: SQLiteTargetGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT destinations.*, json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) ELSE i.value END) AS metadata
        FROM destinations
        LEFT JOIN metadata i ON destinations.path = i.destination AND i.class = 'target'
        GROUP BY destinations.path
      `))),

      /**
       * @callback SQLiteTargetGetAllStale
       * @returns {SQLiteTarget[]}
       */

      getAllStale: /** @type {{all: SQLiteTargetGetAllStale}} */ (/** @type {unknown} */ (database.prepare(`
        WITH destination AS (
          SELECT * FROM destinations
          LEFT JOIN metadata ON destinations.path = metadata.destination AND metadata.class = 'target'
        )
        SELECT destination.path, destination.dir, destination.syntax, destination.abstract,
          json_group_object(destination.label, CASE WHEN destination.type IN ('array', 'object') THEN json(destination.value) ELSE destination.value END) AS metadata
        FROM destination
        WHERE stale = 1
        GROUP BY destination.path
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

      /**
       * Coarse fallback for a label that has never existed anywhere in a
       * folder's ancestor chain before this write: nobody could have
       * registered a fine-grained dependency on a property that didn't
       * exist to read, so instead of tracking, every existing target
       * under `folder` (folder itself and all descendants - same
       * dir = :folder OR dir LIKE :recursivePath scoping as getMany's
       * recursive folder queries) gets marked stale unconditionally.
       * Only fires on a brand-new label (see setting.create); an update
       * to an already-known label still goes through the normal
       * fine-grained staleFolderDependents path untouched.
       * @callback SQLiteTargetMarkStaleSubtree
       * @param {{ folder: string, recursivePath: string }} params
       * @returns {void}
       */

      markStaleSubtree: /** @type {{run: SQLiteTargetMarkStaleSubtree}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 1 WHERE dir = :folder OR dir LIKE :recursivePath
      `))),

      /**
       * @callback SQLiteTargetUpdate
       * @param {string} abstract
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */
      update: /** @type {{get: SQLiteTargetUpdate}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations
        SET abstract = ?
        WHERE path = ?
      `))),
    },

    /* DEPENDENCIES */
    dependency: {

      /**
       * @callback SQLiteDependencyCreate
       * @param {string} destination
       * @param {string} property
       * @param {string} dependent
       * @param {string} type
       * @returns {void}
       */

      create: /** @type {{get: SQLiteDependencyCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR REPLACE INTO dependencies (destination, property, dependent, type)
        VALUES (?, ?, ?, ?)
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

      getAllByTarget: /** @type {{all: SQLiteDependencyGetByTarget}} */ (/** @type {unknown} */ (database.prepare(`
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

      /**
       * Stales members of a folder explicitly. 
       * @callback SQLiteDependencyStaleFolder
       * @param {string} folder
       * @param {string} property
       * @returns {SQLiteTarget[]}
       */

      staleFolder: /** @type {{all: SQLiteDependencyStaleFolder}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 1
        WHERE path IN (SELECT dependent FROM dependencies WHERE type = 'folder' AND destination = ? AND property = ?)
        RETURNING *
      `))),

      /**
       * @callback SQLiteDependencyStaleFolderRecursive
       * @param {string} folder
       * @param {string} property
       * @returns {SQLiteTarget[]}
       */

      staleFolderRecursive: /** @type {{all: SQLiteDependencyStaleFolderRecursive}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE destinations SET stale = 1
        WHERE path IN (SELECT dependent FROM dependencies WHERE type = 'folder_recursive' AND destination = ? AND property = ?)
        RETURNING *
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
        INSERT OR REPLACE INTO metadata (label, value, type, destination, class)
        SELECT
          json_each.key,
          json_each.value,
          json_each.type,
          ?,
          'target'
        FROM json_each(?);
      `))),

      /**
       * @callback SQLiteMetadataDelete
       * @param {string} targetFilePath
       * @param {string} label
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteMetadataDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE destination = ? AND label = ? AND class = 'target'
      `))),

      /**
       * @callback SQLiteMetadataDeleteByTarget
       * @param {string} targetFilePath
       * @returns {void}
       */

      deleteByTarget: /** @type {{all: SQLiteMetadataDeleteByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE destination = ? AND class = 'target'
      `)))
    },

    /* SETTINGS - folder-scoped metadata rows (class = 'folder_recursive') */
    settings: {

      /**
       * @callback SQLiteSettingsCreate
       * @param {string} folder
       * @param {string} label
       * @param {string} value
       * @param {string} type
       * @param {string} sourceFilePath
       * @returns {SQLiteMetadata}
       */

      create: /** @type {{get: SQLiteSettingsCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR REPLACE INTO metadata (destination, label, value, type, class, source)
        VALUES (?, ?, ?, ?, 'folder_recursive', ?)
        RETURNING *
      `))),

      /**
       * Returns a row for a folder-label pair.
       * @callback SQLiteSettingsGet
       * @param {string} folder
       * @param {string} label
       * @returns {{ value: string, type: string } | undefined}
       */

      get: /** @type {{get: SQLiteSettingsGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT value, type FROM metadata WHERE destination = ? AND label = ? AND class = 'folder_recursive'
      `))),

      /**
       * @callback SQLiteSettingsDeleteBySource
       * @param {string} sourceFilePath
       * @returns {SQLiteMetadata[]}
       */

      deleteBySource: /** @type {{all: SQLiteSettingsDeleteBySource}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE source = ? AND class = 'folder_recursive'
        RETURNING *
      `))),

      /**
       * @callback SQLiteSettingsGetAll
       * @returns {SQLiteMetadata[]}
       */

      getAll: /** @type {{all: SQLiteSettingsGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM metadata WHERE class = 'folder_recursive'
      `))), // 'folder_recursive' is correct here, not a placeholder to revisit: setting.create always writes class='folder_recursive' (settings have no non-cascading variant), so that's the only class getAll() could ever need to match.

      /**
       * Distinct labels set anywhere across a folder's ancestor chain -
       * backs getByFolder's ownKeys/getOwnPropertyDescriptor traps.
       * Label discovery only, no values: this must stay cheap and
       * side-effect-free (no dependency tracking), unlike reading a
       * label's actual value.
       * @callback SQLiteSettingsGetLabels
       * @param {JSONString} ancestorsJSON
       * @returns {{ label: string }[]}
       */

      getLabels: /** @type {{all: SQLiteSettingsGetLabels}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT DISTINCT label FROM metadata
        WHERE class = 'folder_recursive'
        AND destination IN (SELECT value FROM json_each(?))
      `))),
    },

    /* URLS */
    url: {

      /**
       * @callback SQLiteURLCreate
       * @param {string} url
       * @param {string | null} redirect
       * @param {string | null} canonical
       * @param {string} data
       * @returns {SQLiteURL}
       */

      create: /** @type {{get: SQLiteURLCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT INTO urls (url, redirect, canonical, data, failedAt, failureCount)
        VALUES (?, ?, ?, ?, NULL, 0)
        ON CONFLICT(url) DO UPDATE SET
          redirect = excluded.redirect,
          canonical = excluded.canonical,
          data = excluded.data,
          failedAt = NULL,
          failureCount = 0
        RETURNING *
      `))),

      /**
       * Returns a URL by either the original URL, the redirect URL,
       * or the canonical URL.
       * @callback SQLiteURLGet
       * @param {{ url: string }} params
       * @returns {SQLiteURL}
       */

      get: /** @type {{get: SQLiteURLGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM urls WHERE url = :url OR redirect = :url OR canonical = :url
      `))),

      /**
       * @callback SQLiteURLRecordFailure
       * @param {string} url
       * @param {number} failedAt
       * @returns {SQLiteURL}
       */

      recordFailure: /** @type {{get: SQLiteURLRecordFailure}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT INTO urls (url, failedAt, failureCount) VALUES (?, ?, 1)
        ON CONFLICT(url) DO UPDATE SET failedAt = excluded.failedAt, failureCount = urls.failureCount + 1
        RETURNING *
      `)))
    }
  }
}

/**
 * @param {string} databasePath
 */
function createDatabase(databasePath = ".votive.db") {

  const database = loadDB(databasePath)
  createTables(database)
  const prepared = prepareStatements(database)

  const queries = {
    begin: () => database.exec("BEGIN TRANSACTION"),
    commit: () => database.exec("COMMIT"),
    restore: () => database.exec("RESTORE"),
    raw: database,

    /**
     * @param {boolean} hasChanges - whether this pass did any real
     *   database work worth persisting. Used to be `sources.length`
     *   directly (new/changed source files), but that misses real changes
     *   from a deferred runBuffers()/runFetches() call, which can create
     *   or update targets with zero source files having changed on disk -
     *   callers should pass true whenever either is the case.
     */
    async saveDB(hasChanges) {
      /*
        FIXME This seems to throw an error sometimes if the backup
        runs too quickly after writing, which maybe happens when
        Votive runs with no changes. To guard against this, I check
        to see if anything has changed. With no changes at all,
        the backup should theoretically be unnecessary.
      */
      if (database.location() || !hasChanges) return // Only save if running in memory
      await backup(database, databasePath)
    },

    source: {

      /**
       * @param {string} source - Source file path.
       * @param {string} target - Destination file path.
       * @param {number} lastModified - Source file date last modified.
       */
      create(source, target, lastModified) {
        return prepared.source.create.get(source, target, lastModified)
      },

      /** @param {string} filePath */
      delete(filePath) {
        const deletedSource = prepared.source.delete.get(filePath)
        const existingTarget = queries.target.get(deletedSource.destination)
        queries.setting.deleteBySource(filePath)

        /*
          Cleans up dependencies of any type, whereas the SQLite trigger
          cleanup_target_rows only cleans targets.
        */
        prepared.dependency.deleteByTarget.all(deletedSource.destination)
          .forEach(({ dependent }) => {
            prepared.target.markStale.get(dependent)
          })
        prepared.target.delete.get(deletedSource.destination)
        if (existingTarget) staleFolderDependents(prepared, existingTarget.dir, "")
        return deletedSource
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

    setting: {

      /**
       * @param {string} folder
       * @param {string} key
       * @param {string} value
       * @param {string} [source]
       */
      create(folder, key, value, source = "") {
        const valueType = typeof value
        const safeValue = valueType === "object"
          ? JSON.stringify(value)
          : valueType === "boolean"
            ? Number(value)
            : value

        /*
          Check if the `key` is new to the ancestor chain.
        */
        const ancestors = folderAncestors(folder)
        const isNewLabel = !prepared.settings.getLabels.all(JSON.stringify(ancestors))
          .some(row => row.label === key)

        const created = prepared.settings.create.get(folder, key, safeValue, valueType, source)
        staleFolderDependents(prepared, folder, key)

        if (isNewLabel) {
          const recursivePath = [folder, "%"].filter(Boolean).join("/")
          prepared.target.markStaleSubtree.run({ folder, recursivePath })
        }
        return created
      },

      /**
       * For setting one field of an object-valued setting without
       * clobbering its other fields: `settings.merge(folder).author.name
       * = "X"` reads the current `author` value (defaulting to `{}`,
       * or wrapping a non-object value can't sensibly be merged into and
       * is discarded), sets just `name`, and persists the whole merged
       * object. Re-reads the current value on every top-level property
       * access, so chained merges into the same label in sequence each
       * see the previous one's result.
       * @param {string} folder
       */
      merge(folder) {
        return new Proxy({}, {
          get: (_, label) => {
            const current = parseSettingValue(prepared.settings.get.get(folder, String(label)))
            const base = (current && typeof current === "object" && !Array.isArray(current)) ? current : {}
            const draft = { ...base }
            return new Proxy(draft, {
              set: (target, key, value) => {
                target[key] = value
                queries.setting.create(folder, String(label), target)
                return true
              }
            })
          },
          set: (_, label, value) => {
            // Assigning the whole label directly (not a nested field)
            // still just overwrites, same as write().
            queries.setting.create(folder, String(label), value)
            return true
          }
        })
      },

      /** @param {string} source */
      deleteBySource(source) {
        const deleted = prepared.settings.deleteBySource.all(source)
        // Per (destination, label), not per destination: a source that
        // wrote several labels at a folder shouldn't stale dependents of
        // labels it didn't touch.
        deleted.forEach(row => staleFolderDependents(prepared, row.destination, row.label))
        return deleted
      },

      getAll() {
        return prepared.settings.getAll.all()
      },

      /**
       * A live, tracked view of this folder's settings cascade. Reading a
       * label returns an array aligned to folderAncestors(folder) - index
       * 0 is the root, the last index is `folder` itself - holding each
       * level's raw, unresolved value (or null where a level never set
       * it). The plugin decides how to resolve it: take the last
       * non-null for override semantics (e.g. theme), flatten every
       * level for accumulate semantics (e.g. stylesheets), or use the
       * sequence as-is (e.g. breadcrumb).
       *
       * Reading a specific index registers a dependency on exactly that
       * ancestor's row for that label (type='folder', exact match) - the
       * write-side mirror of dependency.track()'s per-property getters,
       * scoped to "which folder" instead of "which target". Iterating
       * the whole array (for-of, .map(), spreading, ...) touches every
       * index the same way a manual loop would, so it tracks all of them.
       *
       * Mutating methods (push/pop/shift/unshift/splice) called on the
       * array itself - not on a value obtained via an index - always
       * read-modify-write `folder`'s own row, regardless of which
       * indices were read first; mirrors push(). A value returned by
       * indexing is a read-only snapshot: mutating it locally (e.g.
       * `settings.stylesheets[0].push(x)`) does not persist anything -
       * only calling a mutating method directly on the array does.
       * Assigning to a label directly (`settings.theme = "x"`) overwrites
       * `folder`'s own row, mirroring write().
       *
       * A real object with real `Object.defineProperty`-built accessor
       * properties, not a Proxy - one property per label that already
       * has a row somewhere in the ancestor chain (a plain `SELECT
       * DISTINCT label`, snapshotted once at call time). This means
       * `Object.keys()`/`for...in`/spread/`JSON.stringify()` all see the
       * real label names for free (genuine own properties, no trap
       * needed), and so does plain `console.log(settings)` - unlike a
       * Proxy, Node's default inspect does not bypass a plain object's
       * own accessor properties (it shows `[Getter]` without invoking
       * them, same caveat as ever for seeing resolved values, but the
       * *names* are visible either way).
       *
       * A label with no row anywhere in the chain has no property here
       * at all - `settings.brandNewLabel` is `undefined`, so
       * `.push(...)` on it throws the same TypeError JS already gives
       * you for pushing onto any other undefined, and the object is
       * `Object.preventExtensions`-sealed so plain assignment
       * (`settings.brandNewLabel = x`) throws too, instead of silently
       * creating a local property that's never persisted. Introduce a
       * label for the first time via `database.setting.create(folder,
       * label, value)` (see there for what happens on that first write -
       * short version: every existing target under `folder` gets marked
       * stale unconditionally, since nothing could have been reading a
       * property that didn't exist yet to depend on it).
       * @param {string} folder
       * @param {string} [dependent]
       */
      getByFolder(folder, dependent) {
        const ancestors = folderAncestors(folder)
        const mutators = ["push", "pop", "shift", "unshift", "splice"]
        const labels = prepared.settings.getLabels.all(JSON.stringify(ancestors)).map(row => row.label)

        const settings = {}

        labels.forEach(label => {
          Object.defineProperty(settings, label, {
            enumerable: true,
            configurable: true,
            get() {
              const values = ancestors.map(() => undefined)

              ancestors.forEach((ancestorFolder, index) => {
                Object.defineProperty(values, index, {
                  enumerable: true,
                  configurable: true,
                  get() {
                    if (dependent) prepared.dependency.create.get(ancestorFolder, label, dependent, "folder")
                    return parseSettingValue(prepared.settings.get.get(ancestorFolder, label)) ?? null
                  }
                })
              })

              mutators.forEach(method => {
                Object.defineProperty(values, method, {
                  enumerable: false,
                  value: (...args) => {
                    const current = parseSettingValue(prepared.settings.get.get(folder, label))
                    const own = Array.isArray(current) ? current : current === undefined ? [] : [current]
                    const result = Array.prototype[method].apply(own, args)
                    queries.setting.create(folder, label, own)
                    return result
                  }
                })
              })

              return values
            },
            set(value) {
              queries.setting.create(folder, label, value)
            }
          })
        })

        return Object.preventExtensions(settings)
      }
    },

    dependency: {


      getAll() {
        return prepared.dependency.getAll.all()
      },

      /**
       * @param {string} target
       */
      getAllByTarget(target) {
        return prepared.dependency.getAllByTarget.all(target)
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
            prepared.dependency.create.get(dependencyPath, dependencyKey, dependentPath, "target")
            return dependencyValue
          }
        })
      }
    },

    target: {

      /**
       * @param {string} filePath
       */
      delete(filePath) {

        // Fetch all dependencies
        const deps = queries.dependency.getAllByTarget(filePath)

        // Delete target, metadata, and dependencies
        const deleted = prepared.target.delete.get(filePath)

        // Stale dependencies
        deps.forEach(dep => {
          queries.target.markStale(dep.dependent)
        })
        if (deleted) staleFolderDependents(prepared, deleted.dir, "")
        return deleted
      },

      /**
       * @param {string} filePath
       * @returns {TargetOutput | undefined}
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

        if (!target) return

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

        return target
      },

      /**
       * @typedef {object} TargetGetByFolderParams
       * @property {string | undefined} [folder]
       * @property {boolean | undefined} [recursive]
       * @property {string | undefined} [dependent]
       * @property {object | undefined} [query] - A filter tree, see buildFilterQuery.js
       * @property {{ property: string, direction?: "asc" | "desc" } | undefined} [orderBy] -
       *   sorts the returned array by a metadata property; entries missing
       *   the property sort last regardless of direction. No default sort
       *   is applied when omitted.
       * @property {number | undefined} [limit]
       */

      /**
       * Returns the contents of a folder and tracks changes in the folder
       * by accessed property. Accepts an optional filter `query`.
       * @param {TargetGetByFolderParams | undefined} params
       */
      getByFolder(params) {
        const { folder = "", recursive = false, dependent, query = {}, orderBy, limit } = params || {}

        const recursivePath = [folder, "%"].filter(a => a).join("/")

        // Ordering and limiting both happen here in JS, not in the SQL -
        // scopeParams carries only what the query needs to scope rows,
        // nothing about how many or in what order.
        const scopeParams = {
          folder,
          recursivePath: recursive ? recursivePath : folder
        }

        const isEmpty = !query || Object.keys(query).length === 0
        const results = isEmpty
          ? prepared.target.getManyWithoutFilters.all(scopeParams)
          : prepared.target
            .getManyWithFilters(Math.min(depthOfFilter(query), MAX_FILTER_DEPTH))
            .all({ ...scopeParams, filter: JSON.stringify(query) })

        if (dependent) {
          prepared.dependency.create.get(folder, "", dependent, recursive ? "folder_recursive" : "folder")
        }

        // Per-property lazy tracking, layered on top of the folder-level
        // edge above. The folder edge covers membership (a target
        // appearing/disappearing has no prior property read to have
        // tracked); this covers content, so a dependent that only reads
        // e.g. `title` doesn't get staled by an unrelated `views` change
        // on the same target. Only wired up when `dependent` is given -
        // `dependency.track`'s getter unconditionally writes a dependency
        // row on access, so tracking with no dependent would try to
        // insert a NULL into a NOT NULL column the first time a caller
        // reads the result.
        const many = results.map(({ abstract, metadata, ...rest }) => {
          const parsedAbstract = coerceJSON(abstract)
          const parsedMetadata = coerceJSON(metadata)
          const trackedTarget = { abstract: parsedAbstract, metadata: {}, ...rest }

          if (dependent) {
            queries.dependency.track(trackedTarget, "abstract", parsedAbstract, rest.path, dependent)
            for (const key in parsedMetadata) {
              queries.dependency.track(trackedTarget.metadata, key, parsedMetadata[key], rest.path, dependent)
            }
          } else {
            trackedTarget.metadata = parsedMetadata
          }

          return trackedTarget
        })

        if (orderBy) {
          const direction = orderBy.direction === "desc" ? -1 : 1
          many.sort((a, b) => {
            const av = a.metadata[orderBy.property]
            const bv = b.metadata[orderBy.property]
            if (av === undefined && bv === undefined) return 0
            if (av === undefined) return 1
            if (bv === undefined) return -1
            if (av < bv) return -direction
            if (av > bv) return direction
            return 0
          })
        } else {
          // No orderBy: fall back to a stable, deterministic order (by
          // path) rather than leaving row order to whatever SQLite's
          // GROUP BY happened to produce - SQL no longer guarantees any
          // order here (see scopeParams above), so JS has to.
          many.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        }

        return typeof limit === "number" ? many.slice(0, limit) : many
      },


      /**
       * @param {TargetInput} target
       */
      create(target) {
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
        
          staleFolderDependents(prepared, dir, "")
          return created
        }

        let changed = false

        for (const key in target.metadata) {
          if (target.metadata[key] !== extant.metadata[key]) {
            changed = true

            // TODO use triggers to mark dependencies as stale
            prepared.metadata.create.get(relativePath, JSON.stringify({
              [key]: target.metadata[key]
            }))

            // TODO delete dependencies after marking stale
            prepared.dependency
              .getByTargetAndProperty
              .all(relativePath, key)
              .forEach(dependency => {
                prepared.target.markStale.get(dependency.dependent)
              })
          }
        }

        for (const key in extant.metadata) {
          if (!target.metadata[key]) {
            changed = true
            prepared.metadata.delete.get(relativePath, key)

            // TODO delete dependencies after marking stale
            prepared.dependency
              .getByTargetAndProperty
              .all(relativePath, key)
              .forEach(dependency => {
                prepared.target.markStale.get(dependency.dependent)
              })
          }
        }

        const changedAbstract = JSON.stringify(target.abstract) !== JSON.stringify(extant.abstract)

        if (changedAbstract) {
          changed = true
          prepared.target.update.get(JSON.stringify(target.abstract), relativePath)

          prepared.dependency
            .getByTargetAndProperty
            .all(relativePath, "abstract")
            .forEach(dependency => {
              prepared.target.markStale.get(dependency.dependent)
            })
        }

        if (changed) prepared.target.markStale.get(relativePath)

        return extant
      },

      /** @param {string} filePath */
      markFresh(filePath) {
        return prepared.target.markFresh.get(filePath)
      },

      /** @param {string} filePath */
      markStale(filePath) {
        return prepared.target.markStale.get(filePath)
      }

    },

    url: {

      /**
        * @param {string} url
        * @param {string} data
        * @param {string} [dependent] - the target whose content depends on this URL
        * @param {{ redirect?: string, canonical?: string }} [options]
        */
      create(url, data, dependent, { redirect, canonical } = {}) {
        prepared.url.create.get(url, redirect || null, canonical || null, JSON.stringify(data))
        if (dependent) {
          prepared.dependency.create.get(url, "", dependent, "url")

          // Stale dependent after URL created and again after data fetched
          prepared.target.markStale.get(dependent)
        }
      },

      /** @param {string} url */
      get(url) {
        const row = prepared.url.get.get({ url })
        if (!row || !row.data) return
        return JSON.parse(row.data)
      },

      /**
       * Returns the URL.
       * @param {string} url
       */
      getStatus(url) {
        return prepared.url.get.get({ url })
      },

      /**
       * @param {string} url
       * @param {number} [failedAt]
       */
      recordFailure(url, failedAt = Date.now()) {
        return prepared.url.recordFailure.get(url, failedAt)
      }
    }

  }

  return Object.freeze(queries)
}

/*
  @CLAUDE: Is it better to run `ensureColumn` on startup or in an error handler?
*/

/**
 * Adds a column to an existing table if it isn't already there. CREATE
 * TABLE IF NOT EXISTS is a no-op against a table that already exists on
 * disk from before a schema change, so new columns (dependencies.type,
 * metadata.class/source) need this to reach a `.votive.db` created by an
 * older version of this file.
 * @param {DatabaseSync} databaseSync
 * @param {string} table
 * @param {string} column
 * @param {string} definition - full column definition, e.g. "type STRING NOT NULL DEFAULT 'target'"
 */
function ensureColumn(databaseSync, table, column, definition) {
  const columns = databaseSync.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some(c => c.name === column)) return
  databaseSync.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

/** @param {DatabaseSync} databaseSync */
function createTables(databaseSync) {
  databaseSync.exec(`
    -- Without this, "dir LIKE :recursivePath" is case-insensitive while
    -- "dir = :folder" (the other half of the same OR, in getMany) is not.
    -- That mismatch also disables SQLite's LIKE-to-index-range rewrite,
    -- forcing a full table scan of destinations on every getMany call.
    PRAGMA case_sensitive_like = ON;

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      destination STRING,
      path STRING,
      lastModified INTEGER
    );

    -- type: see SQLiteDependency's @property doc above.
    CREATE TABLE IF NOT EXISTS dependencies (
      key INTEGER PRIMARY KEY,
      destination STRING NOT NULL,
      property STRING NOT NULL,
      dependent STRING NOT NULL,
      type STRING NOT NULL DEFAULT 'target',
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

    CREATE INDEX IF NOT EXISTS idx_destinations_dir ON destinations (dir);

    -- type, class, source: see SQLiteMetadata's @property docs above.
    CREATE TABLE IF NOT EXISTS metadata (
      id INTEGER PRIMARY KEY,
      destination STRING,
      label STRING,
      value STRING,
      type STRING,
      class STRING NOT NULL DEFAULT 'target',
      source STRING NOT NULL DEFAULT '',
      UNIQUE(destination, label)
    );

    -- redirect/canonical: the same fetched data is reachable by the
    -- originally-requested URL, the post-redirect URL, and the page's own
    -- declared canonical URL (if any) - one row, three possible lookup
    -- keys, rather than three duplicate rows.
    -- failedAt/failureCount: a failed fetch is cached too (data stays
    -- NULL), so a permanently-dead URL doesn't get re-fetched on every
    -- build - failureCount drives an exponential cooldown before retrying.
    CREATE TABLE IF NOT EXISTS urls (
      url STRING PRIMARY KEY,
      redirect STRING,
      canonical STRING,
      data STRING,
      failedAt INTEGER,
      failureCount INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_urls_redirect ON urls (redirect);
    CREATE INDEX IF NOT EXISTS idx_urls_canonical ON urls (canonical);

    -- Cleans up a deleted target's own metadata/dependency rows. Not a
    -- declarative FOREIGN KEY: destination is polymorphic (a target path
    -- for class/type='target', but a folder path or URL string for the
    -- others), and a FK constraint has no way to be conditional on that -
    -- it would reject every folder/url-type row as a violation. A trigger
    -- can check class/type in its WHERE clause; a bare FK can't.
    CREATE TRIGGER IF NOT EXISTS cleanup_target_rows AFTER DELETE ON destinations BEGIN
      DELETE FROM metadata WHERE destination = OLD.path AND class = 'target';
      DELETE FROM dependencies WHERE destination = OLD.path AND type = 'target';
    END;

  `)

  ensureColumn(databaseSync, "urls", "redirect", "redirect STRING")
  ensureColumn(databaseSync, "urls", "canonical", "canonical STRING")
  ensureColumn(databaseSync, "urls", "failedAt", "failedAt INTEGER")
  ensureColumn(databaseSync, "urls", "failureCount", "failureCount INTEGER NOT NULL DEFAULT 0")

  ensureColumn(databaseSync, "dependencies", "type", "type STRING NOT NULL DEFAULT 'target'")
  ensureColumn(databaseSync, "metadata", "class", "class STRING NOT NULL DEFAULT 'target'")
  ensureColumn(databaseSync, "metadata", "source", "source STRING NOT NULL DEFAULT ''")
}

export default createDatabase