import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { hasLiveJobs, hasLiveSubagents } from '../src/live-work.ts'

/** Minimal Agent stand-in: the indexes read identity, session id and header only. */
const agent = (id: string, header: Record<string, unknown> = {}): Agent =>
  ({ id, session: { id, header } }) as unknown as Agent

interface FakeJob { readonly id: string; readonly kind: string; readonly owner?: string; status: 'running' | 'stopping' | 'completed' }
type JobListener = (event: { readonly type: string; readonly job: FakeJob }) => void
type Handler = (...args: unknown[]) => void

/**
 * Fake realm covering exactly the surface the live-work indexes use.
 *
 * The job registry keeps real records and delivers the same lifecycle events
 * the local registry does; the agent registry counts every lookup, so a test
 * can prove an answer came from an index rather than a scan.
 */
function fakeRealm(extra: readonly Agent[] = []) {
  const handlers = new Map<string, Handler[]>()
  const root = agent('root-1')
  const agents = new Map<string, Agent>([[root.id, root], ...extra.map(item => [item.id, item] as const)])
  const jobs = new Map<string, FakeJob>()
  let listCalls = 0
  let getCalls = 0
  let jobListener: JobListener | undefined
  const jobsService = {
    list(owner?: string) {
      listCalls++
      // The real registry's projection: the caller's own jobs plus every unowned one.
      return [...jobs.values()].filter(job => job.owner === undefined || job.owner === owner)
    },
    events: {
      subscribe(_filter: unknown, listener: JobListener) {
        jobListener = listener
        return () => { jobListener = undefined }
      },
    },
  }
  const ctx = {
    get: (name: string) => (name === 'jobs' ? jobsService : undefined),
    effect: (callback: () => () => void) => callback(),
    agents: {
      get: (id: string) => { getCalls++; return agents.get(id) },
      list: () => { listCalls++; return [...agents.values()] },
      isOwnedBy: () => true,
    },
    on: (name: string, listener: Handler) => {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => undefined
    },
  }
  return {
    ctx: ctx as unknown as Context,
    root,
    emit: (name: string, ...args: unknown[]) => { for (const handler of handlers.get(name) ?? []) handler(...args) },
    remove: (id: string) => agents.delete(id),
    job: (job: FakeJob) => jobs.set(job.id, job),
    removeJob: (id: string) => jobs.delete(id),
    emitJob: (type: string, job: FakeJob) => jobListener?.({ type, job }),
    listCalls: () => listCalls,
    getCalls: () => getCalls,
  }
}

test('a descendant holds, and a disposal the index knows releases without a rebuild', () => {
  const child = agent('child-1', { parentSession: 'root-1', origin: 'subagent' })
  const realm = fakeRealm([child])
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), true, 'the seeded index sees the descendant')
  const seeded = realm.listCalls()
  realm.remove(child.id)
  realm.emit('agent/disposed', { agent: child })
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), false, 'the removal releases the hold')
  assert.equal(realm.listCalls(), seeded, 'an exact removal never scans the registry')
})

test('a disposal the index never saw re-seeds from the live registry', () => {
  const child = agent('child-2', { parentSession: 'root-1', origin: 'subagent' })
  const realm = fakeRealm([child])
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), true)
  const seeded = realm.listCalls()
  realm.emit('agent/disposed', { agent: agent('stranger-1', { parentSession: 'root-1', origin: 'subagent' }) })
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), true)
  assert.ok(realm.listCalls() > seeded, 'the next question rebuilds from the registry')
})

test('a non-descendant disposal changes nothing and never re-seeds', () => {
  const realm = fakeRealm([])
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), false)
  const seeded = realm.listCalls()
  const fork = agent('fork-1', { parentSession: 'root-1' })
  realm.emit('agent/disposed', { agent: fork })
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), false)
  assert.equal(realm.listCalls(), seeded, 'a node that was never indexable needs no upkeep')
})

test('descendant membership answers from the index, never from the registry', () => {
  const child = agent('child-1', { parentSession: 'root-1', origin: 'subagent' })
  const grandchild = agent('grandchild-1', { parentSession: 'child-1', origin: 'subagent' })
  const realm = fakeRealm([child, grandchild])
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), true)
  assert.equal(realm.getCalls(), 0, 'the walk resolves liveness without a registry lookup')
  realm.remove(grandchild.id)
  realm.emit('agent/disposed', { agent: grandchild })
  assert.equal(hasLiveSubagents(realm.ctx, realm.root), true, 'the child is still live')
  assert.equal(realm.getCalls(), 0)
})

test('live jobs seed once per owner and then follow job events', () => {
  const realm = fakeRealm()
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false)
  assert.equal(realm.listCalls(), 1, 'the first decision seeds from the registry')
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false)
  assert.equal(realm.listCalls(), 1, 'a second decision does not rescan every retained record')

  const job: FakeJob = { id: 'job-1', kind: 'bash', owner: 'root-1', status: 'running' }
  realm.job(job)
  realm.emitJob('registered', job)
  assert.equal(hasLiveJobs(realm.ctx, realm.root), true, 'a registration is seen without a scan')
  realm.emitJob('stopping', { ...job, status: 'stopping' })
  assert.equal(hasLiveJobs(realm.ctx, realm.root), true, 'stopping is still live')
  realm.emitJob('settled', { ...job, status: 'completed' })
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false, 'settlement releases the hold')
  assert.equal(realm.listCalls(), 1, 'no event fell back to a registry scan')
})

test('unowned jobs and another owner job never count', () => {
  const realm = fakeRealm()
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false)
  const unowned: FakeJob = { id: 'job-ownless', kind: 'bash', status: 'running' }
  const foreign: FakeJob = { id: 'job-foreign', kind: 'bash', owner: 'session-2', status: 'running' }
  realm.job(unowned)
  realm.job(foreign)
  realm.emitJob('registered', unowned)
  realm.emitJob('registered', foreign)
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false, 'only this owner\'s live jobs hold')
  assert.equal(realm.listCalls(), 1)
})

test("an owner disposal drops its count and the next decision re-seeds", () => {
  const realm = fakeRealm()
  const job: FakeJob = { id: 'job-1', kind: 'bash', owner: 'root-1', status: 'running' }
  realm.job(job)
  realm.emitJob('registered', job)
  assert.equal(hasLiveJobs(realm.ctx, realm.root), true)
  // The host drops every retained record with the owner's disposal.
  realm.removeJob('job-1')
  realm.remove(realm.root.id)
  realm.emit('agent/disposed', { agent: realm.root })
  assert.equal(hasLiveJobs(realm.ctx, realm.root), false)
  assert.equal(realm.listCalls(), 2, 'the count was dropped with the owner, not retained at zero')
})
