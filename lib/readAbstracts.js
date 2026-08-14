/** @import {VotiveConfig, FlatProcessors, Abstract, Jobs, FlatProcessor, Abstracts} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFilesResult} from "./readSources.js" */

/**
 * @typedef {object} ReadAbstractsResult
 * @property {Jobs} jobs
 * @property {ReadAbstractResult[]} abstracts
 */

/**
 * @typedef {object} ReadAbstractResult
 */

/**
 * Runs every matching processor's `transformFile` hook over each file's
 * abstract, threading the result through in sequence - multiple
 * transformer processors registered for the same extension all apply,
 * each seeing the previous one's output. The final abstract is written
 * back to the file's target (via `target.create`'s existing selective-
 * update/staling logic), so a transformer processor has a real effect on
 * what gets written, not just on which jobs get queued.
 * @param {ReadSourceFilesResult} files
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {{processedAbstracts: Abstracts, abstractsJobs: Jobs}}
 */
function readAbstracts(files, config, database, processors) {

  const processed = files.flatMap(file => {

    const { abstract: unprocessedAbstract } = file

    /**
     * @param {FlatProcessors} processors
     * @param {Abstract} abstract
     * @param {Jobs} jobs
     */
    function recursiveProcess(processors, abstract, jobs = []) {
      const [flatProcessor, ...rest] = processors
      if (!flatProcessor) return { abstract, jobs }
      const { processor } = flatProcessor
      if (!processor.extensions.includes(file.extension)
        || !processor.transformFile
      ) return recursiveProcess(rest, abstract, jobs)

      const processed = processor.transformFile(abstract, database, config, file.targetFilePath)
      processed.jobs && processed.jobs.forEach(job => job.extension = file.extension)
      return recursiveProcess(rest, processed.abstract, [...jobs, ...(processed.jobs || [])])
    }

    const { abstract, jobs } = recursiveProcess(processors, unprocessedAbstract)

    // Only a transformer that actually ran changes this reference (the
    // no-match base case passes the original abstract straight through),
    // so this cheaply skips a write for files nothing transformed.
    if (file.targetFilePath && abstract !== unprocessedAbstract) {
      database.target.create({ path: file.targetFilePath, abstract })
    }

    return { abstract, jobs }
  })

  const processedAbstracts = []
  const abstractsJobs = []

  processed.forEach(({ abstract, jobs }) => {
    processedAbstracts.push(abstract)
    abstractsJobs.push(...jobs)
  })

  return { processedAbstracts, abstractsJobs }
}

export default readAbstracts