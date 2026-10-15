/**
 * Live descendant buckets: which live agents one session still owns.
 *
 * Both continuation strategies ask that question, and both answer it from
 * buckets keyed by the parent session id instead of rescanning the registry at
 * every decision. What they ask differs — the gate walks a chain at any depth,
 * the ported driver answers from a direct owned child — so only the upkeep is
 * shared: an insert, an exact removal that takes the subtree bucket with it, and
 * the re-seed a removal the index never saw still needs.
 *
 * @module
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

/** One live-descendant index: parent session id to the agents naming it. */
export interface DescendantBuckets {
  readonly children: Map<string, Set<Agent>>
  seeded: boolean
}

/** Whether one live agent belongs in some caller's buckets at all. */
export type DescendantPredicate = (agent: Agent) => boolean

/** One empty index. */
export function createDescendantBuckets(): DescendantBuckets {
  return { children: new Map(), seeded: false }
}

/** Add one live agent under the parent session its header names. */
export function indexDescendant(buckets: DescendantBuckets, agent: Agent, accepts: DescendantPredicate): void {
  if (!accepts(agent)) return
  const parentId = agent.session.header.parentSession
  if (parentId === undefined) return
  const bucket = buckets.children.get(parentId)
  if (bucket === undefined) buckets.children.set(parentId, new Set([agent]))
  else bucket.add(agent)
}

/**
 * Retire one indexed descendant, with the entries keyed by its own session id.
 *
 * Once the node's own link to its parent is gone, a walk from any root can
 * never reach that bucket again, so the subtree goes with it; leaving it would
 * retain live grandchildren and their sets for the life of the index.
 *
 * @returns whether the index can be trusted without re-seeding. An agent this
 *   index could never hold needs no re-seed; a removal it never saw does.
 */
export function detachDescendant(buckets: DescendantBuckets, agent: Agent, accepts: DescendantPredicate): boolean {
  if (!accepts(agent)) return true
  const parentId = agent.session.header.parentSession
  const known = parentId !== undefined && buckets.children.get(parentId)?.delete(agent) === true
  return buckets.children.delete(String(agent.session.id)) || known
}

/**
 * Build every bucket from the live registry, once.
 *
 * @param buckets - index to fill when it carries no seed.
 * @param live - reads the registry; only called while the index is unseeded.
 * @param accepts - the caller's membership predicate.
 */
export function seedDescendantsOnce(buckets: DescendantBuckets, live: () => readonly Agent[], accepts: DescendantPredicate): void {
  if (buckets.seeded) return
  buckets.children.clear()
  for (const agent of live()) indexDescendant(buckets, agent, accepts)
  buckets.seeded = true
}
