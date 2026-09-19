/**
 * Applies a read-side hook's return value to the database.
 *
 * Every read-side hook - `readFile`, `readBuffer`,
 * `transformFile` - returns the same optional shape, so there is one
 * function that knows what to do with it rather than four call sites
 * repeating `target.create` + `setting.write`:
 *
 *   { data?, metadata?, settings?, targets?, write? }
 *
 * Every key is optional, and a hook may return `undefined` to mean
 * "nothing".
 *
 * `targets` are the source's **owned** targets beside its routed one -
 * an image's derivatives. Each is created with `source` set to this
 * source, which is what makes two things true with no further
 * machinery: at write, `target.buffer()` reads the owner's file (the
 * derivative resizes from it); and ownership decides retraction - a
 * read replaces the set it owns, so an owned target the read no longer
 * returns is deleted, row and file, and a deleted source takes every
 * target it owned with it (source.delete). A path another source owns
 * is a conflict and throws naming both, the same rule as two stubs.
 * A transform's merged result never touches the set.
 *
 * @param {object | undefined} result - the hook's return value
 * @param {object} options
 * @param {import("./createDatabase.js").default} options.database
 * @param {string} [options.targetPath] - the target this hook was called
 *   for, when there is one.
 * @param {string} [options.sourcePath] - the source file behind it, if any
 * @param {string} options.settingsFolder - the folder settings are scoped
 *   to, and the source key they are recorded under
 * @param {boolean} [options.merge] - a transform's partial result: keep
 *   the metadata keys it does not name, and the owned set as it is
 */
function applyReadResult(result, { database, targetPath, sourcePath, settingsFolder, merge = false }) {
  const { data, metadata, settings = {}, write, targets } = result || {}

  // Unconditional, even for an empty contribution: write() also prunes
  // labels this source no longer contributes, and skipping the call
  // when there is nothing to add is what let a removed setting linger
  // forever (see tasks/3-in-review/folder-staling-bug.md).
  database.setting.write(settingsFolder, settings, sourcePath ?? settingsFolder)

  if (targetPath && (data !== undefined || metadata !== undefined || write !== undefined)) {
    database.target.create({
      path: targetPath,
      metadata,
      merge,
      data,
      write,
      ...(sourcePath ? { source: sourcePath } : {})
    })
  }

  if (merge) return

  if (targets !== undefined && !Array.isArray(targets)) {
    throw new Error(`${sourcePath ?? targetPath}: a read hook's \`targets\` must be an array of { path, metadata?, data?, write? }.`)
  }
  if (targets?.length && !sourcePath) {
    throw new Error(`${targetPath}: only a read of a source can return owned \`targets\`; this hook has no source.`)
  }

  const owned = new Set(targetPath ? [database.target.get(targetPath)?.path ?? targetPath] : [])

  for (const entry of targets ?? []) {
    if (!entry || typeof entry.path !== "string" || !entry.path) {
      throw new Error(`${sourcePath}: every owned target needs a \`path\`.`)
    }
    const existing = database.target.get(entry.path)
    if (existing && existing.source && existing.source !== sourcePath) {
      throw new Error(`${sourcePath} returned the target "${entry.path}", which "${existing.source}" already produces. A target has one owner.`)
    }
    const created = database.target.create({
      path: entry.path,
      metadata: entry.metadata,
      data: entry.data,
      write: entry.write,
      source: sourcePath
    })
    owned.add(created?.path ?? entry.path)
  }

  // The read replaces the set it owns: what it no longer returns goes.
  if (sourcePath) {
    for (const path of database.target.ownedBy(sourcePath)) {
      if (!owned.has(path)) database.target.retract(path)
    }
  }
}

export default applyReadResult
