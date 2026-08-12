/**
 * Builds the SQL for `target.getMany`'s WHERE clause, evaluating an entire
 * filter tree natively in SQLite. The filter is bound as a single JSON
 * parameter (`:filter`) and walked with `json_tree` — for a given nesting
 * depth, the SQL text never varies with the shape of the filter, only with
 * how deep it goes (see `buildGetManySQL`'s `maxDepth` param and
 * `depthOfFilter`). Callers cache one prepared statement per depth actually
 * seen — at most MAX_FILTER_DEPTH + 1 of them, ever — rather than either
 * preparing fresh per query or paying for MAX_FILTER_DEPTH levels on every
 * call regardless of how shallow the filter actually is. The all-match case
 * (`{}`) skips this machinery entirely; see `buildGetManyEmptySQL`.
 *
 * Grammar (see votive/CLAUDE.md for the original spec):
 *   - A plain object ANDs all of its keys.
 *   - A bare scalar value is "=" (equals, or contains if the stored field
 *     is an array). A bare array value is "all" (stored field must be an
 *     array containing every listed element). A bare `null` means the
 *     property is absent or explicitly null.
 *   - An object keyed by an operator ("=", "!=", ">", "<", ">=", "<=",
 *     "in", "any", "all") applies that operator instead of recursing into
 *     a path.
 *   - "|" ORs an array of filters; "!" negates a single filter. Both
 *     inherit the field path of whatever they're nested under (so
 *     `{"author": {"|": [{"country": "Canada"}]}}` checks author.country,
 *     not a fresh top-level "country").
 *
 * Implementation notes:
 *   - Walking the tree (computing each node's field path/role/depth) is a
 *     genuine `WITH RECURSIVE` over `json_tree(:filter)`.
 *   - Combining AND/OR/NOT bottom-up is NOT done inside that recursion:
 *     SQLite rejects aggregate functions in a recursive term ("recursive
 *     aggregate queries not supported"), and GROUP BY/COUNT/SUM/MAX are
 *     exactly what's needed to fold a container's children into one
 *     boolean. Instead, evaluation is a fixed chain of ordinary
 *     (non-recursive) CTEs, one per nesting level from deepest to
 *     shallowest — each is free to aggregate over the CTE one level
 *     deeper. The chain's length is the filter's actual depth (see
 *     `depthOfFilter`), clamped to MAX_FILTER_DEPTH, so the SQL text is
 *     static for a given depth; a filter nested deeper than
 *     MAX_FILTER_DEPTH just has its excess levels silently ignored.
 *   - A top-level metadata value is stored raw (e.g. the bare text
 *     "published", not the JSON text '"published"'), since it comes
 *     straight out of json_each() at write time. Only nested values are
 *     guaranteed to still be valid JSON. json_extract() is only safe, and
 *     only used, past the root.
 *   - `json_type`/`json_each` throw on invalid JSON, and SQLite does not
 *     short-circuit AND around them, so array-ness has to be checked with
 *     nested CASE (whose branches genuinely aren't evaluated unless taken)
 *     rather than `json_valid(x) AND json_type(x) = 'array'`.
 */

const FILTER_KEYWORDS = "'|','!','=','!=','>','<','>=','<=','in','any','all'"
const COMPARISON_OPERATORS = [">", "<", ">=", "<="]

/*
  How deeply a filter can nest before extra levels are silently ignored.
  CLAUDE.md's own example (root -> author -> "|" -> branch -> "!" -> theme)
  is already 5 deep, so this leaves generous headroom for realistic filters
  while keeping the generated SQL a manageable, fixed size.
*/
const MAX_FILTER_DEPTH = 6

const fieldExpression = "CASE WHEN ft.rest_path = '' THEN m.value ELSE json_extract(m.value, '$.' || ft.rest_path) END"
const queryValues = "CASE WHEN ft.type = 'array' THEN ft.value ELSE json_array(ft.atom) END"

function overlapExists(negate) {
  const exists = `
    EXISTS (
      SELECT 1 FROM metadata m
      WHERE m.destination = d.path AND m.label = ft.label AND m.class = 'target'
        AND CASE WHEN json_valid(${fieldExpression})
          THEN CASE WHEN json_type(${fieldExpression}) = 'array'
            THEN EXISTS (SELECT 1 FROM json_each(${fieldExpression}) e WHERE e.value IN (SELECT value FROM json_each(${queryValues})))
            ELSE EXISTS (SELECT 1 FROM json_each(${queryValues}) q WHERE q.value = ${fieldExpression})
          END
          ELSE EXISTS (SELECT 1 FROM json_each(${queryValues}) q WHERE q.value = ${fieldExpression})
        END
    )`
  return negate ? `NOT ${exists}` : exists
}

