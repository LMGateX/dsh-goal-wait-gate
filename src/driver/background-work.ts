/** Conservative published-work observation; never consumes results or changes goal authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SubagentRunId, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { DriverPolicy } from './native-driver.ts'

export interface BackgroundConfig { waitForJobs?: boolean; waitForSubagents?: boolean }
/** Settings read at the moment of a decision, so a saved policy never remounts the driver. */
export type BackgroundConfigSource = BackgroundConfig | (() => BackgroundConfig)
export function createBackgroundPolicy(ctx: Context, source: BackgroundConfigSource = {}): DriverPolicy {
  const settings = (): BackgroundConfig => {
    const value = typeof source === 'function' ? source() : source
    return value ?? {}
  }
  const handoffs = new Map<Agent, number>()
  const epochs = new Map<SubagentRunId, readonly Agent[]>()
  let unavailable = false
  let closed = false
  const ancestors = (candidate: Agent): Agent[] => {
    const result: Agent[] = []
    const visited = new Set<Agent>()
    let child = candidate
    while (child.session.header.origin === 'subagent' && !visited.has(child)) {
      visited.add(child)
      const parentId = child.session.header.parentSession
      const parent = parentId === undefined ? undefined : ctx.agents.get(parentId)
      if (parent === undefined || !ctx.agents.isOwnedBy(child.id, parent)) break
      result.push(parent)
      child = parent
    }
    return result
  }
  const countsJob = (job: {kind: string}): boolean => settings().waitForJobs !== false || (settings().waitForSubagents !== false && job.kind === 'subagent')
  /**
   * Live children by parent session id.
   *
   * The old shape asked every live agent whether this one was in its ancestor
   * chain: O(A * depth) with a temporary Set and array per candidate, paid up to
   * three times per goal round. A direct child that is live and owned already
   * answers the question, because a chain with a dead hop never counted either.
   * The index is fed by the lifecycle events below and rebuilt when one is missed.
   */
  const children = new Map<string, Set<Agent>>()
  let indexed = false
  const indexAgent = (agent: Agent): void => {
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    const bucket = children.get(parentId)
    if (bucket === undefined) children.set(parentId, new Set([agent]))
    else bucket.add(agent)
  }
  const hasDescendant = (agent: Agent): boolean => {
    if (!indexed) {
      children.clear()
      for (const live of ctx.agents.list()) indexAgent(live)
      indexed = true
    }
    for (const child of children.get(agent.id) ?? []) {
      if (child.session.header.origin !== 'subagent') continue
      if (ctx.agents.get(child.id) !== child) continue
      if (ctx.agents.isOwnedBy(child.id, agent)) return true
    }
    return false
  }
  /**
   * Runs this realm cannot place on an owning agent, keyed by run id.
   *
   * The host calls subagent listeners with the run info alone, so an activation
   * started by an external provider may carry no resolvable parent. Holding by
   * run id until its end arrives is the fail-closed choice: the driver waits
   * instead of queueing a round while work this gate cannot see is in flight.
   */
  const unplaceable = new Set<string>()
  /** Resolve the owning parent from the emit argument, then from lineage. */
  const lineageParent = (scope: typeof ctx, childId: string, explicit: Agent | undefined): readonly Agent[] => {
    if (explicit !== undefined && scope.agents.get(explicit.id) === explicit) return [explicit]
    const sessions = (scope as unknown as { get: (name: string) => unknown }).get('sessions') as
      | { get?: (id: string) => { header?: { parentSession?: unknown } } | undefined }
      | undefined
    const parentId = sessions?.get?.(childId)?.header?.parentSession
    if (typeof parentId !== 'string') return []
    const resolved = scope.agents.get(parentId as Parameters<typeof scope.agents.get>[0])
    return resolved === undefined ? [] : [resolved]
  }
  return {
    allows(agent) {
      if (unavailable) throw new Error('Published background work cannot be observed safely')
      if (closed || handoffs.has(agent) || unplaceable.size > 0) return false
      if (ctx.jobs.list(agent.id).some(job => countsJob(job) && job.owner === agent.id && (job.status === 'running' || job.status === 'stopping'))) return false
      if (settings().waitForSubagents !== false && (hasDescendant(agent) || [...epochs.values()].some(chain => chain.includes(agent)))) return false
      return true
    },
    subscribe(wake) {
      const stops: (() => void)[] = []
      const notify = (agents: readonly Agent[]) => queueMicrotask(() => {
        if (closed) return
        for (const agent of new Set(agents)) if (ctx.agents.get(agent.id) === agent) wake(agent)
      })
      if (settings().waitForJobs !== false || settings().waitForSubagents !== false) stops.push(ctx.jobs.events.subscribe({owners: 'all'}, event => {
        if (closed || !('job' in event) || !countsJob(event.job) || event.job.owner === undefined || !['registered', 'settled', 'stopping', 'removed'].includes(event.type)) return
        const agent = ctx.agents.get(event.job.owner)
        if (agent === undefined) return
        if (event.type === 'settled') handoffs.set(agent, (handoffs.get(agent) ?? 0) + 1)
        queueMicrotask(() => {
          if (closed) return
          if (event.type === 'settled') {
            const count = (handoffs.get(agent) ?? 1) - 1
            if (count === 0) handoffs.delete(agent); else handoffs.set(agent, count)
          }
          if (ctx.agents.get(agent.id) === agent) wake(agent)
        })
      }))
      if (settings().waitForSubagents !== false) {
        /**
         * One activation started.
         *
         * The emit carries the owning parent as its second argument, and that is
         * the only lineage an external activation has: from 0.2.1-alpha.2 on, a run
         * started by an external provider owns no local Agent and is not an owned
         * Job either, so the child session cannot resolve a chain. The declared
         * listener signature has one parameter, hence the rest-args shape.
         */
        const onStart = (...args: unknown[]): void => {
          const info = args[0] as SubagentRunInfo
          const parent = args[1] as Agent | undefined
          if (closed) return
          const child = ctx.agents.get(info.id)
          const childChain = child === undefined ? [] : ancestors(child)
          const chain = childChain.length > 0 ? childChain : lineageParent(ctx, info.id, parent)
          if (chain.length === 0) {
            if (!unplaceable.has(info.runId)) {
              unplaceable.add(info.runId)
              // Fail closed, but never forever: an activation whose end never
              // arrives must not freeze goal continuation for the whole realm.
              const timer = setTimeout(() => {
                if (!unplaceable.delete(info.runId)) return
                ctx.logger.warn(`goal-wait-gate: unplaceable subagent run ${info.runId} never ended; releasing the hold`)
                notify(ctx.agents.list())
              }, 30 * 60 * 1000)
              timer.unref?.()
              notify(ctx.agents.list())
            }
            return
          }
          if (epochs.has(info.runId)) {
            unavailable = true; notify(ctx.agents.list()); return
          }
          epochs.set(info.runId, chain)
          notify(chain)
        }
        stops.push(ctx.on('subagent/start', onStart))
        stops.push(ctx.on('subagent/end', info => {
          unplaceable.delete(info.runId)
          const chain = epochs.get(info.runId)
          if (chain === undefined || closed) return
          epochs.delete(info.runId)
          notify(chain) // rc.2 continuable end follows disposal and the native notice attempt.
        }))
        stops.push(ctx.on('agent/created', ({ agent }): undefined => { indexAgent(agent) }))
        stops.push(ctx.on('agent/disposed', () => { indexed = false; notify(ctx.agents.list()) }))
      }
      return () => { closed = true; for (const stop of stops.toReversed()) stop(); epochs.clear(); handoffs.clear() }
    },
  }
}
