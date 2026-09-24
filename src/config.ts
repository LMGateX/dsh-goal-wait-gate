/** Gate policy. Every field is optional; defaults hold on every available signal. */
export interface Config {
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: boolean
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: boolean
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: number
}
