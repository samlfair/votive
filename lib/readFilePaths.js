/** @import {VotiveConfig, FlatProcessors, Abstract, AbstractsWithSyntax, Jobs, FlatProcessor, Abstracts} from "./bundle.js" */
/** @import {Database} from "./createDatabase.js" */
/** @import {ReadSourceFileResult} from "./readSources.js"

/**
 * @typedef {object} ReadAbstractsResult
 * @property {Jobs} jobs
 * @property {ReadAbstractResult[]} abstracts
 */

/**
 * @typedef {object} ReadAbstractResult
 */

/**
 * @param {ReadSourceFileResult} abstracts
 * @param {VotiveConfig} config
 * @param {Database} database
 * @param {FlatProcessors} processors
 * @returns {{processedAbstracts: Abstracts, abstractsJobs: Jobs}}
 */
function readFilePaths(abstracts, config, database, processors) {

  const processed = abstracts.flatMap(({ abstract: unprocessedAbstract, syntax }) => {

    /**
     * @param {FlatProcessors} processors
     * @param {Abstract} abstract
     * @param {Jobs} jobs
     */
    function recursiveProcess(processors, abstract, jobs = []) {
      const [flatProcessor, ...rest] = processors
      if (!flatProcessor) return { abstract, jobs }
      const { processor, plugin } = flatProcessor
      if (processor.syntax !== syntax
        || !processor.read
        || !processor.read.abstract
      ) return recursiveProcess(rest, abstract, jobs)

      const processed = processor.read.abstract(abstract, database, config)
      processed.jobs && processed.jobs.forEach(job => job.syntax = processor.syntax)
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

export default readFilePaths