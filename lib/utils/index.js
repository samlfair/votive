import { styleText } from "node:util"
import { statSync } from "node:fs"
import path from "path"

/** @param {string} label */
export function stopwatch(label) {
  const start = performance.now()

  function stop() {
    const end = performance.now()
    const duration = end - start
    console.info(`${label}: ${styleText("red", duration.toFixed(2) + "ms")}`)
  }

  return stop
}

/**
 * @param {string} urlPath
 */
export function splitURL(urlPath) {
  const [urlFileName, ...urlDirSegmentsReversed] = urlPath.split("/").filter(a => a).reverse()
  const segments = urlDirSegmentsReversed.reverse()
  segments.push('')
  const folder = segments.join(path.sep)
  return folder
}

/** @param {string} dbPath */
export function checkFile(dbPath) {
  try {
    return statSync(path.normalize(dbPath))
  } catch (e) {
    return null
  }
}
