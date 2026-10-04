/** Conservative published-work observation; never consumes results or changes goal authority. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { DriverPolicy } from './native-driver.ts'

export interface BackgroundConfig { waitForJobs?: boolean; waitForSubagents?: boolean }
export function createBackgroundPolicy(ctx: Context, config: BackgroundConfig = {}): DriverPolicy {
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
  const countsJob = (job: {kind: string}): boolean => config.waitForJobs !== false || (config.waitForSubagents !== false && job.kind === 'subagent')
  const hasDescendant = (agent: Agent): boolean => ctx.agents.list().some(child => ancestors(child).includes(agent))
  return {
    allows(agent) {
      if (unavailable) throw new Error('Published background work cannot be observed safely')
      if (closed || handoffs.has(agent)) return false
      if (ctx.jobs.list(agent.id).some(job => countsJob(job) && job.owner === agent.id && (job.status === 'running' || job.status === 'stopping'))) return false
      if (config.waitForSubagents !== false && (hasDescendant(agent) || [...epochs.values()].some(chain => chain.includes(agent)))) return false
      return true
    },
    subscribe(wake) {
      const stops: (() => void)[] = []
      const notify = (agents: readonly Agent[]) => queueMicrotask(() => {
        if (closed) return
        for (const agent of new Set(agents)) if (ctx.agents.get(agent.id) === agent) wake(agent)
      })
      if (config.waitForJobs !== false || config.waitForSubagents !== false) stops.push(ctx.jobs.events.subscribe({owners: 'all'}, event => {
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
      if (config.waitForSubagents !== false) {
        stops.push(ctx.on('subagent/start', info => {
          if (closed || !info.local) return // Nonlocal runs are supported only through standard owned Jobs.
          const child = ctx.agents.get(info.id)
          const chain = child === undefined ? [] : ancestors(child)
          if (child === undefined || chain.length === 0 || epochs.has(info.runId)) {
            unavailable = true; notify(ctx.agents.list()); return
          }
          epochs.set(info.runId, chain)
          notify(chain)
        }))
        stops.push(ctx.on('subagent/end', info => {
          const chain = epochs.get(info.runId)
          if (chain === undefined || closed) return
          epochs.delete(info.runId)
          notify(chain) // rc.2 continuable end follows disposal and the native notice attempt.
        }))
        stops.push(ctx.on('agent/disposed', () => notify(ctx.agents.list())))
      }
      return () => { closed = true; for (const stop of stops.toReversed()) stop(); epochs.clear(); handoffs.clear() }
    },
  }
}
