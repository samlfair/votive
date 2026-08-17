import createPluginAPI from "./pluginAPI.js"

/** @import {ReadPluginAPI} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */

/**
 * Stands in for the real ReadPluginAPI while readFile()/readBuffer() is
 * running - a read hook's final target isn't settled until it returns
 * (it can override its own routed path via a returned `filePath`), so
 * every api.* call it makes here is queued instead of executed.
 * dispatchAccumulatedCalls() below replays them for real once the final
 * path is known. This is unconditionally correct (not an approximation)
 * because ReadPluginAPI only exposes write actions - see its doc
 * comment in bundle.js.
 * @returns {{ api: ReadPluginAPI, calls: { method: string, args: any[] }[] }}
 */
function createAccumulatorAPI() {
  const calls = []

  /**
   * @param {string} method
   * @param {any[]} args
   */
  function record(method, args) {
    calls.push({ method, args })
  }

  return {
    api: {
      createTarget(target) {
        record("createTarget", [target])
      },
      url: {
        create(url, data, options) {
          record("url.create", [url, data, options])
        }
      }
    },
    calls
  }
}

/**
 * Replays every call an accumulator API (see createAccumulatorAPI)
 * recorded, for real, against the real PluginAPI - built fresh here so
 * url.create()'s dependent-linking attributes to `dependent`, the
 * source's actual final target path, not whatever routed path was
 * known before read() decided its own override.
 * @param {Database} database
 * @param {string} dependent
 * @param {{ method: string, args: any[] }[]} calls
 */
function dispatchAccumulatedCalls(database, dependent, calls) {
  const api = createPluginAPI(database, dependent)

  for (const { method, args } of calls) {
    if (method === "createTarget") api.createTarget(...args)
    else if (method === "url.create") api.url.create(...args)
  }
}

export { createAccumulatorAPI, dispatchAccumulatedCalls }
