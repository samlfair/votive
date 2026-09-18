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
 * - A bare scalar means equality with the stored value.
 * - A bare `null` means the property is absent or explicitly null.
 * - `~` means "contains": the stored value is an array with the given
 *   value as an element (`{tags: {"~": "AI"}}`). Given an array, every
 *   element must be present.
 * - A bare array is `~` with an array: the stored value must contain
 *   every listed element.
 * - `>`, `<`, `>=`, `<=` compare.
 * - `|` ORs its branches. `!` negates one filter. Both inherit the field
 *   path they are nested under. `|` accepts either an array of filters
 *   (`{"|": [{a: 1}, {b: 2}]}`) or an object whose entries are ORed
 *   (`{"|": {a: 1, b: 2}}`) - vowel's menu and sitemap filters use the
 *   object form.
 *
 * That is the whole language. `=`, `!=`, `in`, `any` and `all` were
 * operators once: `=` was the bare scalar, `!=` is `{"!": value}` (both
 * include targets where the field is missing), `all` was the bare array,
 * and `in`/`any` - "any of these" - is `{"|": [{x: 1}, {x: 2}]}`. Beyond
 * being redundant, a word like `in` or `all` as an operator collided with
 * any metadata label spelled the same way; `~` can't. The bare scalar
 * also used to fall back to "or contained in it, if the stored value is
 * an array"; that is `~` now, and equality means equality.
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

const OPERATORS = new Set([">", "<", ">=", "<=", "~"])
const COMPARISONS = new Set([">", "<", ">=", "<="])

// `f` is the stored field and `q` a JSON array of query values. Both are
// columns of a one-row derived table (see `leaf`), so each is evaluated once
// per target however many times it appears below.
const isArray = "CASE WHEN json_valid(f) THEN json_type(f) = 'array' ELSE 0 END"

// Equality. Through json_each rather than `f = ?` so a JS boolean or
// number compares the way the stored value was written (json_each gives
// 1/0 for true/false, which is how metadata stores them).
const equals = `f IN (SELECT value FROM json_each(q))`

// "~": the field is an array and every query value is an element of it.
const contains = `${isArray} AND (SELECT COUNT(*) FROM json_each(q)
  WHERE value IN (SELECT value FROM json_each(f))
) = json_array_length(q)`

/**
 * @param {string} operator
 * @param {unknown} value
 * @param {string} label - the metadata label
 * @param {string} rest - dotted JSON path below the label, "" at the root
 * @param {unknown[]} params
 * @param {Set<string>} labels - every metadata label the filter names,
 *   collected as the tree is walked. getByFolder registers a folder
 *   dependency per label so a listing is restaled when a target's value
 *   for one of them changes - the comparison happens in SQL, so the
 *   reader never touches the property and nothing else would track it.
 * @returns {string}
 */
function leaf(operator, value, label, rest, params, labels) {
  // `undefined` only when a filter names an operator with no field above
  // it, e.g. {"~": "x"} at the root. Nothing to depend on.
  if (label !== undefined) labels.add(label)
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
  if (operator === "~") return `EXISTS (SELECT 1 FROM ${row} WHERE ${contains})`
  return `EXISTS (SELECT 1 FROM ${row} WHERE ${equals})`
}

/**
 * @param {unknown} node
 * @param {string | undefined} label - undefined until a field key is seen
 * @param {string} rest
 * @param {unknown[]} params
 * @param {Set<string>} labels
 * @returns {string}
 */
function compile(node, label, rest, params, labels) {
  if (Array.isArray(node)) return leaf("~", node, label, rest, params, labels)
  if (node === null || typeof node !== "object") return leaf("=", node, label, rest, params, labels)

  const clauses = Object.entries(node).map(([key, value]) => {
    if (key === "|") {
      // An object under `|` ORs its entries; an array ORs its elements.
      const branches = Array.isArray(value)
        ? value
        : Object.entries(value).map(([field, condition]) => ({ [field]: condition }))
      return `(${branches.map(branch => compile(branch, label, rest, params, labels)).join(" OR ") || "0"})`
    }
    if (key === "!") return `NOT (${compile(value, label, rest, params, labels)})`
    if (OPERATORS.has(key)) return leaf(key, value, label, rest, params, labels)
    if (label === undefined) return compile(value, key, "", params, labels)
    return compile(value, label, rest ? `${rest}.${key}` : key, params, labels)
  })
  return `(${clauses.join(" AND ") || "1"})`
}

/**
 * `?` placeholders bind in the order they appear in the text, so every push
 * onto `params` happens in the same order its placeholder is written.
 * `labels` is every metadata label the filter names, at any depth and
 * through any operator. It is a function of the filter's *shape*, which
 * is also what the statement cache is keyed on, so it costs one walk of
 * a tree that is being walked anyway.
 * @param {object} filter
 * @returns {{ where: string, params: unknown[], labels: string[] }}
 */
function compileFilter(filter) {
  const params = []
  const labels = new Set()
  const where = compile(filter, undefined, "", params, labels)
  return { where, params, labels: [...labels] }
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
  // Two things measured on a 1,100-page site, both load-bearing:
  //
  // - Every target column except `data`. A listing copied every page's
  //   rendered html (30 MB) through the GROUP BY's temp tree: 286 ms
  //   per listing, 7 ms without it. Nothing lists pages to read their
  //   data eagerly; getByFolder hands it back as a lazy, tracked getter
  //   that fetches the one row on access.
  // - CROSS JOIN, which pins targets as the outer loop. Left to itself
  //   the planner started from metadata, scanning every row of it per
  //   listing and evaluating the filter afterwards - 8-30 ms for a
  //   filter that matches nothing. Targets first, the filter runs once
  //   per target with an indexed metadata lookup: 1.5-4 ms. The unary
  //   plus on i.class stops the planner choosing the class index for
  //   that inner lookup - which it did, scanning every metadata row
  //   per target (875 ms unfiltered) - so it uses the (target, label)
  //   index instead: 16 ms.
  return `
    SELECT targets.path, targets.dir, targets.extension, targets.source, targets.write, targets.stale,
      json_group_object(i.label, CASE WHEN i.type IN ('array', 'object') THEN json(i.value) WHEN i.type IN ('true', 'false') THEN json(i.type) ELSE i.value END) AS metadata,
      json_group_object(i.label, COALESCE(i.declared_type, i.type)) AS types
    FROM targets
    CROSS JOIN metadata i ON targets.path = i.target AND +i.class = 'target'
    WHERE (targets.dir = ? OR targets.dir LIKE ?) AND ${where}
    GROUP BY targets.path
  `
}

export default buildGetManySQL
export { compileFilter }
