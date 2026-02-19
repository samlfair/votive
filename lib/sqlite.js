// TODO: and, or, not, between, not in, order

const operators = {
  glob: "GLOB",
  like: "LIKE",
  in: "IN",
  gt: ">",
  lt: "<",
  gte: ">=",
  lte: "<=",
  equal: "=",
  notEqual: "!-"
}

const select = `SELECT * FROM destinations d`
const join = `LEFT JOIN metadata m ON d.path = m.destination`

/**
 * @typedef {Condition[]} Filter
 */

/**
 * @typedef {object} Condition
 * @property {string} property
 * @property {keyof operators} operator
 * @property {string | number | array} value 
 */

/**
 * @typedef {object} Query
 * @property {number} [query.limit]
 * @property {number} [query.offset]
 * @property {string} [query.orderBy]
 * @property {Filter} [query.filter]
 */

/**
 * @param {Query} query
 */
export default function createStatement(query) {
  const segments = [select, join]
  if(query.limit) segments.push(`LIMIT ${query.limit}`)
  if(query.offset) segments.push(`OFFSET ${query.offset}`)
  if(query.orderBy) segments.push(`ORDER BY ${query.orderBy}`)
  if(query.filter) {
    const conditions = query.filter.map(condition => {
      const { property, operator, value } = condition
      
      if(["dir", "abstract", "path"].includes(property)) {
        
      return `d.${property} ${operators[operator]} ${formatValue(value)}`
      }
      return `m.label = '${property}' AND m.value ${operators[operator]} ${formatValue(value)}`
    })

    segments.push(`WHERE ${conditions.join(" AND ")}`)
  }

  return segments.join(`\n`)
}

function formatProperty(property) {
  if(property === "abstract") return `d.${property}`
  else return `m.${property}`
}

/** @param {any} value */
function formatValue(value) {
  if(Array.isArray(value)) {
    return `(${value.map(x => `'${x}'`).join(', ')})`
  }

  if(typeof value === "number") return value

  return `'${value}'`
}
