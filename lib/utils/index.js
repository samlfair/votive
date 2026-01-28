import { styleText } from "node:util"
import { statSync } from "node:fs"

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
  const [urlFileName, ...urlDirSegmentsReversed] = urlPath.split("/").reverse()
  return [urlDirSegmentsReversed.reverse().join("/") || "/", urlFileName]
}

/** @param {string} dbPath */
export function checkFile(dbPath) {
  try {
    return statSync(path.normalize(dbPath))
  } catch (e) {
    return null
  }
}
