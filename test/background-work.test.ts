import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createBackgroundPolicy } from '../src/driver/background-work.ts'
import type { BackgroundConfig } from '../src/driver/background-work.ts'

/** Minimal Agent stand-in: the policy reads identity and session header only. */
const agent = (id: string, header: Record<string, unknown> = {}): Agent =>
  ({ id, session: { header } }) as unknown as Agent

interface FakeJob { id: string; kind: string; owner?: string; status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed' }
type JobListener = (event: { type: string; job: FakeJob }) => void

/**
 * Fake host context covering exactly the surface the background policy uses.
 * The emit helper invokes listeners with whatever arguments the real emit
 * passes, which is how the parent argument reaches the handler. The job
 * registry keeps real records and delivers the same lifecycle events the
 * local registry does, so the policy's index can be compared against a list
 * scan over the very same state.
 */
function fakeHost(extra: readonly Agent[] = []) {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const parent = agent('parent-1')
  const agents = new Map<string, Agent>([[parent.id, parent], ...extra.map(item => [item.id, item] as const)])
  const jobs = new Map<string, FakeJob>()
  let jobListener: JobListener | undefined
  const ctx = {
    agents: {
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
      isOwnedBy: () => true,
    },
    jobs: {
      // list(caller) is the real registry's projection: the caller's own jobs
      // plus every unowned one. The policy's owner filter is what excludes the
      // unowned ones, so the fake must include them to be exact.
      list: (caller?: string) => [...jobs.values()].filter(job => job.owner === undefined || job.owner === caller),
      events: { subscribe: (_filter: unknown, listener: JobListener) => { jobListener = listener; return () => { jobListener = undefined } } },
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
  }
  return {
    ctx: ctx as unknown as Context,
    parent,
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    remove: (id: string) => agents.delete(id),
    /** The pre-index check, kept as the reference the indexed one must match. */
    referenceHold: (agentId: string, config: BackgroundConfig): boolean =>
      [...jobs.values()].some(job => job.owner === agentId
        && (job.status === 'running' || job.status === 'stopping')
        && (config.waitForJobs !== false || (config.waitForSubagents !== false && job.kind === 'subagent'))),
    register(id: string, options: { kind?: string; owner?: string } = {}) {
      // An explicitly absent owner registers an unowned job, as the real spec does.
      const owner = 'owner' in options ? options.owner : parent.id
      const job: FakeJob = { id, kind: options.kind ?? 'bash', owner, status: 'running' }
      jobs.set(id, job)
      jobListener?.({ type: 'registered', job: { ...job } })
      return job
    },
    stopping(job: FakeJob) {
      job.status = 'stopping'
      jobListener?.({ type: 'stopping', job: { ...job } })
    },
    settle(job: FakeJob, status: FakeJob['status'] = 'completed') {
      job.status = status
      jobListener?.({ type: 'settled', job: { ...job } })
    },
    drop(job: FakeJob) {
      jobs.delete(job.id)
      jobListener?.({ type: 'removed', job: { ...job } })
    },
  }
}

test('an external activation holds continuation through its parent', () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: false, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  assert.equal(policy.allows(host.parent), true, 'an idle parent continues')
  // From 0.2.1-alpha.2 on, an external provider owns no local Agent and starts
  // no Job, so the parent argument is the only lineage the hold can use.
  host.emit('subagent/start', { runId: 'run-1', id: 'external-child', provider: 'acp', local: false }, host.parent)
  assert.equal(policy.allows(host.parent), false, 'the external activation holds continuation')
  host.emit('subagent/end', { runId: 'run-1' })
  assert.equal(policy.allows(host.parent), true, 'the hold ends with the activation')
  stop()
})

test('a local activation still resolves through the child session', () => {
  const child = agent('child-1', { origin: 'subagent', parentSession: 'parent-1' })
  const host = fakeHost([child])
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: false, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  host.emit('subagent/start', { runId: 'run-2', id: 'child-1', provider: 'in-process', local: true })
  assert.equal(policy.allows(host.parent), false, 'the local child holds continuation')
  // The child Agent stays visible as a descendant until the host disposes it,
  // which is what releases the hold on a local run.
  host.remove('child-1')
  host.emit('agent/disposed', { agent: child })
  host.emit('subagent/end', { runId: 'run-2' })
  assert.equal(policy.allows(host.parent), true)
  stop()
})

test('a run this realm cannot place holds realm-wide instead of guessing a parent', () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: false, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  // No local Agent and no parent argument: no chain may be invented, so the
  // run is held by its id — on every agent, because the work exists even when
  // this realm cannot say whose it is. A pre-alpha.2 host would also report an
  // owned Job for it; the id hold is what covers a host that reports none.
  host.emit('subagent/start', { runId: 'run-3', id: 'unknown-child', provider: 'x', local: false })
  assert.equal(policy.allows(host.parent), false, 'an unplaceable run holds until it ends')
  host.emit('subagent/end', { runId: 'run-3' })
  assert.equal(policy.allows(host.parent), true, 'the hold ends with the activation')
  stop()
})

