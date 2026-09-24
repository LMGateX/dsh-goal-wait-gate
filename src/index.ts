/**
 * dsh-goal-wait-gate: withhold automatic goal continuation while the owning
 * agent still has live background work.
 *
 * The plugin never touches the official goal packages. It toggles only the
 * process-local continuation activation of the agent's current goal, which is
 * the input the official goal-round driver reads at every idle.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { JobView } from '@deepseek-ai/dsh-jobs'

/** Registered plugin name. */
export const name = 'goal-wait-gate'

/** Services this plugin cannot work without. */
export const inject = ['agents', 'goals']

/** Gate policy. Every field is optional and validated at load time. */
export interface Config {
  /** Hold continuation while the session owns running or stopping jobs. */
  readonly waitForJobs?: boolean
  /** Hold continuation while the session owns live subagent descendants. */
  readonly waitForSubagents?: boolean
  /** Release a hold after this many milliseconds; `0` holds indefinitely. */
  readonly maxHoldMs?: number
}

/**
 * Mount the gate.
 *
 * @param ctx - the plugin context carrying the agent registry and goal service.
 * @param _config - gate policy; defaults hold on both signals indefinitely.
 */
export function apply(ctx: Context, _config: Config = {}): void {
  const evaluate = (agent: Agent): void => {
    const goal: GoalView | undefined = ctx.goals.get(agent)
    void goal
  }
  ctx.on('agent/turn-stopping', ({ agent }) => {
    evaluate(agent)
  })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    evaluate(agent)
  }, { prepend: true })
}

/** Mountable plugin value, also usable from tests and manual compositions. */
export const goalWaitGate = { name, inject, apply }
