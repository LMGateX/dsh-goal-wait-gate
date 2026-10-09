/**
 * dsh-goal-wait-gate: one row owns goal continuation.
 *
 * The shipped bundle layer disables the host's own `goal-round-driver` row, so
 * this plugin is the thing that mounts a driver, in every strategy except
 * `off`. The strategy and the background policy are the row configuration the
 * Plugins page renders from {@link Config}. Those fields are volatile, so a
 * saved change applies live: the driver is switched in place at the next
 * checkpoint and the policy is re-read at each evaluation, with no restart and
 * no remount of this row.
 *
 * @see ./config.ts for the schema, and ./mode.ts for the strategies.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-jobs'
import { Config, type RowConfigInput } from './config.ts'
import { applyStrategy } from './mode.ts'
import { publishLiveRow, registerStatusRoute } from './status-route.ts'

/** Registered plugin name. */
export const name = 'goal-wait-gate'

/** Services this plugin cannot work without. */
export const inject = ['agents', 'goals']

/** The Schemastery schema DSH renders on the plugin card. */
export { Config } from './config.ts'

export type { RowConfig, RowConfigInput } from './config.ts'

/**
 * Mount the configured continuation strategy.
 *
 * @param ctx - the plugin context carrying the agent registry and goal service.
 * @param config - row configuration; defaults live in the schema.
 */
export async function apply(ctx: Context, config: RowConfigInput = {}): Promise<void> {
  // Published first: the page can report which driver is live from the moment
  // this row loads, whatever the strategy mount goes on to do.
  registerStatusRoute(ctx)
  // The raw config is handed over, not a snapshot: volatile fields arrive as
  // live accessors, and the row re-reads them on every checkpoint.
  const row = await applyStrategy(ctx, config)
  // The page saves through a settings document, which does not re-resolve a
  // running row: publish the handle so the page can hand its own save back.
  publishLiveRow(row)
}

/** Mountable plugin value, also usable from tests and manual compositions. */
export const goalWaitGate = { name, inject, apply, Config }
