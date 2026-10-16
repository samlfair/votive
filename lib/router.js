import path from "node:path"
import { splitURL } from "./utils/index.js"

/** @import {VotiveConfig, VotiveProcessor, VotivePlugin} from "./bundle.js" */

/**
 * Routing: where a source lands.
 *
 * Three routers, chained. `config.router` is the cascade: it rewrites a
 * source path before any plugin sees it, for rewrites that are not a
 * plugin's business - vowel hashes a secret path segment, and a secret
 * folder holds images and fonts as well as pages, so a rule implemented
 * per-plugin leaks through whichever plugin forgets it. A plugin's
 * `router` then runs on everything its processors read, and a
 * processor's `router` receives what the plugin's returned and works on
 * that processor's sources alone. Either can be left out; either can say
 * there is no target.
 *
 * The cascade rewrites where things *land*, nothing else. The source
 * keeps its real path everywhere it is stored, diffed or looked up. Two
 * things are derived from the rewritten path rather than the real one,
 * because both are about where the output lives: the target path, and
 * the folder a source's settings apply to - a settings.md in a secret
 * folder scopes to the hashed folder its pages land in, not to the name
 * the author typed (see settingsFolderFor).
 */

/**
 * The cascade alone: `config.router` applied to a source path, with its
 * return checked. Nothing returned leaves the path as it was.
 * @param {VotiveConfig} config
 * @param {string} sourcePath - relative to sourceFolder
 * @returns {string} relative to sourceFolder
 */
function applyRouterCascade(config, sourcePath) {
  if (!config || typeof config.router !== "function") return sourcePath

  const rewritten = config.router(sourcePath)
  if (rewritten === undefined || rewritten === null) return sourcePath

  if (typeof rewritten !== "string") {
    throw new Error(`config.router must return a path or nothing; for "${sourcePath}" it returned ${typeof rewritten}.`)
  }
  return rewritten
}

/**
 * The folder a source's settings apply to: **the folder its target is
 * in**. Settings are read by target folder (pageSettingsFolder), so they
 * are written by target folder, and the two cannot disagree.
 *
 * The source path only enters when there is no target to ask - a
 * settings.md routes nowhere on purpose - and then the answer is where
 * the source *would* land: the cascade's rewrite of its own folder,
 * which for a secret settings.md is the hashed folder its pages are in.
 * dirname() of a root-level file is ".", which is not how the root
 * folder is spelled anywhere else - it is "".
 * @param {VotiveConfig} config
 * @param {string} sourcePath
 * @param {string | null} [targetPath] - where the source landed, if it did
 */
function settingsFolderFor(config, sourcePath, targetPath) {
  if (targetPath) return splitURL(targetPath)
  return path.dirname(applyRouterCascade(config, sourcePath)).replace(/^\.$/, "")
}

/**
 * A router's result as the next router receives it: `dir` as the array
 * the first router was given (`["", "blog"]`), whichever spelling the
 * router returned, so a processor router sees one shape whether or not
 * its plugin routed first.
 * @param {Record<string, any>} result
 */
function asPathInfo(result) {
  const dir = Array.isArray(result.dir)
    ? result.dir
    : ["", ...String(result.dir ?? "").split(/[\\/]/).filter(Boolean)]
  return { ...result, dir, inRootDir: dir.filter(Boolean).length === 0 }
}

/**
 * Wires the cascade, the plugin's router and the processor's router into
 * one function: source path in, target path out, or null for a source
 * that routes nowhere. With no router on either, there is no target.
 *
 * Errors name the plugin, the router and the path. A router that throws,
 * or returns something that is neither falsy nor a parsed-path object,
 * used to surface as a stack trace from path.format; a plugin author
 * gets told which router and which file.
 * @param {VotiveConfig} config
 * @param {VotiveProcessor} processor
 * @param {VotivePlugin} [plugin] - for the error message
 * @returns {(sourcePath: string) => string | null}
 */
function buildRouter(config, processor, plugin) {
  const name = plugin?.name ? `"${plugin.name}"` : "a processor"

  // The plugin's first, then the processor's, which receives the
  // plugin's result.
  const routers = [
    ...(typeof plugin?.router === "function" ? [{ route: plugin.router, which: `${name}'s plugin router` }] : []),
    ...(typeof processor.router === "function" ? [{ route: processor.router, which: `${name}'s router` }] : [])
  ]

  return (sourcePath) => {
    // No router means no target, before the cascade is even consulted.
    if (!routers.length) return null

    const landing = applyRouterCascade(config, sourcePath)

    // `landing` is relative to sourceFolder, so an empty dir IS the root
    // (path.relative here would resolve against cwd, which is wrong).
    const { dir, ...parsed } = path.parse(landing)
    const pathInfo = {
      inRootDir: !dir,
      dir: ["", ...dir.split(path.sep).filter(Boolean)],
      ...parsed
    }

    const result = routers.reduce((current, { route, which }) => {
      // A router that said no (settings.md) has no target, and the next
      // router isn't asked.
      if (!current) return current
      let next
      try {
        next = route(current)
      } catch (error) {
        throw new Error(`${which} threw for "${sourcePath}": ${error.message}`, { cause: error })
      }
      if (!next) return null
      if (typeof next !== "object") {
        throw new Error(`${which} must return a parsed path or nothing; for "${sourcePath}" it returned ${typeof next}.`)
      }
      return asPathInfo(next)
    }, /** @type {Record<string, any> | null} */ (pathInfo))

    if (!result) return null

    return path.normalize(path.format({
      dir: Array.isArray(result.dir) ? path.join(...result.dir) : (result.dir || ""),
      root: result.root || "",
      base: result.base,
      name: result.name,
      ext: result.ext
    }))
  }
}

export { buildRouter, applyRouterCascade, settingsFolderFor }
