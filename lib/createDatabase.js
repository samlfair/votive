import { DatabaseSync, backup } from "node:sqlite"
import { splitURL, checkFile, folderAncestors } from "./utils/index.js"
import buildGetManySQL, { compileFilter } from "./buildFilterQuery.js"
import path from "node:path"
import { rmSync } from "node:fs"

/** @typedef {ReturnType<createDatabase>} Database */

/**
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
 * @property {string} extension
 * @property {number} stale
 * @property {Metadata} metadata
 * @property {Record<string, string>} types - one entry per metadata
 *   label: the type the writer declared (`{ $type, $value }` at the
 *   write), else JSON's as json_each reports it - `text`, `integer`,
 *   `real`, `true`, `false`, `null`, `array`, `object`. The value in
 *   `metadata` is the same either way; this is for a consumer that
 *   wants to know a `text` is a `date`.
 * @property {string | null} source - the source file path that produced
 *   this target, if any (set once at creation, absent for synthetically
 *   generated targets like a sitemap or 404 page). Backs
 *   writeTargets.js's `target.buffer()`/`.stream()` helpers.
 * @property {string | null} data - **the target's content, and its source
 *   of truth.** For a text target this is the text the target is made
 *   from (markdown source, CSS, XML); after the write pass it is the
 *   rendered output, because writeTargets stores what writeFile produced.
 *   For a copy-through target (image, font, PDF) it is null and the bytes
 *   come from `target.buffer()`.
 *
 *   `data` is mutable: a transformFile may rewrite it.
 *
 *   **An abstract is a metadata convention, not a votive concept.** A
 *   plugin may keep a parsed form under a namespaced metadata key -
 *   `metadata.hastAbstract` is the name vowel standardises on for hast -
 *   as a convenience. Votive neither creates nor validates one, because
 *   its structure is plugin-defined and unknowable here. A consumer that
 *   is unsure of an abstract's structure should read `data` instead: if
 *   the expected abstract key is absent, parse `data`.
 *
 *   **A plugin that changes one must keep the other in sync.** The
 *   duplication (source text in `data`, parsed tree in metadata) is
 *   accepted deliberately; nothing enforces it.
 * @property {number} write - 1 (default) or 0. A target with `write = 0`
 *   is "virtual" - writeTargets.js still runs its processor's writeFile
 *   (so any side effects happen normally), just skips the actual
 *   fs.writeFile() call. Lets a plugin author manage data via a target
 *   (readable through api.target()/api.targets()) without a file ever
 *   landing on disk for it - e.g. a reusable partial. Set via
 *   `readFile()` returning `write: false` (see readSources.js/
 *   readBuffers.js) - never toggled by votive itself.
 */

/**
 * @typedef {object} TargetInput
 * @property {string} path
 * @property {Metadata} metadata
 * @property {string} [source]
 * @property {string} [data]
 * @property {boolean} [write] - defaults to true (written normally) when
 *   omitted; only `false` is meaningful, not the presence of the key.
 */


/**
 * @param {string} json
 * @returns {object | array}
 */
function coerceJSON(json) {
  // The guard has to come first: JSON.parse(undefined) throws
  // `"undefined" is not valid JSON`. The old Array.isArray check tested
  // the *string* rather than the parsed value, so it was always false;
  // `typeof parsed === "object"` is true for arrays anyway.
  if (!json) return {}
  const parsed = JSON.parse(json)
  return parsed && typeof parsed === "object" ? parsed : {}
}

/**
 * `write` is stored as 0/1 (SQLite has no boolean) but is a boolean
 * everywhere a plugin sees it. This is the read half; the write half is
 * `target.write === false ? 0 : 1` at each insert.
 * @param {object} row
 * @returns {object}
 */
function coerceRow(row) {
  return { ...row, write: row.write !== 0 }
}

/**
 * A row from any of the aggregating SELECTs into a TargetOutput: metadata
 * and types parsed from their json_group_object text, write coerced.
 * @param {SQLiteTarget} row
 * @returns {TargetOutput}
 */
function rowToTarget({ metadata, types, ...rest }) {
  return coerceRow({
    ...rest,
    metadata: coerceJSON(metadata),
    types: coerceJSON(types)
  })
}

/**
 * Splits a metadata object into its values and its declared types. A
 * value written as exactly `{ $type, $value }` is a declaration: the
 * value stored is `$value`, and `$type` is recorded beside it. Anything
 * else - including an object that has those keys and others - is a
 * value. `$type` is a lowercase name, so it extends JSON's vocabulary
 * (`string`, `array`, ...) rather than respelling it.
 * @param {Record<string, unknown> | undefined} metadata
 * @returns {{ values: Record<string, unknown>, types: Record<string, string> }}
 */
function unwrapDeclaredTypes(metadata) {
  const values = {}
  const types = {}
  for (const key in metadata) {
    const value = metadata[key]
    if (!isDeclaration(value)) {
      values[key] = value
      continue
    }
    if (typeof value.$type !== "string" || !/^[a-z][a-z0-9_]*$/.test(value.$type)) {
      throw new Error(`Metadata "${key}" declares $type ${JSON.stringify(value.$type)}; a declared type is a lowercase name, like "date" or "url".`)
    }
    values[key] = value.$value
    types[key] = value.$type
  }
  return { values, types }
}

/** @param {unknown} value */
function isDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 2 && "$type" in value && "$value" in value
}

/**
 * (A settings row's `value` is a JSON array of the values one source
 * wrote at that folder - see queries.setting.write.)
 */
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

/**
 * Canonicalizes a target path to the same form it's stored under, so a
 * lookup always matches regardless of leading "./", casing, etc.
 * @param {string} filePath
 */
function canonicalTargetPath(filePath) {
  return path.relative("", filePath)
}

/**
 * Bumped when a change to how rows are stored can't be expressed as
 * ensureColumn (which only adds columns). An on-disk database from an
 * older version is discarded rather than migrated: it is a cache,
 * rebuildable from the source folder, and this gives every future shape
 * change the same one-line answer. Version 1: settings rows hold a plain
 * JSON array with `source` in its own column, not the accumulator's
 * list of {value, source} entries - a value-shaped reader would have
 * parsed the old rows as arrays of objects.
 */
const SCHEMA_VERSION = 1