test('a duplicate activation identity fails closed', () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: false, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  host.emit('subagent/start', { runId: 'run-4', id: 'external-child', provider: 'acp', local: false }, host.parent)
  host.emit('subagent/start', { runId: 'run-4', id: 'external-child', provider: 'acp', local: false }, host.parent)
  assert.throws(() => policy.allows(host.parent), /cannot be observed safely/)
  stop()
})

test('the indexed count follows registered, stopping, settled and removed exactly', async () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: true, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  const allows = async (label: string, expected: boolean) => {
    await new Promise(resolve => setImmediate(resolve)) // a settlement handoff drains on a microtask
    assert.equal(policy.allows(host.parent), expected, label)
  }
  await allows('an empty registry never holds', true)
  const job = host.register('job-1')
  await allows('registered is live', false)
  host.stopping(job)
  await allows('stopping is still live', false)
  host.settle(job)
  await allows('settled is no longer live', true)
  host.drop(job)
  await allows('removed cannot resurrect a hold', true)
  stop()
})

test('the indexed job check answers exactly like the pre-index list scan', async () => {
  const host = fakeHost()
  let waitForJobs = true
  let waitForSubagents = true
  const policy = createBackgroundPolicy(host.ctx, () => ({ waitForJobs, waitForSubagents }))
  const stop = policy.subscribe(() => {})
  const check = async (label: string) => {
    await new Promise(resolve => setImmediate(resolve)) // a settlement handoff drains on a microtask
    const config: BackgroundConfig = { waitForJobs, waitForSubagents }
    assert.equal(policy.allows(host.parent), !host.referenceHold(host.parent.id, config), label)
  }

  await check('empty registry')
  const generic = host.register('job-1')
  await check('generic job running')
  host.stopping(generic)
  await check('generic job stopping')

  // A policy that ignores generic jobs: one is registered while it is ignored,
  // so a counter that only tracked counted kinds would miss it after the save.
  waitForJobs = false
  await check('generic job ignored')
  const late = host.register('job-2')
  await check('generic job registered while ignored')
  const subagent = host.register('job-3', { kind: 'subagent' })
  await check('subagent job counted')
  host.settle(subagent)
  await check('subagent settled, generics still ignored')

  waitForJobs = true
  await check('both generic jobs counted after the save')
  host.settle(generic)
  await check('one generic job left')
  host.settle(late)
  await check('no live job left')
  host.drop(generic)
  host.drop(late)
  host.drop(subagent)
  await check('removed records')

  waitForJobs = false
  waitForSubagents = false
  await check('a policy that counts nothing never holds')
  waitForJobs = true
  await check('a policy save back to counting finds nothing live')
  stop()
})

test('the first decision seeds the counts from the registry', async () => {
  const host = fakeHost()
  const settled = host.register('job-1')
  host.settle(settled) // registered and settled before the policy ever looked
  const live = host.register('job-2')
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: true, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  assert.equal(policy.allows(host.parent), false, 'a job that predates the policy still holds')
  host.settle(live)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(policy.allows(host.parent), true, 'settling the last live job releases')
  stop()
})

test('without an event stream the registry stays the source of truth', () => {
  const host = fakeHost()
  let waitForJobs = false
  // Both waits are off when the driver mounts, so the policy installs no job
  // listener at all; an index could never learn about a later registration.
  const policy = createBackgroundPolicy(host.ctx, () => ({ waitForJobs, waitForSubagents: false }))
  const stop = policy.subscribe(() => {})
  waitForJobs = true
  host.register('job-1')
  assert.equal(policy.allows(host.parent), false, 'the list scan still sees a registration no event could carry')
  stop()
})

test('jobs owned by another session or unowned never hold', () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: true, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  host.register('job-1', { owner: 'session-other' })
  host.register('job-2', { owner: undefined })
  assert.equal(policy.allows(host.parent), true, 'only the exact owner counts')
  stop()
})