const containsAllExists = `
  EXISTS (
    SELECT 1 FROM metadata m
    WHERE m.destination = d.path AND m.label = ft.label AND m.class = 'target'
      AND CASE WHEN json_valid(${fieldExpression})
        THEN CASE WHEN json_type(${fieldExpression}) = 'array'
          THEN (
            SELECT COUNT(*) FROM json_each(${queryValues}) q
            WHERE q.value IN (SELECT e.value FROM json_each(${fieldExpression}) e)
          ) = json_array_length(${queryValues})
          ELSE (SELECT COUNT(*) FROM json_each(${queryValues}) q WHERE q.value = ${fieldExpression}) = json_array_length(${queryValues})
        END
        ELSE (SELECT COUNT(*) FROM json_each(${queryValues}) q WHERE q.value = ${fieldExpression}) = json_array_length(${queryValues})
      END
  )`

const absentOrNull = `
  NOT EXISTS (
    SELECT 1 FROM metadata m
    WHERE m.destination = d.path AND m.label = ft.label AND m.class = 'target'
      AND (${fieldExpression}) IS NOT NULL
  )`

function comparison(operator) {
  return `
    EXISTS (
      SELECT 1 FROM metadata m
      WHERE m.destination = d.path AND m.label = ft.label AND m.class = 'target'
        AND ${fieldExpression} ${operator} ft.atom
    )`
}

const leafSatisfied = `
  CASE
    WHEN ft.role IS NULL AND ft.type = 'null' THEN CASE WHEN ${absentOrNull} THEN 1 ELSE 0 END
    ${COMPARISON_OPERATORS.map(op => `WHEN ft.role = '${op}' THEN CASE WHEN ${comparison(op)} THEN 1 ELSE 0 END`).join("\n    ")}
    WHEN ft.role = '!=' THEN CASE WHEN ${overlapExists(true)} THEN 1 ELSE 0 END
    WHEN ft.role = 'all' THEN CASE WHEN ${containsAllExists} THEN 1 ELSE 0 END
    WHEN ft.role IS NULL AND ft.type = 'array' THEN CASE WHEN ${containsAllExists} THEN 1 ELSE 0 END
    ELSE CASE WHEN ${overlapExists(false)} THEN 1 ELSE 0 END
  END
`

const containerAggregate = `
  CASE ft.role
    WHEN 'or'  THEN COALESCE(MAX(COALESCE(child_eval.satisfied, 0)), 0)
    WHEN 'not' THEN 1 - COALESCE(MAX(COALESCE(child_eval.satisfied, 0)), 0)
    ELSE CASE WHEN COUNT(child.id) = 0 THEN 1
         WHEN COUNT(child.id) = SUM(COALESCE(child_eval.satisfied, 0)) THEN 1 ELSE 0 END
  END
`

/**
 * @param {number} depth
 * @param {number} maxDepth
 */
function buildLevel(depth, maxDepth) {
  const isDeepest = depth === maxDepth

  const fromClause = isDeepest
    ? `FROM filter_tree ft CROSS JOIN scoped_destinations d`
    : `
      FROM filter_tree ft
      CROSS JOIN scoped_destinations d
      LEFT JOIN filter_tree child ON child.parent = ft.id
      LEFT JOIN level_${depth + 1} child_eval ON child_eval.node_id = child.id AND child_eval.destination = d.path`

  return `
    level_${depth} AS (
      SELECT
        d.path AS destination,
        ft.id AS node_id,
        CASE WHEN ft.is_container = 0 THEN (${leafSatisfied}) ELSE (${isDeepest ? "0" : containerAggregate}) END AS satisfied
      ${fromClause}
      WHERE ft.depth = ${depth}
      GROUP BY d.path, ft.id
    )`
}

/**
 * @param {number} maxDepth - the deepest a real filter needs to nest, per
 *   `depthOfFilter`. The CTE chain is exactly this long: shallow filters
 *   (the common case) get a cheap, short chain instead of paying for
 *   MAX_FILTER_DEPTH's worth of levels every time. Callers cache one
 *   prepared statement per maxDepth they've actually seen (bounded by
 *   MAX_FILTER_DEPTH + 1 possible values) rather than preparing fresh per
 *   query.
 */
