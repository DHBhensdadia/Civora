/**
 * `@civora/worker` — scheduled work.
 *
 * Scope: the jobs that should not run inside a request handler — the nightly
 * forecast batch, alert evaluation over fresh readings, federation round
 * dispatch, and refresh of the interchange datasets.
 *
 * Each job is an ordinary function with its dependencies passed in, so a job
 * can be run from a test or a shell one-off as easily as from a schedule.
 *
 * Not implemented yet. Jobs arrive with the modules that produce their inputs.
 */
export {};
