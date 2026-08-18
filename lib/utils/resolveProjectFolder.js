import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Canonicalizes a project-folder input into an absolute, symlink-resolved
 * path - the one place a caller is allowed to reason about cwd, `~`, or a
 * relative path at all. Every votive/vowel entry point (the CLI, an
 * embedder like vowel-desktop, a future host) should call this once on
 * whatever string it received - a CLI arg, a native folder-picker result,
 * a config file value - then pass the *result* into bundle()/vowel();
 * nothing downstream re-resolves against cwd. See
 * tasks/desktop-app-architecture.md for the design this came out of.
 *
 * The realpath step matters beyond tidiness: a project folder reached
 * two different ways (a symlinked node_modules dependency, an iCloud
 * Drive/Dropbox folder using reparse points) would otherwise hash to two
 * different systemDirectoryFor() keys - two databases, two caches,
 * silently diverging content for what's actually one folder on disk.
 * @param {string} input
 * @param {{ base?: string }} [options] - `base` is what a relative
 *   `input` resolves against; defaults to `process.cwd()`, the only
 *   correct default for a CLI. An embedder with no meaningful cwd
 *   (vowel-desktop, a future iOS host) should always hand this an
 *   already-absolute `input` instead of relying on `base`.
 * @returns {string}
 */
function resolveProjectFolder(input, { base = process.cwd() } = {}) {
  const expanded = input === "~" || input.startsWith("~/")
    ? path.join(os.homedir(), input.slice(1))
    : input
  const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded)
  return fs.realpathSync(absolute)
}

export { resolveProjectFolder }
