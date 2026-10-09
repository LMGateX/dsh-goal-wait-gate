/**
 * Live work owned by one session: the background the agent started and has not
 * finished consuming. Only live work holds goal continuation; durable records
 * of settled work must not.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'

/**
 * Live subagent-origin agents by declared parent session id, one per realm.
 *
 * The gate evaluates every checkpoint — twice per turn and agent — so
 * rebuilding this map from the whole registry on each call paid Theta(A^2)
 * allocations to answer a question about one chain. The index is seeded from
 * the registry the first time a realm asks and then maintained by the
 * lifecycle events the host already emits. A disposal drops the seed, because
 * a removed node can sit anywhere in any chain and re-seeding from the live
 * registry is always exact.
 */
interface DescendantIndex {
  readonly children: Map<string, Set<Agent>>
  seeded: boolean
}

const indexes = new WeakMap<Context, DescendantIndex>()

/** The index for one realm, subscribing to the lifecycle the first time it is asked. */
function indexFor(ctx: Context): DescendantIndex {
  const existing = indexes.get(ctx)
  if (existing !== undefined) return existing
  const index: DescendantIndex = { children: new Map(), seeded: false }
  indexes.set(ctx, index)
  ctx.on('agent/created', ({ agent }): undefined => { indexChild(index, agent) })
  // A disposal is the one change a set of live children cannot absorb: the
  // disposed agent may be any node of any chain, so the index is rebuilt.
  ctx.on('agent/disposed', () => { index.seeded = false })
  return index
}

/** Add one live subagent descendant under the session its header names. */
function indexChild(index: DescendantIndex, agent: Agent): void {
  const { parentSession, origin } = agent.session.header
  if (parentSession === undefined || origin !== 'subagent') return
  const bucket = index.children.get(parentSession)
  if (bucket === undefined) index.children.set(parentSession, new Set([agent]))
  else bucket.add(agent)
}

/**
 * Whether the session owns any live subagent descendant at any depth.
 *
 * Liveness is the live agent registry, not the durable child catalog: a
 * settled child is no longer registered, and a child that merely exists as a
 * session record must not hold continuation. Only sessions whose header names
 * a parent and carries the subagent origin are descendants; a fork shares the
 * lineage field without that origin and is an independent conversation.
 *
 * Every registered descendant counts, including one between turns. The
 * official archive-admission walk traverses the same lineage but collects only
 * `status === "running"` children, because a session may be archived once its
 * idle children are cancelled. For this gate the unit is the live activation
 * epoch, not the child's current turn: a resident child has not settled, so
 * its settlement notice has not reached the parent, and releasing early would
 * let the official driver inject a round before that notice is consumed.
 */
export function hasLiveSubagents(ctx: Context, agent: Agent): boolean {
  const index = indexFor(ctx)
  if (!index.seeded) {
    index.children.clear()
    for (const live of ctx.agents.list()) indexChild(index, live)
    index.seeded = true
  }

  const visited = new Set<string>()
  const pending = [String(agent.session.id)]
  while (pending.length > 0) {
    const parentId = pending.pop()
    if (parentId === undefined) continue
    for (const child of index.children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      // An entry survives its agent until the disposal event invalidates the
      // index; never count one the live registry no longer knows.
      if (ctx.agents.get(child.id) !== child) continue
      visited.add(child.id)
      pending.push(String(child.session.id))
    }
  }
  return visited.size > 0
}

/** Whether the session owns a background job that has not settled. */
export function hasLiveJobs(ctx: Context, agent: Agent): boolean {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return false
  return jobs
    .list(agent.session.id)
    .some((job) => job.owner === agent.session.id && (job.status === 'running' || job.status === 'stopping'))
}
