import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"

/**
 * The OS-appropriate root for per-application data (not votive-specific
 * yet - see systemDirectoryFor). Follows the XDG Base Directory spec on
 * Linux/other POSIX systems, and each platform's own convention
 * elsewhere - the same rough convention tools like npm/eslint follow
 * for their own caches.
 * @returns {string}
 */
function systemDataRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support")
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  }
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
}

/**
 * Computes a per-project system directory, so a Votive-based app (e.g.
 * Vowel) doesn't need to write `.votive.db`, a buffer cache, or its
 * build output into a project folder a non-developer end user might be
 * confused by. Keyed by a hash of the resolved `sourceFolder` path, so
 * two different Votive projects never collide without requiring a
 * manually-assigned project name.
 *
 * Purely a utility - calling this does not change anything about how
 * `bundle()` behaves. A caller (e.g. vowel's config.js) opts in
 * explicitly by using the returned path to set `config.databasePath`/
 * `config.cacheDirectory`/`config.targetFolder` itself; `bundle()`
 * and `readBuffers()` fall back to their original, project-relative
 * defaults when those aren't set, unchanged.
 * @param {string} sourceFolder
 * @returns {string}
 */
function systemDirectoryFor(sourceFolder) {
  const key = createHash("sha1").update(path.resolve(sourceFolder)).digest("hex").slice(0, 16)
  const root = systemDataRoot()
  return path.join(root, "votive", key)
}

export { systemDirectoryFor }
