import path from "node:path"

/** @import {VotiveConfig, VotiveProcessor, VotivePlugin} from "./bundle.js" */

/**
 * Routing: where a source lands.
 *
 * Two routers, composed. `config.router` is the cascade: it rewrites a
 * source path before any processor sees it, for rewrites that are not a
 * processor's business - vowel hashes a secret path segment, and a
 * secret folder holds images and fonts as well as pages, so a rule
 * implemented per-processor leaks through whichever processor forgets
 * it. The processor's `router` then decides the target from the
 * rewritten path, or says there is none.
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
 * The folder a source's settings apply to. Derived from where the source
 * *lands*, so it agrees with the folder its neighbouring pages read
 * settings from (pageSettingsFolder is target-based). Before the cascade
 * existed the two were the same folder by construction; with it, a
 * settings.md under `blog/hidden§salt/` has to scope to `blog/<hash>/`.
 * dirname() of a root-level file is ".", which is not how the root
 * folder is spelled anywhere else - it is "".
 * @param {VotiveConfig} config
 * @param {string} sourcePath
 */
function settingsFolderFor(config, sourcePath) {
  return path.dirname(applyRouterCascade(config, sourcePath)).replace(/^\.$/, "")
}

/**
 * Wires the cascade and a processor's router into one function: source
 * path in, target path out, or null for a source that routes nowhere.
 *
 * Errors name the plugin and the path. A processor router that throws,
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

  return (sourcePath) => {
    // No router means no target, before the cascade is even consulted.
    if (!processor.router) return null

    const landing = applyRouterCascade(config, sourcePath)

    // `landing` is relative to sourceFolder, so an empty dir IS the root
    // (path.relative here would resolve against cwd, which is wrong).
    const { dir, ...parsed } = path.parse(landing)
    const pathInfo = {
      inRootDir: !dir,
      dir: ["", ...dir.split(path.sep).filter(Boolean)],
      ...parsed
    }

    let result
    try {
      result = processor.router(pathInfo)
    } catch (error) {
      throw new Error(`${name}'s router threw for "${sourcePath}": ${error.message}`, { cause: error })
    }

    // A router that said no (settings.md) has no target.
    if (!result) return null

    if (typeof result !== "object") {
      throw new Error(`${name}'s router must return a parsed path or nothing; for "${sourcePath}" it returned ${typeof result}.`)
    }

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