/** @param {string} dbPath */
function loadDB(dbPath) {
  if (!checkFile(dbPath)) return new DatabaseSync(":memory:")

  const existing = new DatabaseSync(dbPath)
  const { user_version: version } = /** @type {{user_version: number}} */ (existing.prepare("PRAGMA user_version").get())
  if (version !== SCHEMA_VERSION) {
    existing.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true })
    return new DatabaseSync(":memory:")
  }

  const database = existing
  // WAL plus synchronous=NORMAL, because every build writes one row per
  // property a plugin reads (thousands on a real site) and the default
  // journal_mode=delete/synchronous=FULL makes each autocommit an fsync.
  // Both are safe here: this database is a cache that can be rebuilt from
  // the source folder, and NORMAL still guarantees consistency - it only
  // relaxes durability across a power loss.
  database.exec("PRAGMA journal_mode=WAL")
  database.exec("PRAGMA synchronous=NORMAL")
  return database
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
   * @property {string} target
   * @property {string} filePath
   * @property {number} lastModified
   */

  /**
   * @typedef {object} SQLiteTarget
   * @property {number} key
   * @property {string} path
   * @property {string} dir
   * @property {string} extension
   * @property {number} stale
   * @property {JSONString} metadata
   * @property {string | null} source
   * @property {string | null} data
   * @property {number} write
   */

  /**
   * @typedef {object} SQLiteDependency
   * @property {number} key
   * @property {string} target
   * @property {string} property
   * @property {string} dependent
   * @property {'target' | 'folder' | 'folder_recursive' | 'url'} type
   */

  /**
   * @typedef {object} SQLiteMetadata
   * @property {number} id
   * @property {string} target
   * @property {string} label
   * @property {string} value
   * @property {'text' | 'integer' | 'real' | 'array' | 'object' | 'true' | 'false' | 'null'} type
   *   As reported by SQLite's json_each: a boolean is 'true'/'false', never
   *   'boolean', and its value column holds 1/0. The read paths use the type
   *   itself as the JSON literal to restore it.
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
       * @param {string} target
       * @param {number} timestamp
       * @returns {SQLiteSource}
       */

      create: /** @type {{get: SQLiteSourcesCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT INTO sources (path, target, lastModified, stub) VALUES (?, ?, ?, ?)
        RETURNING *
      `))),

      /**
       * Every stub row. The diff reads this once per pass and compares
       * `stub` (the canonical params) by string equality.
       * @callback SQLiteSourcesGetStubs
       * @returns {SQLiteSource[]}
       */

      getStubs: /** @type {{all: SQLiteSourcesGetStubs}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM sources WHERE stub IS NOT NULL
      `))),

      /**
       * Does a real file source claim this path? A stub is shadowed by a
       * file at the same path, and this is how that is answered without a
       * stat - on an incremental pass there is no directory scan to
       * consult, and the database already knows every file source.
       * @callback SQLiteSourcesGetFile
       * @param {string} path
       * @returns {SQLiteSource | undefined}
       */

      getFile: /** @type {{get: SQLiteSourcesGetFile}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM sources WHERE path = ? AND stub IS NULL
      `))),

      /**
       * @callback SQLiteSourcesUpdateStub
       * @param {string} params - canonical serialization
       * @param {string} path
       * @returns {void}
       */

      updateStub: /** @type {{get: SQLiteSourcesUpdateStub}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE sources SET stub = ? WHERE path = ?
      `))),

      /**
       * Turns a stub row into a file row. A real file appearing at a
       * stub's path takes the path over; the row has to stop being a stub
       * or nothing will ever shadow it and nothing will ever prune it.
       * @callback SQLiteSourcesClearStub
       * @param {string} path
       * @returns {void}
       */

      clearStub: /** @type {{get: SQLiteSourcesClearStub}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE sources SET stub = NULL WHERE path = ?
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
       * @param {string} extension
       * @param {string | null} source
       * @param {string | null} data
       * @param {number} write
       * @returns {SQLiteTarget}
       */

      create: /** @type {{get: SQLiteTargetCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR IGNORE INTO targets (path, dir, extension, stale, source, data, write)
        VALUES (?, ?, ?, 1, ?, ?, ?)
        RETURNING *
      `))),


      /**
       * Delete a target and trigger linked metadata and dependencies deletions.
       * @callback SQLiteTargetDelete
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      delete: /** @type {{get: SQLiteTargetDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM targets WHERE path = ? RETURNING *
      `))),

      /**
       * @callback SQLiteTargetGet
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      get: /** @type {{get: SQLiteTargetGet}} */ (/** @type {unknown} */ (database.prepare(`
        WITH joined AS (
          SELECT * FROM targets
          LEFT JOIN metadata ON targets.path = metadata.target AND metadata.class = 'target'
          WHERE path = ?
        )
        SELECT joined.path, joined.dir, joined.extension, joined.source, joined.data, joined.write,
          json_group_object(joined.label, CASE WHEN joined.type IN ('array', 'object') THEN json(joined.value) WHEN joined.type IN ('true', 'false') THEN json(joined.type) ELSE joined.value END) AS metadata,
          json_group_object(joined.label, COALESCE(joined.declared_type, joined.type)) AS types
        FROM joined
        GROUP BY joined.path
      `))),

    
      /**
       * @callback SQLiteTargetGet
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      getBySource: /** @type {{get: SQLiteTargetGet}} */ (/** @type {unknown} */ (database.prepare(`
        WITH joined AS (
          SELECT * FROM targets
          LEFT JOIN metadata ON targets.path = metadata.target AND metadata.class = 'target'
          WHERE targets.source = ?
        )
        SELECT joined.path, joined.dir, joined.extension, joined.source, joined.data, joined.write,
          json_group_object(joined.label, CASE WHEN joined.type IN ('array', 'object') THEN json(joined.value) WHEN joined.type IN ('true', 'false') THEN json(joined.type) ELSE joined.value END) AS metadata,
          json_group_object(joined.label, COALESCE(joined.declared_type, joined.type)) AS types
        FROM joined
        GROUP BY joined.path
      `))),

      /**
       * One prepared statement per distinct compiled WHERE clause, built
       * lazily and kept for the life of this database. Keyed on the SQL
       * text, which is the filter's *shape* - values are parameters, so
       * `{status: "draft"}` and `{status: "published"}` share one statement.
       * Filter shapes repeat (one per listing directive on a site), so this
       * stays small.
       * @type {(where: string) => { all: (...params: unknown[]) => SQLiteTarget[] }}
       */
      getManyWithFilters: (() => {
        const cache = new Map()
        return (where) => {
          const cached = cache.get(where)
          if (cached) return cached
          const statement = database.prepare(buildGetManySQL(where))
          cache.set(where, statement)
          return statement
        }
      })(),

      /**
       * @callback SQLiteTargetGetAll
       * @returns {SQLiteTarget[]}
       */

      getAll: /** @type {{all: SQLiteTargetGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT targets.*, json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) WHEN i.type IN ('true', 'false') THEN json(i.type) ELSE i.value END) AS metadata,
          json_group_object(i.label, COALESCE(i.declared_type, i.type)) AS types
        FROM targets
        LEFT JOIN metadata i ON targets.path = i.target AND i.class = 'target'
        GROUP BY targets.path
      `))),

      /**
       * @callback SQLiteTargetGetAllStale
       * @returns {SQLiteTarget[]}
       */

      getAllStale: /** @type {{all: SQLiteTargetGetAllStale}} */ (/** @type {unknown} */ (database.prepare(`
        WITH joined AS (
          SELECT * FROM targets
          LEFT JOIN metadata ON targets.path = metadata.target AND metadata.class = 'target'
        )
        SELECT joined.path, joined.dir, joined.extension, joined.source, joined.data, joined.write,
          json_group_object(joined.label, CASE WHEN joined.type IN ('array', 'object') THEN json(joined.value) WHEN joined.type IN ('true', 'false') THEN json(joined.type) ELSE joined.value END) AS metadata,
          json_group_object(joined.label, COALESCE(joined.declared_type, joined.type)) AS types
        FROM joined
        WHERE stale = 1
        GROUP BY joined.path
      `))),

      /**
       * @callback SQLiteTargetMarkFresh
       * @param {string} targetFilePath
       * @returns {SQLiteTarget[]}
       */

      markFresh: /** @type {{get: SQLiteTargetMarkFresh}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET stale = 0 WHERE path = ? RETURNING *
      `))),

      /**
       * @callback SQLiteTargetMarkStale
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */

      markStale: /** @type {{get: SQLiteTargetMarkStale}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET stale = 1 WHERE path = ? RETURNING *
      `))),

      /**
       * Coarse fallback for a label that has never existed anywhere in a
       * folder's ancestor chain before this write: nobody could have
       * registered a fine-grained dependency on a property that didn't
       * exist to read, so instead of tracking, every existing target
       * under `folder` (folder itself and all descendants - same
       * dir = :folder OR dir LIKE :recursivePath scoping as getMany's
       * recursive folder queries) gets marked stale unconditionally.
       * Only fires on a brand-new label (see setting.write); an update
       * to an already-known label still goes through the normal
       * fine-grained staleFolderDependents path untouched.
       * @callback SQLiteTargetMarkStaleSubtree
       * @param {{ folder: string, recursivePath: string }} params
       * @returns {void}
       */

      markStaleSubtree: /** @type {{run: SQLiteTargetMarkStaleSubtree}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET stale = 1 WHERE dir = :folder OR dir LIKE :recursivePath
      `))),

      /**
       * @callback SQLiteTargetUpdateData
       * @param {string | null} data
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */
      updateData: /** @type {{get: SQLiteTargetUpdateData}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets
        SET data = ?
        WHERE path = ?
      `))),

      /**
       * @callback SQLiteTargetUpdateWrite
       * @param {number} write
       * @param {string} targetFilePath
       * @returns {SQLiteTarget}
       */
      /**
       * @callback SQLiteTargetUpdateSource
       * @param {string} source
       * @param {string} targetPath
       * @returns {void}
       */

      updateSource: /** @type {{get: SQLiteTargetUpdateSource}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET source = ? WHERE path = ?
      `))),

      updateWrite: /** @type {{get: SQLiteTargetUpdateWrite}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets
        SET write = ?
        WHERE path = ?
      `))),
    },

    /* DEPENDENCIES */
    dependency: {

      /**
       * @callback SQLiteDependencyCreate
       * @param {string} target
       * @param {string} property
       * @param {string} dependent
       * @param {string} type
       * @returns {void}
       */

      create: /** @type {{get: SQLiteDependencyCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR REPLACE INTO dependencies (target, property, dependent, type)
        VALUES (?, ?, ?, ?)
      `))),

      /**
       * @callback SQLiteDependencyDeleteByTarget
       * @param {string} targetFilePath
       * @returns {SQLiteDependency[]}
       */

      deleteByTarget: /** @type {{all: SQLiteDependencyDeleteByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM dependencies WHERE target = ? RETURNING dependent
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
        SELECT * FROM dependencies WHERE target = ?
      `))),

      /**
       * @callback SQLiteDependencyGetByTargetAndProperty
       * @param {string} targetFilePath
       * @param {string} property
       * @returns {SQLiteDependency[]}
       */

      getByTargetAndProperty: /** @type {{all: SQLiteDependencyGetByTargetAndProperty}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM dependencies WHERE target = ? AND property = ?
      `))),

      /**
       * Stales members of a folder explicitly. 
       * @callback SQLiteDependencyStaleFolder
       * @param {string} folder
       * @param {string} property
       * @returns {SQLiteTarget[]}
       */

      staleFolder: /** @type {{all: SQLiteDependencyStaleFolder}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET stale = 1
        WHERE path IN (SELECT dependent FROM dependencies WHERE type = 'folder' AND target = ? AND property = ?)
        RETURNING *
      `))),

      /**
       * @callback SQLiteDependencyStaleFolderRecursive
       * @param {string} folder
       * @param {string} property
       * @returns {SQLiteTarget[]}
       */

      staleFolderRecursive: /** @type {{all: SQLiteDependencyStaleFolderRecursive}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE targets SET stale = 1
        WHERE path IN (SELECT dependent FROM dependencies WHERE type = 'folder_recursive' AND target = ? AND property = ?)
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
        INSERT OR REPLACE INTO metadata (label, value, type, target, class)
        SELECT
          json_each.key,
          json_each.value,
          json_each.type,
          ?,
          'target'
        FROM json_each(?);
      `))),

      /**
       * Records (or clears, with NULL) a label's declared type. Separate
       * from the insert above because json_each derives `type`, and the
       * declaration is the plugin's - see unwrapDeclaredTypes.
       * @callback SQLiteMetadataDeclare
       * @param {string | null} declaredType
       * @param {string} targetFilePath
       * @param {string} label
       * @returns {void}
       */

      declare: /** @type {{get: SQLiteMetadataDeclare}} */ (/** @type {unknown} */ (database.prepare(`
        UPDATE metadata SET declared_type = ? WHERE target = ? AND label = ? AND class = 'target'
      `))),

      /**
       * A target's declared types only, for the change check in
       * target.create - `types` on a read holds JSON's type for undeclared
       * labels, which is not the same question.
       * @callback SQLiteMetadataGetDeclared
       * @param {string} targetFilePath
       * @returns {{label: string, declared_type: string}[]}
       */

      getDeclared: /** @type {{all: SQLiteMetadataGetDeclared}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT label, declared_type FROM metadata WHERE target = ? AND class = 'target' AND declared_type IS NOT NULL
      `))),

      /**
       * @callback SQLiteMetadataDelete
       * @param {string} targetFilePath
       * @param {string} label
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteMetadataDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE target = ? AND label = ? AND class = 'target'
      `))),

      /**
       * Every distinct value stored under `label`, flattening array
       * values into their elements. This exists for stub enumeration,
       * which runs on every pass: the tags enumerator asks "what tags
       * exist on this site", and the alternative is pulling every target
       * through target.getAll() and flattening in JS, which is linear in
       * target count per build. Scalars come back as themselves, arrays
       * as their elements, objects are skipped - the question only makes
       * sense for values you could name.
       * @callback SQLiteMetadataDistinct
       * @param {string} label
       * @returns {{value: unknown}[]}
       */

      distinct: /** @type {{all: SQLiteMetadataDistinct}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT DISTINCT value FROM (
          SELECT CASE
            WHEN json_valid(value) AND json_type(value) = 'array' THEN NULL
            ELSE value
          END AS value
          FROM metadata WHERE label = ? AND class = 'target'
          UNION ALL
          SELECT json_each.value AS value
          FROM metadata, json_each(metadata.value)
          WHERE metadata.label = ? AND metadata.class = 'target'
            AND json_valid(metadata.value)
            AND json_type(metadata.value) = 'array'
        )
        WHERE value IS NOT NULL
      `))),

      /**
       * @callback SQLiteMetadataDeleteByTarget
       * @param {string} targetFilePath
       * @returns {void}
       */

      deleteByTarget: /** @type {{all: SQLiteMetadataDeleteByTarget}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE target = ? AND class = 'target'
      `)))
    },

    /* SETTINGS - folder-scoped metadata rows (class = 'folder_recursive') */
    settings: {

      /**
       * One writer per (folder, label): the row holds the values that
       * source wrote there, as a JSON array (a scalar is a one-element
       * array), and `source` records who wrote it - see
       * queries.setting.write. UNIQUE(target, label) makes this
       * last-write-wins.
       * @callback SQLiteSettingsCreate
       * @param {string} folder
       * @param {string} label
       * @param {string} value
       * @param {string} sourcePath
       * @returns {SQLiteMetadata}
       */

      create: /** @type {{get: SQLiteSettingsCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT OR REPLACE INTO metadata (target, label, value, type, class, source)
        VALUES (?, ?, ?, 'array', 'folder_recursive', ?)
        RETURNING *
      `))),

      /**
       * Returns a row for a folder-label pair.
       * @callback SQLiteSettingsGet
       * @param {string} folder
       * @param {string} label
       * @returns {{ value: string, source: string } | undefined}
       */

      get: /** @type {{get: SQLiteSettingsGet}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT value, source FROM metadata WHERE target = ? AND label = ? AND class = 'folder_recursive'
      `))),

      /**
       * Every settings row a source wrote - one indexed lookup on
       * (class, source), which is what lets "this source stopped
       * contributing X" and "this source was deleted" avoid scanning
       * every settings row.
       * @callback SQLiteSettingsGetBySource
       * @param {string} sourcePath
       * @returns {{ target: string, label: string }[]}
       */

      getBySource: /** @type {{all: SQLiteSettingsGetBySource}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT target, label FROM metadata WHERE class = 'folder_recursive' AND source = ?
      `))),

      /**
       * @callback SQLiteSettingsDelete
       * @param {string} folder
       * @param {string} label
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteSettingsDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM metadata WHERE target = ? AND label = ? AND class = 'folder_recursive'
      `))),

      /**
       * @callback SQLiteSettingsGetAll
       * @returns {SQLiteMetadata[]}
       */

      getAll: /** @type {{all: SQLiteSettingsGetAll}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM metadata WHERE class = 'folder_recursive'
      `))), // 'folder_recursive' is correct here, not a placeholder to revisit: setting.write always writes class='folder_recursive' (settings have no non-cascading variant), so that's the only class getAll() could ever need to match.

      /**
       * Every distinct value written for a label, at any folder. A
       * settings row's value is the JSON array of what one source wrote
       * there, so it is flattened; an object or array value comes back
       * as its JSON text and is parsed by the caller.
       * @callback SQLiteSettingsDistinct
       * @param {string} label
       * @returns {{value: unknown, type: string}[]}
       */

      distinct: /** @type {{all: SQLiteSettingsDistinct}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT DISTINCT json_each.value AS value, json_each.type AS type
        FROM metadata, json_each(metadata.value)
        WHERE metadata.label = ? AND metadata.class = 'folder_recursive'
      `))),

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
        AND target IN (SELECT value FROM json_each(?))
      `))),
    },

    /* URLS */
    url: {

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

      /**
       * @callback SQLiteURLDelete
       * @param {string} url
       * @returns {void}
       */

      delete: /** @type {{get: SQLiteURLDelete}} */ (/** @type {unknown} */ (database.prepare(`
        DELETE FROM urls WHERE url = ?
      `))),

      /**
       * Writes a row a source file supplies. Clears failure state: a file
       * saying what a URL is beats a record of once failing to fetch it.
       * @callback SQLiteURLCreate
       * @param {string} url
       * @param {string | null} redirect
       * @param {string | null} canonical
       * @param {string} data
       * @param {string} source
       * @returns {void}
       */

      create: /** @type {{get: SQLiteURLCreate}} */ (/** @type {unknown} */ (database.prepare(`
        INSERT INTO urls (url, redirect, canonical, data, source, failedAt, failureCount)
        VALUES (?, ?, ?, ?, ?, NULL, 0)
        ON CONFLICT(url) DO UPDATE SET
          redirect = excluded.redirect,
          canonical = excluded.canonical,
          data = excluded.data,
          source = excluded.source,
          failedAt = NULL,
          failureCount = 0
      `))),

      /**
       * @callback SQLiteURLGetBySource
       * @param {string} source
       * @returns {SQLiteURL[]}
       */

      getBySource: /** @type {{all: SQLiteURLGetBySource}} */ (/** @type {unknown} */ (database.prepare(`
        SELECT * FROM urls WHERE source = ?
      `))),

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
/**
 * @param {string} [databasePath]
 * @param {object} [options]
 * @param {(level: string, message: string) => void} [options.log] - where
 *   the database reports things worth a person's attention (a setting
 *   overwritten by a second writer). Defaults to silence.
 */
function createDatabase(databasePath = ".votive.db", { log = () => {} } = {}) {

  const database = loadDB(databasePath)
  createTables(database)
  const prepared = prepareStatements(database)

  /** URLs asked for since the last fetch pass - see queries.url.request. @type {Map<string, any>} */
  const pendingURLs = new Set()

  const queries = {
    begin: () => database.exec("BEGIN TRANSACTION"),
    commit: () => database.exec("COMMIT"),
    rollback: () => database.exec("ROLLBACK"),
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

    /**
     * Releases the underlying file. A host that outlives a single project
     * (the desktop app switching projects in-process) needs this; the CLI
     * never calls it, because the process ending is the close.
     */
    close() {
      database.close()
    },

    source: {

      /**
       * @param {string} source - Source file path.
       * @param {string} target - Target file path.
       * @param {number} lastModified - Source file date last modified.
       */
      create(source, target, lastModified, stub = null) {
        return prepared.source.create.get(source, target, lastModified, stub)
      },

      /**
       * Every stub row, for the enumeration diff.
       * @returns {SQLiteSource[]}
       */
      getStubs() {
        return prepared.source.getStubs.all()
      },

      /**
       * The file source at this path, if one exists. A stub whose path a
       * real file claims is dropped - that is what makes "write your own
       * 404.md" an override rather than a conflict.
       * @param {string} sourcePath
       */
      getFile(sourcePath) {
        return prepared.source.getFile.get(sourcePath)
      },

      /**
       * @param {string} sourcePath
       * @param {string} params - canonical serialization
       */
      updateStub(sourcePath, params) {
        prepared.source.updateStub.get(params, sourcePath)
      },

      /**
       * @param {string} sourcePath
       */
      clearStub(sourcePath) {
        prepared.source.clearStub.get(sourcePath)
      },

      /** @param {string} filePath */
      delete(filePath) {
        const deletedSource = prepared.source.delete.get(filePath)

        // No row: nothing to delete, and nothing to say. A watcher can
        // report one unlink twice, and a prune can name a file that was
        // never recorded; neither is an error.
        if (!deletedSource) return undefined

        queries.setting.deleteBySource(filePath)
        queries.url.deleteBySource(filePath)

        // A source that routed nowhere (settings.md) has no target: its
        // settings were its whole contribution.
        if (!deletedSource.target) return deletedSource

        const existingTarget = queries.target.get(deletedSource.target)

        // Only delete a target this source still owns. Two sources can
        // route to one path - vowel's `home.md` and a stub `index.md`
        // both produce `index.html` - and when the author adds the real
        // file, the stub is dropped in the same pass that the file is
        // read. Without this check, retiring the stub would delete the
        // target the file had just created, and the author's homepage
        // would vanish on the build that introduced it.
        if (existingTarget && existingTarget.source && existingTarget.source !== filePath) {
          return deletedSource
        }

        /*
          Cleans up dependencies of any type, whereas the SQLite trigger
          cleanup_target_rows only cleans targets.
        */
        prepared.dependency.deleteByTarget.all(deletedSource.target)
          .forEach(({ dependent }) => {
            prepared.target.markStale.get(dependent)
          })
        prepared.target.delete.get(deletedSource.target)
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

    metadata: {

      /**
       * Every distinct value stored under `label` across every target,
       * with array values flattened into their elements. For stub
       * enumeration: "which tags exist" is one indexed query rather than
       * target.getAll() flattened in JS on every pass.
       * @param {string} label
       * @returns {unknown[]}
       */
      distinct(label) {
        return prepared.metadata.distinct.all(label, label).map(row => row.value)
      }
    },

    setting: {

      /**
       * The only write path: called for each file/folder/target that
       * returns a `settings` object from readFile/readFolder/transformFile
       * (see applyReadResult.js) - a plugin never calls this (or anything
       * else in `queries.setting`) directly.
       *
       * One writer per (folder, label), last write wins. A row holds the
       * values that source wrote there as a JSON array - an array value
       * as-is, anything else as a one-element array - with `source` in
       * its own column. This replaced an accumulator that let several
       * sources share one row as a list of `{value, source}` entries:
       * that needed a full scan of every settings row on every call to
       * retract what a source no longer contributed, and its
       * retract-then-recompute ordering was wrong more than once
       * (folder-staling-bug.md). With one writer per row there is
       * nothing to accumulate, and "what did this source write" is one
       * indexed lookup on the `source` column.
       *
       * A label whose value is an empty array is not a contribution: it
       * is pruned like any label the source stopped returning.
       * @param {string} folder
       * @param {Record<string, any>} settings
       * @param {string} source
       */
      write(folder, settings, source) {
        const ancestors = folderAncestors(folder)
        // Snapshotted before any write, so "new to the ancestor chain"
        // reflects genuine history rather than what this call just did.
        const knownLabels = new Set(prepared.settings.getLabels.all(JSON.stringify(ancestors)).map(row => row.label))
        const written = new Set()

        for (const label in settings) {
          const value = settings[label]
          const values = Array.isArray(value) ? value : [value]
          if (!values.length) continue

          written.add(label)
          const json = JSON.stringify(values)
          const existing = prepared.settings.get.get(folder, label)

          // Only a real change stales. readFolders.js recomputes and
          // re-writes every pass regardless of whether anything relevant
          // changed, so without this every touch restaled every
          // dependent on every build.
          if (existing && existing.value === json && existing.source === source) continue

          if (existing && existing.source !== source) {
            log("warn", `setting "${label}" at folder "${folder}" written by "${source}" was previously written by "${existing.source}"; last write wins`)
          }

          prepared.settings.create.get(folder, label, json, source)
          staleFolderDependents(prepared, folder, label)

          // Nothing could have depended on a label that didn't exist to
          // read, so the first appearance anywhere in the chain is a
          // coarse subtree stale - the reason reads of a never-set label
          // don't need a forward dependency.
          if (!knownLabels.has(label)) {
            const recursivePath = [folder, "%"].filter(Boolean).join(path.sep)
            prepared.target.markStaleSubtree.run({ folder, recursivePath })
          }
        }

        // Unconditional, even when settings is {}: a source that stops
        // contributing a label - or anything at all - needs that
        // reflected now, not the next time it happens to contribute.
        const retired = prepared.settings.getBySource.all(source)
          .filter(row => !(row.target === folder && written.has(row.label)))
        retired.forEach(row => queries.setting.delete(row.target, row.label))
      },

      /**
       * Removes one row and stales whatever read it. Per (folder, label),
       * not per folder: a source that wrote several labels at a folder
       * shouldn't stale dependents of labels it didn't touch.
       * @param {string} folder
       * @param {string} label
       */
      delete(folder, label) {
        prepared.settings.delete.get(folder, label)
        staleFolderDependents(prepared, folder, label)
      },

      /**
       * Removes every settings row `source` wrote - a deleted source
       * file, or a folder pass that ran for a folder that no longer
       * exists. One indexed lookup, then a delete per row.
       * @param {string} source
       */
      deleteBySource(source) {
        prepared.settings.getBySource.all(source).forEach(row => queries.setting.delete(row.target, row.label))
      },

      getAll() {
        return prepared.settings.getAll.all()
      },

      /**
       * Every distinct value written for `label` at any folder - "which
       * themes are declared anywhere". Untracked; for enumerators.
       * @param {string} label
       * @returns {unknown[]}
       */
      distinct(label) {
        return prepared.settings.distinct.all(label).map(({ value, type }) => (
          type === "object" || type === "array" ? JSON.parse(value) : value
        ))
      },

      /**
       * A live, read-tracked view of this folder's settings cascade -
       * read-only, since a plugin only ever contributes settings via
       * readFile/readFolder/transformFile's return value (see
       * `write` above), never through this object. Reading a label
       * returns an array aligned to folderAncestors(folder) - index 0 is
       * the root, the last index is `folder` itself - where each slot is
       * the array of values written at that folder (a scalar setting is
       * a one-element array), or `null` where nothing was written. The
       * plugin decides how to resolve it through last()/flat()/raw()
       * below: the nearest folder's value for override semantics (e.g.
       * theme), every level for accumulate semantics (e.g. stylesheets),
       * or the sequence as-is (e.g. breadcrumbs).
       *
       * Reading a specific index registers a dependency on exactly that
       * ancestor's row for that label (type='folder', exact match) - the
       * read-side mirror of dependency.track()'s per-property getters,
       * scoped to "which folder" instead of "which target". Iterating
       * the whole array (for-of, .map(), spreading, ...) touches every
       * index the same way a manual loop would, so it tracks all of them.
       *
       * A real object with real `Object.defineProperty`-built accessor
       * properties, not a Proxy - one property per label that already
       * has a row somewhere in the ancestor chain (a plain `SELECT
       * DISTINCT label`, snapshotted once at call time), sealed with
       * `Object.preventExtensions` so a label with no row anywhere in
       * the chain has no property here at all (`settings.brandNewLabel`
       * is `undefined`) and any attempt to assign to this object throws,
       * rather than silently creating a local, unpersisted property -
       * there is no write path through this object at all now.
       * @param {string} folder
       * @param {string} [dependent]
       */
      getByFolder(folder, dependent) {
        const ancestors = folderAncestors(folder)
        const labels = prepared.settings.getLabels.all(JSON.stringify(ancestors)).map(row => row.label)

        const settings = {}

        // The resolutions a plugin actually wants, so they aren't
        // hand-rolled at every call site (which produced
        // `settings.fm_theme?.[""][0]` and a read of a label nothing
        // wrote). Each goes through the per-index getters below, so
        // tracking is unchanged: lastNonNull() reads leaf-upward and
        // stops at the first non-empty slot, registering dependencies on
        // exactly the levels that decided - the deciding one and every
        // empty level below it, since a value appearing there would
        // change the answer. last() reads only the leaf. firstNonNull()
        // reads root-downward. flat() reads every slot.
        //
        // `last` used to mean what lastNonNull means now. It was
        // ambiguous - "last defined" or "last, full stop"? - so both
        // exist and the bare word means the literal one. An unset label resolves to
        // undefined / [] rather than throwing: probing a label that may
        // not exist is the normal case for an optional setting, and the
        // recursive subtree stale on first appearance already covers
        // "configured later". Non-enumerable, so Object.keys, for-in and
        // JSON.stringify still show only labels.
        const resolvers = {
          /**
           * The folder's own slot, literally - the last index, whatever
           * it holds. `null` when the folder itself set nothing, even if
           * an ancestor did. For "did *this* folder say something".
           * @param {string} label
           */
          last(label) {
            const slots = settings[label]
            if (!slots) return undefined
            const own = slots.at(-1)
            if (!own || !own.length) return null
            return own.at(-1)
          },
          /**
           * Override semantics: the nearest folder's value, leaf-upward,
           * skipping levels that set nothing. `theme`, `title`. Tracks
           * exactly the levels that decided - the deciding one and every
           * empty level below it.
           * @param {string} label
           */
          lastNonNull(label) {
            const slots = settings[label]
            if (!slots) return undefined
            const indices = [...slots.keys()].reverse()
            const decided = indices.find(index => slots[index]?.length)
            if (decided === undefined) return undefined
            return slots[decided].at(-1)
          },
          /**
           * The root-most value: the first level, root downward, that set
           * anything. For a setting that is meant to be declared once at
           * the top and not overridden - a site-wide identity.
           * @param {string} label
           */
          firstNonNull(label) {
            const slots = settings[label]
            if (!slots) return undefined
            const decided = [...slots.keys()].find(index => slots[index]?.length)
            if (decided === undefined) return undefined
            return slots[decided][0]
          },
          /**
           * Accumulate semantics: every value at every level, root first.
           * @param {string} label
           */
          flat(label) {
            const slots = settings[label]
            if (!slots) return []
            return slots.flatMap(slot => slot ?? [])
          },
          /**
           * The ancestor array as-is, for sequence semantics.
           * @param {string} label
           */
          raw(label) {
            return settings[label]
          }
        }

        Object.defineProperties(settings, Object.fromEntries(
          Object.entries(resolvers).map(([name, value]) => [name, { value, enumerable: false }])
        ))

        labels.forEach(label => {
          if (label in resolvers) {
            throw new Error(`A setting cannot be labelled "${label}": it is a resolver on the settings view (${Object.keys(resolvers).join(", ")}).`)
          }

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
                    const row = prepared.settings.get.get(ancestorFolder, label)
                    return row ? JSON.parse(row.value) : null
                  }
                })
              })

              return values
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
        const canonicalPath = canonicalTargetPath(filePath)

        // Fetch all dependencies
        const deps = queries.dependency.getAllByTarget(canonicalPath)

        // Delete target, metadata, and dependencies
        const deleted = prepared.target.delete.get(canonicalPath)

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
        const target = prepared.target.get.get(canonicalTargetPath(filePath))

        if (!target) return

        return rowToTarget(target)
      },


      /**
       * @returns {TargetOutput[]}
       */
      getAll() {
        const targets = prepared.target.getAll.all()

        return targets.map(rowToTarget)
      },


      /**
       * @param {string} sourcePath
       * @returns {TargetOutput | undefined}
       */
      getBySource(sourcePath) {
        const target = prepared.target.getBySource.get(sourcePath)

        if (!target) return

        return rowToTarget(target)
      },

      /**
       * @returns {TargetOutput[]}
       */
      getStale() {
        const targets = prepared.target.getAllStale.all()

        return targets.map(rowToTarget)
      },

      /**
       * @param {string} filePath
       * @param {string} dependent
       * @param {"source" | "target"} [handle]
       */
      getWithTrackers(filePath, dependent, handle) {
        const target = handle === "source"
            ? queries.target.getBySource(filePath)
            : (!handle || handle === "target")
              ? queries.target.get(filePath)
              : null

        // A miss is tracked too, by target path: the hook learned the
        // target is *not* there, and if it appears the answer changes.
        // Only for a lookup by target path - a source path is not a key
        // the create side can stale on.
        if (!target) {
          if (dependent && handle !== "source") {
            prepared.dependency.create.get(canonicalTargetPath(filePath), "", dependent, "target")
          }
          return
        }

        const { metadata, data, ...rest } = target
        const trackedTarget = { ...rest, metadata: {} }

        // Edges are keyed by the stored path, never by what the caller
        // spelled: a source path (handle "source") or a "./"-prefixed
        // spelling matches no row, so staleDependents would never find
        // the edge and the dependent would never be rebuilt.
        const dependencyPath = target.path

        // Existence, eagerly: the hook learned the target is there even
        // if it reads nothing else, so deleting it must rebuild the
        // hook. Property "" is the membership convention folder and url
        // edges already use. (This replaced a three-argument track()
        // call that defined an enumerable property *named after the
        // path* on the returned target; JSON.stringify(target) hit its
        // getter and threw on the undefined binding.)
        prepared.dependency.create.get(dependencyPath, "", dependent, "target")

        queries.dependency.track(
          trackedTarget,
          "data",
          data,
          dependencyPath,
          dependent
        )

        for (const key in metadata) {
          queries.dependency.track(
            trackedTarget.metadata,
            key,
            metadata[key],
            dependencyPath,
            dependent
          )
        }

        return trackedTarget
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

        const recursivePath = [folder, "%"].filter(a => a).join(path.sep)

        // Ordering and limiting both happen here in JS, not in the SQL -
        // the bound parameters carry only what the query needs to scope
        // rows, nothing about how many or in what order.
        const scope = recursive ? recursivePath : folder

        // One path for every filter, empty or not: `{}` compiles to `(1)`.
        // The two scope placeholders come first in the SQL text.
        const { where, params: filterParams, labels } = compileFilter(query || {})
        const results = prepared.target
          .getManyWithFilters(where)
          .all(folder, scope, ...filterParams)

        if (dependent) {
          prepared.dependency.create.get(folder, "", dependent, recursive ? "folder_recursive" : "folder")

          // One edge per label the filter names, on top of the membership
          // edge above. The filter is evaluated in SQL, so the reader
          // never touches those properties in JS and the per-property
          // tracking below cannot see them - a target that stops matching
          // was returned last time but its filtered label was never read,
          // and one that starts matching was never returned at all.
          // target.create fires staleFolderDependents for every changed
          // metadata key, which is what these edges answer.
          //
          // Coarse by design: every listing filtering on `tags` under this
          // folder restales when any target's `tags` changes, whether or
          // not the change moved it across the filter. Exact enough that
          // nothing stays wrong, and refinable later if it ever costs
          // something. See
          // tasks/2-in-progress/filtered-listings-dont-track-their-filter.md.
          const type = recursive ? "folder_recursive" : "folder"
          labels.forEach(label => {
            prepared.dependency.create.get(folder, label, dependent, type)
          })
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
        const many = results.map(({ metadata, types, data, ...rest }) => {
          const parsedMetadata = coerceJSON(metadata)
          const trackedTarget = coerceRow({ metadata: {}, types: coerceJSON(types), data, ...rest })

          if (dependent) {
            queries.dependency.track(trackedTarget, "data", data, rest.path, dependent)
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
        const relativePath = canonicalTargetPath(target.path)

        // `{ $type, $value }` is a write syntax only. The value stored is
        // $value and the type rides beside it in declared_type; nothing
        // downstream ever sees the wrapper.
        const { values, types } = unwrapDeclaredTypes(target.metadata)

        const extant = queries.target.get(relativePath)
        const extantDeclared = extant ? prepared.metadata.getDeclared.all(relativePath) : []
        const declared = Object.fromEntries(extantDeclared.map(row => [row.label, row.declared_type]))

        if (!extant) {
          const created = prepared.target.create.get(
            relativePath,
            dir,
            ext,
            target.source || null,
            target.data ?? null,
            target.write === false ? 0 : 1
          )
          prepared.metadata.create.get(relativePath, JSON.stringify(values))
          for (const key in types) prepared.metadata.declare.get(types[key], relativePath, key)

          // Whoever asked for this path and was told "no" (the tracked
          // miss in getWithTrackers) has a different answer now.
          prepared.dependency
            .getByTargetAndProperty
            .all(relativePath, "")
            .forEach(dependency => {
              prepared.target.markStale.get(dependency.dependent)
            })

          staleFolderDependents(prepared, dir, "")
          return created
        }

        let changed = false

        for (const key in values) {
          // Deep compare, not `!==`: for an object or array value that is
          // reference inequality, so every object-valued key would look
          // changed on every read, rewrite its row and stale every
          // dependent. hastAbstract is object-valued on every markdown page.
          // A declaration counts: a consumer that read a `date` and now
          // reads a plain string has something to redo.
          const valueChanged = JSON.stringify(values[key]) !== JSON.stringify(extant.metadata[key])
          const typeChanged = (types[key] ?? null) !== (declared[key] ?? null)
          if (valueChanged || typeChanged) {
            changed = true

            // TODO use triggers to mark dependencies as stale
            prepared.metadata.create.get(relativePath, JSON.stringify({
              [key]: values[key]
            }))
            prepared.metadata.declare.get(types[key] ?? null, relativePath, key)

            // TODO delete dependencies after marking stale
            prepared.dependency
              .getByTargetAndProperty
              .all(relativePath, key)
              .forEach(dependency => {
                prepared.target.markStale.get(dependency.dependent)
              })

            // Folder dependents that *filtered* on this label. They never
            // read the property - the comparison was done in SQL - so the
            // per-target edges above cannot reach them. Property-exact and
            // ancestor-walking already, so this reuses the same machinery
            // the membership edge (property "") uses.
            staleFolderDependents(prepared, dir, key)
          }
        }

        for (const key in extant.metadata) {
          // A merge (transformFile) says nothing about keys it didn't
          // return; a read replaces the whole set.
          if (target.merge) break
          // `in`, not truthiness: a key whose new value is 0, false, ""
          // or null is still present and must not be deleted.
          if (!(key in values)) {
            changed = true
            prepared.metadata.delete.get(relativePath, key)

            // TODO delete dependencies after marking stale
            prepared.dependency
              .getByTargetAndProperty
              .all(relativePath, key)
              .forEach(dependency => {
                prepared.target.markStale.get(dependency.dependent)
              })

            // Same as the changed-key case above: a target that drops the
            // label a listing filters on has to restale that listing.
            staleFolderDependents(prepared, dir, key)
          }
        }

        // `data` is optional per-call: a caller that doesn't pass it isn't
        // saying "clear it," it's saying "not my concern this time."
        if (target.data !== undefined && target.data !== extant.data) {
          changed = true
          prepared.target.updateData.get(target.data, relativePath)

          prepared.dependency
            .getByTargetAndProperty
            .all(relativePath, "data")
            .forEach(dependency => {
              prepared.target.markStale.get(dependency.dependent)
            })
        }

        // Same optional-per-call semantics as `data`: a caller that omits
        // `source` is not saying "this target has no source", it is not
        // touching the question. When one *is* given and differs, it wins:
        // the row records who produces this target, and if a new source
        // has taken the path over, that has to be true in the row or
        // deleting the previous source would take the target with it.
        if (target.source && target.source !== extant.source) {
          prepared.target.updateSource.get(target.source, relativePath)
        }

        // Same optional-per-call semantics as data: a caller that omits
        // `write` isn't saying "reset to written," it's not touching the
        // question at all.
        if (target.write !== undefined) {
          const write = target.write === false ? 0 : 1
          if (write !== extant.write) {
            changed = true
            prepared.target.updateWrite.get(write, relativePath)

            prepared.dependency
              .getByTargetAndProperty
              .all(relativePath, "write")
              .forEach(dependency => {
                prepared.target.markStale.get(dependency.dependent)
              })
          }
        }

        if (changed) prepared.target.markStale.get(relativePath)

        return extant
      },

      /**
       * Stores what a writeFile produced, so a text target's `data` is its
       * rendered output after the write pass. Deliberately *not* routed
       * through target.create(): that sets `changed` and calls markStale on
       * the target itself, so the target would be stale again the moment it
       * was written and every build would rewrite every page forever.
       *
       * Dependents of the `data` property are still staled - someone who
       * read this target's data does need to know it changed.
       * @param {string} filePath
       * @param {string | null} data
       */
      setData(filePath, data) {
        const relativePath = canonicalTargetPath(filePath)
        const extant = prepared.target.get.get(relativePath)
        if (!extant || extant.data === data) return

        prepared.target.updateData.get(data, relativePath)
        prepared.dependency
          .getByTargetAndProperty
          .all(relativePath, "data")
          .forEach(dependency => {
            prepared.target.markStale.get(dependency.dependent)
          })
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
       * Records that `dependent` read (or asked for) `url`, so a later
       * arrival or refresh of the url's data stales it. type='url'
       * edges are how the write side learns a fetch landed.
       * @param {string} url
       * @param {string} dependent
       */
      track(url, dependent) {
        if (!dependent) return
        prepared.dependency.create.get(url, "", dependent, "url")
      },

      /**
       * Queues a fetch for `url`, attributed to `dependent`. Nothing is
       * fetched here: fetchURLs.js drains the queue when the build's
       * deferred work runs, after every hook that might ask has run -
       * including writeFile. In-memory and per process: a request made
       * and never run is made again when the hook that made it next
       * runs.
       *
       * Who parses the response is not the asker's business any more:
       * fetchURLs picks the `format: "url"` processor whose extensions
       * match the URL. Two dependents asking for one url share one fetch.
       * @param {string} url
       * @param {string} dependent
       */
      request(url, dependent) {
        queries.url.track(url, dependent)
        pendingURLs.add(url)
      },

      /**
       * Hands over everything requested since the last drain, and
       * forgets it.
       * @returns {{ url: string, processor: { readURL: Function } }[]}
       */
      takePending() {
        const pending = [...pendingURLs]
        pendingURLs.clear()
        return pending
      },

      get(url) {
        const row = prepared.url.get.get({ url })
        if (!row || !row.data) return
        return JSON.parse(row.data)
      },

      /**
       * Records what one URL file supplies - the only write path for a
       * url's data. readSources hands every file under config.urlStore
       * here, on a full pass and whenever one changes. The row is
       * attributed to the file, so deleting the file prunes it (see
       * deleteBySource), and a changed `data` stales the pages that
       * asked - through the url edges they already hold. An identical
       * entry touches nothing.
       * @param {{ url: string, data: unknown, redirect?: string, canonical?: string }} entry
       * @param {string} source - the file, relative to sourceFolder
       * @returns {boolean} whether anything changed
       */
      create(entry, source) {
        const data = JSON.stringify(entry.data ?? null)
        const row = prepared.url.get.get({ url: entry.url })
        const unchanged = row
          && row.url === entry.url
          && row.data === data
          && (row.redirect ?? null) === (entry.redirect ?? null)
          && (row.canonical ?? null) === (entry.canonical ?? null)
          && row.source === source

        if (unchanged) return false

        // Two files claiming one URL is the same situation as two sources
        // writing one settings label: last write wins, and it is said.
        if (row && row.source && row.source !== source) {
          log("warn", `${entry.url} is supplied by both ${row.source} and ${source}; using ${source}`)
        }

        prepared.url.create.get(entry.url, entry.redirect || null, entry.canonical || null, data, source)

        if (!row || row.data !== data) {
          prepared.dependency.getAllByTarget.all(entry.url)
            .filter(edge => edge.type === "url")
            .forEach(edge => prepared.target.markStale.get(edge.dependent))
        }
        return true
      },

      /**
       * Forgets every url a file supplied, staling the pages that asked
       * so the next build asks again. Called from source.delete.
       * @param {string} source
       * @returns {string[]} the urls forgotten
       */
      deleteBySource(source) {
        const rows = prepared.url.getBySource.all(source)
        rows.forEach(row => queries.url.delete(row.url))
        return rows.map(row => row.url)
      },

      /**
       * Forgets a url and stales every target that asked for it, so the
       * next build asks again.
       * @param {string} url
       */
      delete(url) {
        prepared.url.delete.get(url)
        prepared.dependency.getAllByTarget.all(url)
          .filter(edge => edge.type === "url")
          .forEach(edge => prepared.target.markStale.get(edge.dependent))
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
    -- forcing a full table scan of targets on every getMany call.
    PRAGMA case_sensitive_like = ON;

    -- stub: NULL for an ordinary file source. For a stub (a source a
    -- processor enumerates rather than one found on disk) it holds the
    -- canonical serialization of the stub's params - sorted keys, arrays
    -- left in order - which is what the diff compares, in the same role
    -- a file's mtime plays in lastModified. One column carries both the
    -- flag and the fingerprint, and "stub IS NOT NULL" is the test
    -- everything keys on. Deliberately not hashed: the canonical string
    -- has to be produced either way, so a digest is that work plus more,
    -- and the stored string says what the params were when you read the
    -- row. Deliberately not stored in lastModified, which has INTEGER
    -- affinity and would coerce it.
    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY,
      target TEXT,
      path STRING,
      lastModified INTEGER,
      stub TEXT
    );

    -- type: see SQLiteDependency's @property doc above.
    -- target/dependent: TEXT, not STRING - see the matching note on
    -- targets.path below. Both get compared/joined against targets.path
    -- directly (staleFolderDependents, markStale, the cleanup trigger),
    -- so they need the exact same affinity it has or those comparisons
    -- silently stop matching for a coerced value.
    CREATE TABLE IF NOT EXISTS dependencies (
      key INTEGER PRIMARY KEY,
      target TEXT NOT NULL,
      property STRING NOT NULL,
      dependent TEXT NOT NULL,
      type STRING NOT NULL DEFAULT 'target',
      UNIQUE(target, property, dependent)
    );

    -- path: TEXT, not STRING - "STRING" isn't an affinity keyword SQLite
    -- recognizes (it doesn't contain INT/CHAR/CLOB/TEXT/REAL/FLOA/DOUB),
    -- so a STRING-declared column actually gets NUMERIC affinity, not
    -- TEXT. That's desired for metadata.value (see the comment on that
    -- table) - numbers round-trip as real numbers - but is a footgun
    -- here: a target path that happens to look numeric ("0" - once the
    -- placeholder for a source with no router; today any page a router
    -- names that way) round-trips as the *integer* 0, not the string,
    -- the moment it's stored. Confirmed empirically: this crashed
    -- cleanupDatabase.js's path.join(), which requires a string.
    CREATE TABLE IF NOT EXISTS targets (
      key INTEGER PRIMARY KEY,
      path TEXT UNIQUE,
      dir TEXT,
      extension TEXT,
      stale INTEGER,
      source STRING,
      data STRING,
      write INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_targets_dir ON targets (dir);

    -- type, class, source: see SQLiteMetadata's @property docs above.
    -- target: TEXT, not STRING - see the note on targets.path. Joined
    -- against targets.path directly (target.get/getAll/getAllStale, the
    -- cleanup_target_rows trigger) and needs matching affinity.
    CREATE TABLE IF NOT EXISTS metadata (
      id INTEGER PRIMARY KEY,
      target TEXT,
      label STRING,
      value STRING,
      type STRING,
      declared_type STRING,
      class STRING NOT NULL DEFAULT 'target',
      source STRING NOT NULL DEFAULT '',
      UNIQUE(target, label)
    );

    -- redirect/canonical: the same fetched data is reachable by the
    -- originally-requested URL, the post-redirect URL, and the page's own
    -- declared canonical URL (if any) - one row, three possible lookup
    -- keys, rather than three duplicate rows.
    -- failedAt/failureCount: a failed fetch is cached too (data stays
    -- NULL), so a permanently-dead URL doesn't get re-fetched on every
    -- build - failureCount drives an exponential cooldown before retrying.
    -- A derived index of the URL files in the project (see urlStore.js
    -- and the url branch of readSources.js). "source" is the file that
    -- supplies a row; a row with data and no source cannot exist after a
    -- full pass. Failure state (failedAt, failureCount) is the one thing
    -- the files do not hold: it is per-machine.
    CREATE TABLE IF NOT EXISTS urls (
      url STRING PRIMARY KEY,
      redirect STRING,
      canonical STRING,
      data STRING,
      failedAt INTEGER,
      failureCount INTEGER NOT NULL DEFAULT 0,
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_urls_redirect ON urls (redirect);
    CREATE INDEX IF NOT EXISTS idx_urls_canonical ON urls (canonical);

    -- Cleans up a deleted target's own metadata/dependency rows. Not a
    -- declarative FOREIGN KEY: target is polymorphic (a target path
    -- for class/type='target', but a folder path or URL string for the
    -- others), and a FK constraint has no way to be conditional on that -
    -- it would reject every folder/url-type row as a violation. A trigger
    -- can check class/type in its WHERE clause; a bare FK can't.
    CREATE TRIGGER IF NOT EXISTS cleanup_target_rows AFTER DELETE ON targets BEGIN
      DELETE FROM metadata WHERE target = OLD.path AND class = 'target';
      DELETE FROM dependencies WHERE target = OLD.path AND type = 'target';
    END;

  `)

  ensureColumn(databaseSync, "urls", "redirect", "redirect STRING")
  ensureColumn(databaseSync, "urls", "canonical", "canonical STRING")
  ensureColumn(databaseSync, "urls", "failedAt", "failedAt INTEGER")
  ensureColumn(databaseSync, "urls", "failureCount", "failureCount INTEGER NOT NULL DEFAULT 0")

  ensureColumn(databaseSync, "sources", "stub", "stub TEXT")
  // Which URL file supplies a row, so deleting the file prunes it. NULL
  // for a failure-only row, which no file holds.
  ensureColumn(databaseSync, "urls", "source", "source TEXT")
  ensureColumn(databaseSync, "dependencies", "type", "type STRING NOT NULL DEFAULT 'target'")
  ensureColumn(databaseSync, "metadata", "class", "class STRING NOT NULL DEFAULT 'target'")
  ensureColumn(databaseSync, "metadata", "source", "source STRING NOT NULL DEFAULT ''")
  ensureColumn(databaseSync, "metadata", "declared_type", "declared_type STRING")
  // After the ensureColumn: an index on a column that might not exist yet
  // can't be created in the DDL block above.
  databaseSync.exec("CREATE INDEX IF NOT EXISTS idx_metadata_class_source ON metadata (class, source)")
  databaseSync.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)

  // `data` predates this ensureColumn call - added straight to the DDL
  // above when the column was introduced, but an existing on-disk
  // .votive.db from before that (CREATE TABLE IF NOT EXISTS is a no-op
  // once the table already exists) would never have picked it up.
  // Harmless no-op on a fresh database; fixes the gap for an old one.
  ensureColumn(databaseSync, "targets", "data", "data STRING")
  ensureColumn(databaseSync, "targets", "write", "write INTEGER NOT NULL DEFAULT 1")

  // targets.path/metadata.target/dependencies.target/dependencies.dependent/
  // sources.target changed from STRING to TEXT (see the comment on
  // targets.path above) - unlike a missing column, ensureColumn has no
  // equivalent for a type change: SQLite's declared type only takes
  // effect for rows inserted after it changes, and ALTER TABLE can't
  // retype an existing column. An on-disk .votive.db created before this
  // fix keeps coercing a numeric-looking path like "0" to an integer -
  // which is now what PRAGMA user_version (see loadDB) is for: an older
  // on-disk database is discarded rather than carried.
}

export { canonicalTargetPath }
export default createDatabase
