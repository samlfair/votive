import workerpool from "workerpool"

/** @import {Job, Jobs, Database, VotiveConfig} from "./bundle.js" */

const pool = workerpool.pool()

/**
 * @param {Jobs} jobs
 * @param {VotiveConfig} config
 * @param {Database} database
 */
async function runJobs(jobs, config, database) {
  const running = jobs.map(async job => {
    if (!job) return
    const plugin = config.plugins.find(plugin => plugin.name === job.plugin)
    return pool.exec(plugin.runners[job.runner], [job.data])
  })

  const ran = await Promise.allSettled(running)
  pool.terminate()
}

export default runJobs