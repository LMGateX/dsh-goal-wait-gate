/**
 * Live work owned by one session: the background the agent started and has not
 * finished consuming. Only live work holds goal continuation; durable records
 * of settled work must not.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { createDescendantBuckets, detachDescendant, indexDescendant, seedDescendantsOnce, type DescendantBuckets, type DescendantPredicate } from './descendants.ts'

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
const indexes = new WeakMap<Context, DescendantBuckets>()

/**
 * Which live agents this index holds.
 *
 * Only a session whose header names a parent and carries the subagent origin is
 * a descendant; a fork shares the lineage field without that origin.
 */
const isSubagentDescendant: DescendantPredicate = agent => {
  const { parentSession, origin } = agent.session.header
  return parentSession !== undefined && origin === 'subagent'
}

/** The index for one realm, subscribing to the lifecycle the first time it is asked. */
function indexFor(ctx: Context): DescendantBuckets {
  const existing = indexes.get(ctx)
  if (existing !== undefined) return existing
  const index = createDescendantBuckets()
  indexes.set(ctx, index)
  ctx.on('agent/created', ({ agent }): undefined => { indexDescendant(index, agent, isSubagentDescendant) })
  // A disposal this index knows is removed exactly, together with the subtree
  // only reachable through it; anything else re-seeds, because a node the index
  // never saw can sit anywhere in any chain.
  ctx.on('agent/disposed', ({ agent }): undefined => { if (!detachDescendant(index, agent, isSubagentDescendant)) index.seeded = false })
  return index
}

/** One live job record, as the host lists it. */
interface JobRecord { readonly owner?: string; readonly status?: string }
/** The job event the host publishes for a registration or a settlement. */
interface JobEvent { readonly type: string; readonly job: JobRecord }
/** The subset of the host job service this gate needs. */
interface JobsService {
  list(owner: string): readonly JobRecord[]
  readonly events?: { subscribe(filter: { owners: 'all' }, listener: (event: JobEvent) => void): () => void }
}
/** Live job counts per owner session id, maintained from job events. */
interface JobsIndex {
  readonly service: JobsService
  readonly live: Map<string, number>
  watching: boolean
}
const jobIndexes = new WeakMap<Context, JobsIndex>()

/**
 * The realm's job counts, subscribing to job events the first time it is asked.
 *
 * `list(owner)` answers with every retained record — settled ones included —
 * and materializes a view per record, so the old decision paid O(all retained
 * jobs) with a multi-microsecond constant on every checkpoint. Registered and
 * settled are the only events that change liveness (stopping and removed do
 * not), so one subscription keeps a count that answers the same question.
 */
function jobsFor(ctx: Context): JobsIndex | undefined {
  const service = ctx.get('jobs') as unknown as JobsService | undefined
  if (service === undefined) return undefined
  let index = jobIndexes.get(ctx)
  if (index === undefined) {
    index = { service, live: new Map(), watching: false }
    jobIndexes.set(ctx, index)
    // The host drops an owner's job records with the owner's disposal, so the
    // count goes with them: a long-lived realm keeps no entry per past owner.
    const counts = index.live
    ctx.on('agent/disposed', ({ agent }): undefined => { counts.delete(String(agent.session.id)) })
    const events = service.events
    if (events !== undefined) {
      const counts = index.live
      const stop = events.subscribe({ owners: 'all' }, event => {
        const owner = event.job.owner
        if (typeof owner !== 'string') return
        if (event.type !== 'registered' && event.type !== 'settled') return
        const known = counts.get(owner)
        if (known === undefined) return
        counts.set(owner, Math.max(0, known + (event.type === 'registered' ? 1 : -1)))
      })
      index.watching = true
      ctx.effect(() => () => stop())
    }
  }
  return index
}

/** Live jobs one owner has, counted once and then maintained by events. */
function liveJobCount(ctx: Context, agent: Agent): number {
  const index = jobsFor(ctx)
  if (index === undefined) return 0
  const owner = String(agent.session.id)
  if (!index.watching) {
    return index.service.list(owner).filter(job => job.owner === owner && (job.status === 'running' || job.status === 'stopping')).length
  }
  const known = index.live.get(owner)
  if (known !== undefined) return known
  let count = 0
  for (const job of index.service.list(owner)) {
    if (job.owner === owner && (job.status === 'running' || job.status === 'stopping')) count += 1
  }
  index.live.set(owner, count)
  return count
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
  seedDescendantsOnce(index, () => ctx.agents.list(), isSubagentDescendant)

  const root = String(agent.session.id)
  const first = index.children.get(root)
  if (first === undefined || first.size === 0) return false
  const visited = new Set<string>()
  const pending = [root]
  while (pending.length > 0) {
    const parentId = pending.pop()
    if (parentId === undefined) continue
    for (const child of index.children.get(parentId) ?? []) {
      if (visited.has(child.id)) continue
      // The index drops an entry together with its disposal; membership is
      // exactly "still live", answered without a registry round trip.
      if (!index.live.has(child)) continue
      visited.add(child.id)
      pending.push(String(child.session.id))
    }
  }
  return visited.size > 0
}

/** Whether the session owns a background job that has not settled. */
export function hasLiveJobs(ctx: Context, agent: Agent): boolean {
  return liveJobCount(ctx, agent) > 0
}
