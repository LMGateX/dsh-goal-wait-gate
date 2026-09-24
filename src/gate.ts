/**
 * The gate's decision: hold continuation while the agent owns live background
 * work, release it once the work is consumed.
 *
 * Gating is expressed only through the goal service's process-local activation
 * seam (`disarm` when holding, `resume` when releasing). The durable phase is
 * never touched, and every official continuation mechanism stays in charge.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import type { ResolvedConfig } from './config.ts'
import { hasLiveJobs, hasLiveSubagents } from './live-work.ts'

/** The exact goal identity this gate disarmed and still owns. */
interface Hold {
  readonly goalId: string
  readonly revision: number
}

/** Gate one live agent's goal continuation. */
export class GoalWaitGate {
  readonly #ctx: Context
  readonly #config: ResolvedConfig
  readonly #holds = new Map<Agent, Hold>()
  readonly #yielded = new Map<Agent, string>()
  readonly #timers = new Map<Agent, ReturnType<typeof setTimeout>>()

  constructor(ctx: Context, config: ResolvedConfig) {
    this.#ctx = ctx
    this.#config = config
  }

  /**
   * Evaluate one exact live agent: hold continuation while it owns live work,
   * release a hold this gate owns once the work is gone.
   *
   * @param agent - the live agent whose goal should be evaluated.
   */
  evaluate(agent: Agent): void {
    try {
      const goal = this.#ctx.goals.get(agent)
      if (this.#hasLiveWork(agent)) {
        this.#hold(agent, goal)
        return
      }
      this.#release(agent, goal)
    } catch (error) {
      this.#ctx.logger.warn(
        `goal-wait-gate: evaluation failed for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Drop all bookkeeping for one agent that is no longer live. */
  forget(agent: Agent): void {
    this.#holds.delete(agent)
    this.#yielded.delete(agent)
    this.#clearExpiry(agent)
  }

  /**
   * Unload the gate: re-arm every goal this gate still holds, restoring the
   * official behavior instead of stranding a disarmed goal. Goals this gate
   * never disarmed are untouched. Failures are contained.
   */
  dispose(): void {
    for (const agent of this.#timers.keys()) this.#clearExpiry(agent)
    for (const [agent, hold] of [...this.#holds]) {
      try {
        const goal = this.#ctx.goals.get(agent)
        if (goal !== undefined && goal.id === hold.goalId && goal.phase === 'active' && goal.activation === 'disarmed') {
          this.#ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
        }
      } catch (error) {
        this.#ctx.logger.warn(
          `goal-wait-gate: could not re-arm agent "${agent.id}" on unload: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.#holds.delete(agent)
    }
    this.#yielded.clear()
  }

  /** Whether any configured signal reports live owned work. */
  #hasLiveWork(agent: Agent): boolean {
    if (this.#config.waitForJobs && hasLiveJobs(this.#ctx, agent)) return true
    if (this.#config.waitForSubagents && hasLiveSubagents(this.#ctx, agent)) return true
    return false
  }

  /** Arm this hold's escape hatch, when a maximum hold time is configured. */
  #scheduleExpiry(agent: Agent): void {
    this.#clearExpiry(agent)
    const { maxHoldMs } = this.#config
    if (maxHoldMs <= 0) return
    const timer = setTimeout(() => {
      this.#timers.delete(agent)
      this.#expire(agent, maxHoldMs)
    }, maxHoldMs)
    timer.unref()
    this.#timers.set(agent, timer)
  }

  /** Cancel the escape hatch for one agent. */
  #clearExpiry(agent: Agent): void {
    const timer = this.#timers.get(agent)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#timers.delete(agent)
  }

  /**
   * Release one hold that outlived the configured maximum, so a stuck job
   * cannot freeze the goal forever. Logs once per hold; a later wait gets its
   * own escape hatch.
   */
  #expire(agent: Agent, maxHoldMs: number): void {
    const hold = this.#holds.get(agent)
    if (hold === undefined) return
    try {
      const goal = this.#ctx.goals.get(agent)
      if (goal !== undefined && goal.id === hold.goalId && goal.phase === 'active' && goal.activation === 'disarmed') {
        this.#ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
        this.#ctx.logger.warn(
          `goal-wait-gate: hold expired after ${maxHoldMs}ms for agent "${agent.id}"; releasing continuation`,
        )
      }
    } catch (error) {
      this.#ctx.logger.warn(
        `goal-wait-gate: could not release expired hold for agent "${agent.id}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.#holds.delete(agent)
  }

  /** Disarm an armed goal and remember the exact revision this gate owns. */
  #hold(agent: Agent, goal: GoalView | undefined): void {
    if (this.#yielded.get(agent) !== undefined && this.#yielded.get(agent) !== goal?.id) this.#yielded.delete(agent)

    const hold = this.#holds.get(agent)
    if (hold !== undefined) {
      const sameGoal = goal !== undefined && goal.id === hold.goalId && goal.phase === 'active'
      if (!sameGoal) {
        // The held goal was replaced, cleared, or left active: the hold is stale.
        this.#holds.delete(agent)
        this.#yielded.delete(agent)
      } else if (goal.activation === 'armed') {
        // Something else re-armed the goal this gate held. The explicit
        // action wins: drop the hold and leave this wait ungated.
        this.#holds.delete(agent)
        this.#yielded.set(agent, goal.id)
        return
      }
    }

    if (goal !== undefined && this.#yielded.get(agent) === goal.id) return
    if (goal === undefined || goal.phase !== 'active' || goal.activation !== 'armed') return
    this.#ctx.goals.disarm(agent)
    this.#holds.set(agent, { goalId: goal.id, revision: goal.revision })
    this.#scheduleExpiry(agent)
  }

  /**
   * Re-arm the goal this gate holds once no live work remains.
   *
   * Only a hold this gate recorded is released, and only while the goal is
   * still the same identity, still active, and still disarmed. Resuming reads
   * the current revision so an official edit while held does not strand the
   * goal.
   */
  #release(agent: Agent, goal: GoalView | undefined): void {
    // The wait is over: the next live-work episode is gated from scratch.
    this.#yielded.delete(agent)
    this.#clearExpiry(agent)
    const hold = this.#holds.get(agent)
    if (hold === undefined) return
    if (goal === undefined || goal.id !== hold.goalId || goal.phase !== 'active' || goal.activation !== 'disarmed') {
      this.#holds.delete(agent)
      return
    }
    this.#ctx.goals.resume(agent, { id: goal.id, revision: goal.revision })
    this.#holds.delete(agent)
  }
}
