/**
 * Applies a read-side hook's return value to the database.
 *
 * Every read-side hook - `readFile`, `readBuffer`, `readFolder`,
 * `transformFile` - returns the same optional shape, so there is one
 * function that knows what to do with it rather than four call sites
 * repeating `target.create` + `setting.accumulate` + url wrapping:
 *
 *   { data?, metadata?, settings?, urls?, targets?, write? }
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
 * @param {object} options.processor - the processor whose hook ran; its
 *   first extension tags the urls it produced
 * @returns {{ urls: object[] }} the urls the hook asked to be fetched,
 *   already tagged, for the caller to collect
 */
function applyReadResult(result, { database, targetPath, sourcePath, settingsFolder, processor }) {
  const { data, metadata, settings = {}, urls = [], targets = [], write } = result || {}

  // Unconditional, even for an empty contribution: accumulate() also
  // prunes labels this source no longer contributes, and skipping the
  // call when there is nothing to add is what let a removed setting
  // linger forever (see tasks/3-in-review/folder-staling-bug.md).
  database.setting.accumulate(settingsFolder, settings, sourcePath ?? settingsFolder)

  if (targetPath && (data !== undefined || metadata !== undefined || write !== undefined)) {
    database.target.create({
      path: targetPath,
      metadata,
      data,
      write,
      ...(sourcePath ? { source: sourcePath } : {})
    })
  }

  targets.forEach(target => database.target.create(target))

  // Votive never mutates the plugin's own object: each entry is wrapped in
  // its own record carrying the processor that asked for it, so fetchURLs
  // can match on that rather than on an `extension` written onto the
  // caller's data.
  return { urls: urls.map(task => ({ task, processor })) }
}

export default applyReadResult
