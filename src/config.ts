/**
 * Row configuration: the Schemastery schema the sidebar Plugins page renders,
 * plus the live resolution this plugin applies before it mounts a strategy.
 *
 * The schema is a native Schemastery node (exported as `Config` from the
 * package entry), because DSH only generates a configuration form for rows
 * whose module publishes one. Two host rules matter here:
 *
 * - The host's settings service builds a form only from VOLATILE fields
 *   (`volatileForm` in `@deepseek-ai/dsh-settings` returns undefined when no
 *   field carries `meta.volatile`), and `write` rejects any path that is not
 *   beneath one. Every field of this row is therefore volatile.
 * - Volatility means "applies live, without remounting": the loader hands
 *   volatile fields to `apply` as accessors (`{ get() }`), so a saved change is
 *   visible to the next read. {@link resolveRowConfig} reads through the
 *   accessor on every call, which is what lets a saved `strategy` swap the
 *   driver in place and a saved policy take effect at the next evaluation.
 *
 * The `strategy` union becomes the choice list on the card; every field and
 * every branch carries a bilingual description because the generated form
 * prints that text verbatim.
 */
import Schema from '@deepseek-ai/schemastery'

/** The four continuation strategies, in the order the configuration page lists them. */
export const strategies = ['activation', 'replacement', 'native', 'off'] as const

/** One continuation strategy. */
export type Strategy = (typeof strategies)[number]

/**
 * One configuration field as the loader may hand it over: a plain value, or a
 * volatile accessor whose `get()` returns the value saved most recently.
 */
export type Live<T> = T | { get(): T }

/** Raw row configuration as the loader passes it in. Every field is optional. */
export interface RowConfig {
  /** Which implementation owns goal continuation. Defaults to `activation`. */
  readonly strategy?: Live<Strategy>
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: Live<boolean>
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: Live<boolean>
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: Live<number>
}

/** Plain row configuration: what a test realm, the boot API or a hand-written composition passes. */
export interface RowConfigInput {
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
  readonly waitForJobs?: Live<boolean>
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: Live<boolean>
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: Live<number>
}

/**
 * Read one field, unwrapping the volatile accessor when the loader provided one.
 *
 * Booleans, strings and numbers are never volatile values themselves, so the
 * duck-typed check cannot misfire on this schema; it is deliberately not an
 * import of the host's `isVolatile` so the package keeps its dependency set.
 *
 * @param value - the raw field value or accessor.
 * @returns the current value, or undefined when the field was not configured.
 */
export function liveValue<T>(value: Live<T> | undefined): T | undefined {
  if (value === null || typeof value !== 'object') return value as T | undefined
  const read = Reflect.get(value, 'get')
  return typeof read === 'function' ? (read.call(value) as T) : (value as T)
}

/** Mark one schema node live: the host renders and writes only volatile fields. */
function liveFields<T extends Schema>(node: T): T {
  return node.volatile() as T
}

/**
 * The row schema the Plugins page renders; every field is live-applied.
 *
 * The volatile marker belongs on each field only: Cordis resolves a config
 * whose volatile node has a volatile ancestor as an error ("volatile fields
 * require a fixed object path without an enclosing volatile field"), so the
 * union branches stay plain and are covered by the volatile union above them.
 */
export const Config = Schema.object({
  strategy: liveFields(Schema.union([
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
    '由哪种实现拥有目标续行（默认 activation）。保存后立即切换驱动，无需重启。' +
    ' Which implementation owns goal continuation; a saved change switches the driver in place. Default: activation.',
  )),
  waitForJobs: liveFields(Schema.boolean().default(true).description(
    '会话仍有运行中/收尾中的作业时暂缓续行。保存后在下一次判定生效。' +
    ' Hold continuation while the session owns running or stopping jobs; applies from the next evaluation.',
  )),
  waitForSubagents: liveFields(Schema.boolean().default(true).description(
    '会话仍有存活的子代理时暂缓续行。保存后在下一次判定生效。' +
    ' Hold continuation while the session owns live subagent descendants; applies from the next evaluation.',
  )),
  maxHoldMs: liveFields(Schema.natural().default(0).description(
    '持有超过该毫秒数后放行一次（0＝无限期持有）。保存后在下一次持有时生效。' +
    ' Release a hold after this many milliseconds; 0 holds indefinitely. Applies from the next hold.',
  )),
})

/**
 * Validate raw row configuration, read every live field, and apply defaults.
 *
 * Called again on each checkpoint, so a saved volatile change is picked up
 * without remounting the row. Plain values are accepted unchanged, which is
 * what the boot API and the stand-in test realms pass.
 *
 * @param config - the raw config the loader passed to the plugin.
 * @returns the resolved row policy, as of this call.
 * @throws Error naming the offending field, so a bad composition fails at load.
 */
export function resolveRowConfig(config: RowConfig | RowConfigInput = {}): ResolvedRowConfig {
  for (const key of Object.keys(config)) {
    if (!KNOWN_ROW_KEYS.has(key)) throw new Error(`goal-wait-gate: unknown configuration option "${key}"`)
  }
  return {
    strategy: optionalStrategy(liveValue(config.strategy)) ?? 'activation',
    waitForJobs: optionalBoolean('waitForJobs', liveValue(config.waitForJobs)) ?? true,
    waitForSubagents: optionalBoolean('waitForSubagents', liveValue(config.waitForSubagents)) ?? true,
    maxHoldMs: optionalDuration('maxHoldMs', liveValue(config.maxHoldMs)) ?? 0,
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
    waitForJobs: optionalBoolean('waitForJobs', liveValue(config.waitForJobs)) ?? true,
    waitForSubagents: optionalBoolean('waitForSubagents', liveValue(config.waitForSubagents)) ?? true,
    maxHoldMs: optionalDuration('maxHoldMs', liveValue(config.maxHoldMs)) ?? 0,
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
