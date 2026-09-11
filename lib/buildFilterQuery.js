/**
 * Compiles a `target.getByFolder({query})` filter tree into one SQL boolean
 * expression over `targets.path`, with every value bound as a positional
 * parameter.
 *
 * ## The grammar
 *
 * - A plain object ANDs all of its keys. `{}` matches everything.
 * - A key that is not an operator is a field name. At the top level it names
 *   a metadata `label`; nested deeper it extends a JSON path inside that
 *   label's value (`{author: {country: "Canada"}}` reads
 *   `json_extract(value, '$.country')` on the `author` row).
 * - A bare scalar means `=`: equal to the stored value, or contained in it
 *   if the stored value is an array.
 * - A bare array means `all`: the stored value must be an array containing
 *   every listed element.
 * - A bare `null` means the property is absent or explicitly null.
 * - An object keyed by an operator applies it: `=`, `!=`, `>`, `<`, `>=`,
 *   `<=`, `in`, `any`, `all`. `in` and `any` are the same: overlap between
 *   the query list and the stored value (or equality if the stored value is
 *   a scalar). `!=` is the negation of overlap and **includes targets where
 *   the field is missing**.
 * - `|` ORs its branches. `!` negates one filter. Both inherit the field
 *   path they are nested under. `|` accepts either an array of filters
 *   (`{"|": [{a: 1}, {b: 2}]}`) or an object whose entries are ORed
 *   (`{"|": {a: 1, b: 2}}`) - the previous `json_tree` implementation
 *   treated a node's children as the operands either way, and vowel's menu
 *   and sitemap filters both use the object form.
 *
 * `{x: {"=": [1, 2]}}` behaves as `any`, which is what the previous
 * implementation did too.
 *
 * ## Two storage facts the SQL relies on
 *
 * - `metadata` is `UNIQUE(target, label)`, so a (target, label) lookup
 *   returns at most one row. Every "does a matching row exist" question is
 *   really a scalar lookup.
 * - A top-level value is stored raw (the text `published`, not the JSON
 *   `"published"`); arrays and objects are stored as JSON text. So
 *   `json_extract` is only safe *below* the root, and array-ness must be
 *   checked with `CASE WHEN json_valid(x) THEN json_type(x) = 'array'`
 *   rather than `json_valid(x) AND json_type(x) = 'array'`: `json_type`
 *   throws on invalid JSON and SQLite does not short-circuit `AND` around
 *   it.
 */

const OPERATORS = new Set(["=", "!=", ">", "<", ">=", "<=", "in", "any", "all"])
const COMPARISONS = new Set([">", "<", ">=", "<="])

// `f` is the stored field and `q` a JSON array of query values. Both are
// columns of a one-row derived table (see `leaf`), so each is evaluated once
// per target however many times it appears below.
const isArray = "CASE WHEN json_valid(f) THEN json_type(f) = 'array' ELSE 0 END"

// "=", "in", "any": some query value equals the field, or is an element of
// it when the field is an array.
const overlap = `CASE WHEN ${isArray}
  THEN EXISTS (SELECT 1 FROM json_each(f) e WHERE e.value IN (SELECT value FROM json_each(q)))
  ELSE f IN (SELECT value FROM json_each(q)) END`

// "all": every query value is an element of the field. A scalar field is
// treated as a one-element array, so `all: ["x"]` matches a scalar "x".
const containsAll = `(SELECT COUNT(*) FROM json_each(q)
  WHERE value IN (SELECT value FROM json_each(CASE WHEN ${isArray} THEN f ELSE json_array(f) END))
) = json_array_length(q)`

/**
 * @param {string} operator
 * @param {unknown} value
 * @param {string} label - the metadata label
 * @param {string} rest - dotted JSON path below the label, "" at the root
 * @param {unknown[]} params
 * @returns {string}
 */
function leaf(operator, value, label, rest, params) {
  // Root values are stored raw, so json_extract is only used below the root.
  const field = rest ? "json_extract(m.value, ?)" : "m.value"
  if (rest) params.push("$." + rest)
  params.push(label)
  const stored = `(SELECT ${field} FROM metadata m WHERE m.target = targets.path AND m.label = ? AND m.class = 'target')`

  // No row, or a row holding JSON null, both read back as NULL.
  if (value === null && operator === "=") return `${stored} IS NULL`

  if (COMPARISONS.has(operator)) {
    params.push(value)
    return `${stored} ${operator} ?`
  }

  params.push(JSON.stringify(Array.isArray(value) ? value : [value]))
  const row = `(SELECT ${stored} AS f, json(?) AS q)`
  if (operator === "all") return `EXISTS (SELECT 1 FROM ${row} WHERE ${containsAll})`
  // NOT EXISTS, not `NOT overlap`: a missing field must satisfy "!=".
  if (operator === "!=") return `NOT EXISTS (SELECT 1 FROM ${row} WHERE ${overlap})`
  return `EXISTS (SELECT 1 FROM ${row} WHERE ${overlap})`
}

/**
 * @param {unknown} node
 * @param {string | undefined} label - undefined until a field key is seen
 * @param {string} rest
 * @param {unknown[]} params
 * @returns {string}
 */
function compile(node, label, rest, params) {
  if (Array.isArray(node)) return leaf("all", node, label, rest, params)
  if (node === null || typeof node !== "object") return leaf("=", node, label, rest, params)

  const clauses = Object.entries(node).map(([key, value]) => {
    if (key === "|") {
      // An object under `|` ORs its entries; an array ORs its elements.
      const branches = Array.isArray(value)
        ? value
        : Object.entries(value).map(([field, condition]) => ({ [field]: condition }))
      return `(${branches.map(branch => compile(branch, label, rest, params)).join(" OR ") || "0"})`
    }
    if (key === "!") return `NOT (${compile(value, label, rest, params)})`
    if (OPERATORS.has(key)) return leaf(key, value, label, rest, params)
    if (label === undefined) return compile(value, key, "", params)
    return compile(value, label, rest ? `${rest}.${key}` : key, params)
  })
  return `(${clauses.join(" AND ") || "1"})`
}

/**
 * `?` placeholders bind in the order they appear in the text, so every push
 * onto `params` happens in the same order its placeholder is written.
 * @param {object} filter
 * @returns {{ where: string, params: unknown[] }}
 */
function compileFilter(filter) {
  const params = []
  const where = compile(filter, undefined, "", params)
  return { where, params }
}

/**
 * The two scope placeholders come first in the text, so callers bind
 * `[folder, recursivePath, ...params]`.
 *
 * The `json(i.value)` coercion for arrays and objects is load-bearing:
 * `json_group_object` treats a TEXT column as an opaque string otherwise,
 * and an array-valued property comes back as its JSON source text rather
 * than an array. `tests/metadataTypes.js` covers it.
 * @param {string} where - from compileFilter
 * @returns {string}
 */
function buildGetManySQL(where) {
  return `
    SELECT targets.*, json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) WHEN i.type IN ('true', 'false') THEN json(i.type) ELSE i.value END) AS metadata
    FROM targets
    INNER JOIN metadata i ON targets.path = i.target AND i.class = 'target'
    WHERE (targets.dir = ? OR targets.dir LIKE ?) AND ${where}
    GROUP BY targets.path
  `
}

export default buildGetManySQL
export { compileFilter }
