/** @import {VotiveConfig, FlatProcessors, Abstract, AbstractsWithSyntax, Jobs, FlatProcessor, Abstracts} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFilesResult} from "./readSources.js"

/**
 * @typedef {object} ReadAbstractsResult
 * @property {Jobs} jobs
 * @property {ReadAbstractResult[]} abstracts
 */

/**
 * @typedef {object} ReadAbstractResult
 */

/**
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
      const { processor, plugin } = flatProcessor
      if (!processor.extensions.includes(file.syntax)
        || !processor.transformFile
      ) return recursiveProcess(rest, abstract, jobs)

      // TODO don't pass the whole database to the plugin

      const settings = database.setting.getByFolder(file.dir)
      
      const processed = processor.transformFile(abstract, database, config)
      processed.jobs && processed.jobs.forEach(job => job.syntax = file.syntax)
      return recursiveProcess(rest, processed.abstract, [...jobs, ...(processed.jobs || [])])
    }

    return recursiveProcess(processors, unprocessedAbstract)
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