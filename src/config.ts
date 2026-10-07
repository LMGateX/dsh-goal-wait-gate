/**
 * Row configuration: the Schemastery schema the sidebar Plugins page renders,
 * plus the strict resolution this plugin applies before it mounts a strategy.
 *
 * The schema is a native Schemastery node (exported as `Config` from the
 * package entry), because DSH only generates a configuration form for rows
 * whose module publishes one. Its `strategy` union becomes the choice list on
 * the card; every field and every branch carries a bilingual description
 * because the generated form prints that text verbatim.
 */
import Schema from '@deepseek-ai/schemastery'

/** The four continuation strategies, in the order the configuration page lists them. */
export const strategies = ['activation', 'replacement', 'native', 'off'] as const

/** One continuation strategy. */
export type Strategy = (typeof strategies)[number]

/** Raw row configuration as the loader passes it in. Every field is optional. */
export interface RowConfig {
  /** Which implementation owns goal continuation. Defaults to `activation`. */
  readonly strategy?: Strategy
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: boolean
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: boolean
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: number
}

/** Validated row configuration with every default applied. */
export interface ResolvedRowConfig {
  readonly strategy: Strategy
  readonly waitForJobs: boolean
  readonly waitForSubagents: boolean
  readonly maxHoldMs: number
}

/** Gate policy on its own: the legacy root entry and the startup owner share it. */
export interface ResolvedConfig {
  readonly waitForJobs: boolean
  readonly waitForSubagents: boolean
  readonly maxHoldMs: number
}

/** Gate policy plus the `off` switch that withholds continuation unconditionally. */
export interface ResolvedGateConfig extends ResolvedConfig {
  /** When true, continuation is withheld regardless of observed background work. */
  readonly alwaysHold?: boolean
}

/** Gate-only configuration accepted by the legacy root entry and the startup owner. */
export interface GateInput {
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: boolean
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: boolean
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: number
}

/** The row schema the Plugins page renders. */
export const Config = Schema.object({
  strategy: Schema.union([
    Schema.const('activation').description(
      '默认。由本插件挂载宿主原生 goal-round-driver，并在旁边加上后台工作闸门（今天的行为）。' +
      ' Default: this plugin mounts the host native driver beside the disarm/resume gate.',
    ),
    Schema.const('replacement').description(
      '由本插件按宿主发布指纹移植的 TypeScript 驱动接管调度，按后台工作资格等待，不再靠 disarm。' +
      ' The ported driver owns scheduling and waits on background eligibility.',
    ),
    Schema.const('native').description(
      '只挂宿主原生驱动、不做任何干预，等价于 DSH 官方行为，是页面里的一键回退。' +
      ' The host driver alone, unchanged: official DSH behaviour and the in-page rollback.',
    ),
    Schema.const('off').description(
      '不挂载任何驱动，目标不再自动续行（闸门无条件持有）。关闭或卸载本插件即回到官方驱动。' +
      ' No driver is mounted, so no goal continues automatically.',
    ),
  ]).default('activation').description(
    '由哪种实现拥有目标续行（默认 activation）。Which implementation owns goal continuation.',
  ),
  waitForJobs: Schema.boolean().default(true).description(
    '会话仍有运行中/收尾中的作业时暂缓续行。Hold continuation while the session owns running or stopping jobs.',
  ),
  waitForSubagents: Schema.boolean().default(true).description(
    '会话仍有存活的子代理时暂缓续行。Hold continuation while the session owns live subagent descendants.',
  ),
  maxHoldMs: Schema.natural().default(0).description(
    '持有超过该毫秒数后放行一次（0＝无限期持有）。Release a hold after this many milliseconds; 0 holds indefinitely.',
  ),
})

/**
 * Validate raw row configuration and apply defaults.
 *
 * @param config - the raw config the loader passed to the plugin.
 * @returns the resolved row policy.
 * @throws Error naming the offending field, so a bad composition fails at load.
 */
export function resolveRowConfig(config: RowConfig = {}): ResolvedRowConfig {
  for (const key of Object.keys(config)) {
    if (!KNOWN_ROW_KEYS.has(key)) throw new Error(`goal-wait-gate: unknown configuration option "${key}"`)
  }
  return {
    strategy: optionalStrategy(config.strategy) ?? 'activation',
    waitForJobs: optionalBoolean('waitForJobs', config.waitForJobs) ?? true,
    waitForSubagents: optionalBoolean('waitForSubagents', config.waitForSubagents) ?? true,
    maxHoldMs: optionalDuration('maxHoldMs', config.maxHoldMs) ?? 0,
  }
}

/**
 * Validate the legacy gate-only configuration and apply defaults.
 *
 * @param config - the raw config the loader passed to the gate.
 * @returns the resolved policy.
 */
export function resolveConfig(config: GateInput): ResolvedConfig {
  return {
    waitForJobs: optionalBoolean('waitForJobs', config.waitForJobs) ?? true,
    waitForSubagents: optionalBoolean('waitForSubagents', config.waitForSubagents) ?? true,
    maxHoldMs: optionalDuration('maxHoldMs', config.maxHoldMs) ?? 0,
  }
}

/** Configuration keys the row accepts; anything else is a composition error. */
const KNOWN_ROW_KEYS = new Set(['strategy', 'waitForJobs', 'waitForSubagents', 'maxHoldMs'])

function optionalStrategy(value: unknown): Strategy | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(strategies as readonly string[]).includes(value)) {
    throw new Error(`goal-wait-gate: strategy must be one of ${strategies.join(', ')}`)
  }
  return value as Strategy
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
