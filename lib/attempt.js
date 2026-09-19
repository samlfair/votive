/** @import {VotiveConfig} from "./bundle.js" */

/**
 * How votive handles errors, in one place.
 *
 * **A build never dies for one file.** Every call into a plugin hook
 * that concerns one source or one target - the router, `readFile`,
 * `transformFile`, `expandStubs`, the read of an expanded stub,
 * `readBuffer`, `writeFile` - and the filesystem read of that source
 * runs inside `attempt()`. A throw becomes one `config.log("error", …)`
 * line naming the hook, the plugin and the file, with the original
 * error's message (its stack too, when `verbose`), and the result is
 * `undefined`: the caller treats it as "nothing came back" and moves
 * on to the next file. What that means per stage:
 *
 * - **A source whose router or read throws is skipped this pass.** Its
 *   row is not stamped, so the next pass that stats it tries again -
 *   a fix to the file is picked up like any edit. Its previous target,
 *   if any, is left as it was.
 * - **A transform that throws leaves the target as read.**
 * - **A stub whose expansion or read throws is skipped this pass** and
 *   tried again next pass, since its params never reach its row.
 * - **A write that throws leaves the target stale**, so the next pass
 *   tries again, and it is excluded from the pass's rewrite rounds.
 * - **A URL fetch that fails is a recorded failure** with its own
 *   cooldown (fetchURLs.js), not an error line per pass.
 *
 * A plugin's *deliberate* refusal takes the same path: a router that
 * throws for a filename it cannot route is logged and the file
 * ignored, which is what "coerce if possible, ignore if not" means
 * for a name nothing can coerce.
 *
 * **What is not caught**, because it is not about one file:
 * `createStubs` (an enumerator over the database; a throw there is a
 * plugin bug, and a caught one would read as "no stubs declared" and
 * delete every stub), a throw inside votive's own stages, and the
 * database. Those take the pass down with a rollback, as a bug should.
 * The dev server's watchers log their own `error` events (serve.js)
 * rather than letting an unhandled emitter end the process.
 *
 * **Bad values are the plugin's to coerce, not votive's to reject**,
 * with one exception votive owns: a `{ $type, $value }` declaration
 * whose `$type` is not a lowercase name is logged and stored as the
 * plain object it is (createDatabase.js, unwrapDeclaredTypes).
 *
 * @template T
 * @param {VotiveConfig} config
 * @param {string} what - "readFile (vowel-markdown) for \"blog/a.md\""
 * @param {() => T | Promise<T>} run
 * @returns {Promise<T | undefined>}
 */
async function attempt(config, what, run) {
  try {
    return await run()
  } catch (error) {
    reportFailure(config, what, error)
    return undefined
  }
}

/**
 * The one error line. For a synchronous stage (transformTargets) that
 * cannot await attempt() and does its own try/catch.
 * @param {VotiveConfig} config
 * @param {string} what
 * @param {unknown} error
 */
function reportFailure(config, what, error) {
  const detail = error instanceof Error ? error.message : String(error)
  const stack = config.verbose && error instanceof Error && error.stack ? `\n${error.stack}` : ""
  config.log?.("error", `${what} failed: ${detail}${stack}`)
}

export default attempt
export { reportFailure }
