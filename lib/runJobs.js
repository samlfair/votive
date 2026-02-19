/** @import {Job, Jobs, Database, VotiveConfig} from "./bundle.js" */


/**
 * @param {Jobs} jobs
 * @param {VotiveConfig} config
 * @param {Database} database
 */
async function runJobs(jobs, config, database) {
  const processors = config.plugins.flatMap(plugin => plugin.processors.flatMap(processor => processor.read?.url && ({ fetcher: processor.read.url, syntax: processor.syntax }))).filter(a => a)
  const running = jobs.flatMap(async job => {
    if (!job) return
    const cachedURL = database.getURL(job.data)
    if (cachedURL) return
    const processing = processors.map(async processor => {
      if (processor.syntax === job.syntax) {
        try {
          const response = await fetch(job.data)
          // TODO: Change name of "job" to "url"
          // TODO: Change name of "runner" to "format"
          // TODO: Probably get rid of syntax filter
          if (response.status >= 200 && response.status < 300) {
            const data = await response[job.runner]()
            const processed = processor.fetcher(data)
            database.createURL(job.data, processed, job.destination)
            return
          } else {
            console.warn(`Error fetching URL: ${job.data}`)
          }
        } catch (e) {
          return
        }
      }
    })

    return Promise.allSettled(processing)
  })

  const settled = await Promise.allSettled(running)
  return settled
}

export default runJobs