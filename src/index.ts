/**
 * dsh-goal-wait-gate: one row owns goal continuation.
 *
 * The shipped bundle layer disables the host's own `goal-round-driver` row, so
 * this plugin is the thing that mounts a driver, in every strategy except
 * `off`. The strategy and the background policy are the row configuration the
 * Plugins page renders from {@link RowConfigSchema}; a saved change remounts
 * this row, which switches the driver in place.
 *
 * @see ./config.ts for the schema, and ./mode.ts for the strategies.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import { Config, resolveRowConfig, type RowConfig } from './config.ts'
import { applyStrategy } from './mode.ts'

/** Registered plugin name. */
export const name = 'goal-wait-gate'

/** Services this plugin cannot work without. */
export const inject = ['agents', 'goals']

/** The Schemastery schema DSH renders on the plugin card. */
export { Config } from './config.ts'

export type { RowConfig } from './config.ts'

/**
 * Mount the configured continuation strategy.
 *
 * @param ctx - the plugin context carrying the agent registry and goal service.
 * @param config - row configuration; defaults live in the schema.
 */
export async function apply(ctx: Context, config: RowConfig = {}): Promise<void> {
  await applyStrategy(ctx, resolveRowConfig(config))
}

/** Mountable plugin value, also usable from tests and manual compositions. */
export const goalWaitGate = { name, inject, apply, Config }
