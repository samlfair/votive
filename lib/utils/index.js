import { styleText } from "node:util"
import { statSync } from "node:fs"
import path from "path"

/**
 * @param {string} label
 * @param {string} message
 * @param {boolean} verbose
 */
export function stopwatch(label, message, verbose) {
  const start = performance.now()

  function stop() {
    const end = performance.now()
    const duration = end - start
    if(verbose) console.info(`${styleText("dim", label + ":")} ${styleText("magenta", message)} ${styleText("magenta", duration.toFixed(2) + "ms")}`)
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
  const folder = path.relative("", segments.join(path.sep))
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
