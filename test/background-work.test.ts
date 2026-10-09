import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createBackgroundPolicy } from '../src/driver/background-work.ts'

/** Minimal Agent stand-in: the policy reads identity and session header only. */
const agent = (id: string, header: Record<string, unknown> = {}): Agent =>
  ({ id, session: { header } }) as unknown as Agent

/**
 * Fake host context covering exactly the surface the background policy uses.
 * The emit helper invokes listeners with whatever arguments the real emit
 * passes, which is how the parent argument reaches the handler.
 */
function fakeHost(extra: readonly Agent[] = []) {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const parent = agent('parent-1')
  const agents = new Map<string, Agent>([[parent.id, parent], ...extra.map(item => [item.id, item] as const)])
  const ctx = {
    agents: {
      get: (id: string) => agents.get(id),
      list: () => [...agents.values()],
      isOwnedBy: () => true,
    },
    jobs: { list: () => [], events: { subscribe: () => () => {} } },
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

test('a run this realm cannot place is left to owned Jobs, not guessed', () => {
  const host = fakeHost()
  const policy = createBackgroundPolicy(host.ctx, { waitForJobs: false, waitForSubagents: true })
  const stop = policy.subscribe(() => {})
  // No local Agent and no parent argument: nothing may be assumed, and the
  // pre-alpha.2 Job path still covers such a run where the host reports one.
  host.emit('subagent/start', { runId: 'run-3', id: 'unknown-child', provider: 'x', local: false })
  assert.equal(policy.allows(host.parent), true)
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

