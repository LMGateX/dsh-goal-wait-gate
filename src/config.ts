/** Gate policy. Every field is optional; defaults hold on every available signal. */
export interface Config {
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: boolean
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: boolean
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: number
}

/** Validated gate policy with every default applied. */
export interface ResolvedConfig {
  readonly waitForJobs: boolean
  readonly waitForSubagents: boolean
  readonly maxHoldMs: number
}

/**
 * Validate raw plugin configuration and apply defaults.
 *
 * @param config - the raw config the loader passed to the plugin.
 * @returns the resolved policy.
 * @throws Error naming the offending field, so a bad composition fails at load.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    waitForJobs: optionalBoolean('waitForJobs', config.waitForJobs) ?? true,
    waitForSubagents: optionalBoolean('waitForSubagents', config.waitForSubagents) ?? true,
    maxHoldMs: optionalDuration('maxHoldMs', config.maxHoldMs) ?? 0,
  }
}

function optionalBoolean(field: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`goal-wait-gate: ${field} must be a boolean`)
  return value
}

function optionalDuration(field: string, value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal-wait-gate: ${field} must be a non-negative whole number of milliseconds`)
  }
  return value
}