function buildGetManySQL(maxDepth) {
  const levels = []
  for (let depth = maxDepth; depth >= 0; depth--) levels.push(buildLevel(depth, maxDepth))

  const statement = `
    WITH RECURSIVE filter_tree AS (
      SELECT id, parent, key, value, type, atom, NULL AS label, '' AS rest_path, NULL AS role, 0 AS depth,
        CASE WHEN type = 'object' OR (type = 'array' AND key = '|') THEN 1 ELSE 0 END AS is_container
      FROM json_tree(:filter)
      WHERE parent IS NULL

      UNION ALL

      SELECT
        jt.id, jt.parent, jt.key, jt.value, jt.type, jt.atom,
        CASE
          WHEN jt.key IN (${FILTER_KEYWORDS}) THEN ft.label
          WHEN typeof(jt.key) = 'integer' THEN ft.label
          WHEN ft.label IS NULL THEN jt.key
          ELSE ft.label
        END,
        CASE
          WHEN jt.key IN (${FILTER_KEYWORDS}) THEN ft.rest_path
          WHEN typeof(jt.key) = 'integer' THEN ft.rest_path
          WHEN ft.label IS NULL THEN ''
          ELSE ft.rest_path || CASE WHEN ft.rest_path = '' THEN '' ELSE '.' END || jt.key
        END,
        CASE
          WHEN jt.key = '|' THEN 'or'
          WHEN jt.key = '!' THEN 'not'
          WHEN jt.key IN ('=','!=','>','<','>=','<=','in','any','all') THEN jt.key
          ELSE NULL
        END,
        ft.depth + 1,
        CASE WHEN jt.type = 'object' OR (jt.type = 'array' AND jt.key = '|') THEN 1 ELSE 0 END
      FROM json_tree(:filter) jt
      JOIN filter_tree ft ON jt.parent = ft.id
    ),
    scoped_destinations AS MATERIALIZED (
      -- Every level below cross-joins this against filter_tree nodes, so
      -- folder scoping has to happen here, once, rather than in the final
      -- WHERE — otherwise every level evaluates every node against every
      -- destination in the whole database, not just the requested folder.
      -- Only path is selected: every level only ever needs that column,
      -- and pulling the rest (notably abstract, which can be a large
      -- JSON blob) would mean copying it through all ${maxDepth + 1} level scans for nothing.
      SELECT path FROM destinations WHERE dir = :folder OR dir LIKE :recursivePath
    ),
    ${levels.join(",\n")}
    SELECT dest.*, json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) ELSE i.value END) AS metadata
    FROM scoped_destinations d
    INNER JOIN destinations dest ON dest.path = d.path
    INNER JOIN metadata i ON dest.path = i.destination AND i.class = 'target'
    JOIN level_0 root ON root.destination = d.path AND root.node_id = 0 AND root.satisfied = 1
    GROUP BY dest.path
    ORDER BY dest.path ASC
  `

  return statement
}

/**
 * The no-filter case ("match everything in scope") never needs json_tree,
 * the recursive walk, or the level chain at all — it's just the scoped
 * destinations joined to their metadata. Worth a dedicated statement rather
 * than routing {} through buildGetManySQL(0), which would still pay for a
 * WITH RECURSIVE over json_tree('{}') and a level_0 CTE to conclude what
 * this says directly.
 */
function buildGetManyEmptySQL() {
  return `
    WITH scoped_destinations AS MATERIALIZED (
      SELECT path FROM destinations WHERE dir = :folder OR dir LIKE :recursivePath
    )
    SELECT dest.*, json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) ELSE i.value END) AS metadata
    FROM scoped_destinations d
    INNER JOIN destinations dest ON dest.path = d.path
    INNER JOIN metadata i ON dest.path = i.destination AND i.class = 'target'
    GROUP BY dest.path
    ORDER BY dest.path ASC
  `
}

/**
 * How deep a filter actually nests, in the same units as filter_tree's
 * `depth` column (root = 0, every object/array child is parent depth + 1).
 * Callers use this to pick which cached buildGetManySQL(maxDepth) statement
 * to run, so a shallow filter isn't paying for MAX_FILTER_DEPTH's worth of
 * unused levels.
 *
 * @param {unknown} node
 * @param {number} [depth]
 * @returns {number}
 */
function depthOfFilter(node, depth = 0) {
  if (node === null || typeof node !== "object") return depth
  let max = depth
  const values = Array.isArray(node) ? node : Object.values(node)
  for (const value of values) max = Math.max(max, depthOfFilter(value, depth + 1))
  return max
}

export default buildGetManySQL
export { MAX_FILTER_DEPTH, buildGetManyEmptySQL, depthOfFilter }
