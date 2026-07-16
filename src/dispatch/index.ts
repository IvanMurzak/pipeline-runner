/**
 * Task dispatch (T2-05) — public surface.
 *
 *   task lease (`@task` sentinel + `task` payload) → normal checkout →
 *   `pipeline match` (reused deterministic BM25, via the exec seam) →
 *   resolved pipeline → the existing `JobExecutor` drive loop.
 *
 * Construction-time-lazy: importing this module starts nothing. The executor
 * defaults to `cliTaskPipelineResolver` over its own exec seam; inject a
 * custom `TaskPipelineResolver` through `JobExecutorOptions`/
 * `JobManagerOptions.resolveTaskPipeline` to replace it.
 */

export * from './matcher';
