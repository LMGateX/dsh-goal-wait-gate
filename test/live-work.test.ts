import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { hasLiveSubagents } from '../src/live-work.ts'

/** Minimal Agent stand-in: the index reads identity and session header only. */
const agent = (id: string, header: Record<string, unknown> = {}): Agent =>
  ({ id, session: { id, header } }) as unknown as Agent

/** Fake realm covering exactly the surface the descendant index uses. */
function fakeRealm(extra: readonly Agent[]) {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const root = agent('root-1')
  const agents = new Map<string, Agent>([[root.id, root], ...extra.map(item => [item.id, item] as const)])
  let listCalls = 0
  const ctx = {
    agents: {
      get: (id: string) => agents.get(id),
      list: () => { listCalls++; return [...agents.values()] },
      isOwnedBy: () => true,
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
  }
  return {
    ctx: ctx as unknown as Context,
    root,
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    remove: (id: string) => agents.delete(id),
    listCalls: () => listCalls,
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
