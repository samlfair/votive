/**
 * Applies a read-side hook's return value to the database.
 *
 * Every read-side hook - `readFile`, `readBuffer`,
 * `transformFile` - returns the same optional shape, so there is one
 * function that knows what to do with it rather than four call sites
 * repeating `target.create` + `setting.write` + url wrapping:
 *
 *   { data?, metadata?, settings?, targets?, write? }
 *
 * Every key is optional, and a hook may return `undefined` to mean
 * "nothing".
 *
 * @param {object | undefined} result - the hook's return value
 * @param {object} options
 * @param {import("./createDatabase.js").default} options.database
 * @param {string} [options.targetPath] - the target this hook was called
 *   for, when there is one. Omitted by readFolder, which has no single
 *   target of its own.
 * @param {string} [options.sourcePath] - the source file behind it, if any
 * @param {string} options.settingsFolder - the folder settings are scoped
 *   to, and the source key they are recorded under
 */
function applyReadResult(result, { database, targetPath, sourcePath, settingsFolder }) {
  const { data, metadata, settings = {}, write, targets } = result || {}

  if (targets !== undefined) {
    throw new Error("A read hook returned `targets`, which no longer exists. A target has exactly one source: declare extra targets as stubs (createStubs/expandStubs).")
  }

  // Unconditional, even for an empty contribution: write() also prunes
  // labels this source no longer contributes, and skipping the call
  // when there is nothing to add is what let a removed setting linger
  // forever (see tasks/3-in-review/folder-staling-bug.md).
  database.setting.write(settingsFolder, settings, sourcePath ?? settingsFolder)

  if (targetPath && (data !== undefined || metadata !== undefined || write !== undefined)) {
    database.target.create({
      path: targetPath,
      metadata,
      data,
      write,
      ...(sourcePath ? { source: sourcePath } : {})
    })
  }

}

export default applyReadResult
