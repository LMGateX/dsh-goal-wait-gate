import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeFixture } from './native-fixture.ts'
import { goalWaitStartup, getStartupState, apply as startupApply, type StartupConfig } from '../src/startup.ts'
import * as NativeDriver from '@deepseek-ai/dsh-goal-round-driver'
import { goalWaitGate } from '../src/index.ts'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Context } from '@deepseek-ai/cordis'
import { syncBuiltinESMExports } from 'node:module'
import fsPromises from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import Jobs from '@deepseek-ai/dsh-jobs-local'

test('original native cleanup is explicitly unverified when a child disposer rejects', async () => {
  let rejectedCleanup = false
  const h = new NativeFixture({ config: { strategy: 'native' }, beforeStartup: async ctx => {
    ctx.on('internal/plugin', fiber => {
      if (fiber.uid === null || fiber.runtime?.callback !== NativeDriver.apply) return
      fiber.ctx.effect(() => async () => { rejectedCleanup = true; throw new Error('Synthetic rejected native cleanup') }, 'synthetic rejecting native cleanup')
    }, { global: true })
  } })
  try {
    await h.initialize()
    h.createGoal()
    await h.owner.dispose()
    await getStartupState(h.ctx)?.cleanup
    assert.equal(rejectedCleanup, true)
    assert.equal(getStartupState(h.ctx)?.status, 'closed-unverified')
    assert.equal(getStartupState(h.ctx)?.cleanupIntegrity, 'unverified-native')
    assert.equal(h.goal?.activation, 'disarmed')
  } finally { await h.dispose() }
})

test('a directly mounted startup callback remains a recognized lifetime owner', async () => {
  const h = new NativeFixture({ config: { strategy: 'off' }, beforeStartup: async ctx => { await ctx.plugin({ inject: goalWaitStartup.inject, apply: startupApply }, { strategy: 'off' }) } })
  try {
    await assert.rejects(h.initialize(), /owner|intrusion|lifetime/i)
    assert.equal(getStartupState(h.ctx)?.status, 'failed')
    assert.match(String(getStartupState(h.ctx)?.error), /intrusion/i)
  } finally { await h.dispose() }
})

test('closing exposes one retained cleanup promise before synchronous goal revocation', async () => {
  const h = new NativeFixture()
  let observed: Promise<void> | undefined
  try {
    await h.initialize()
    h.startJob(); h.createGoal()
    h.ctx.on('goal/activation-changed', () => {
      if (getStartupState(h.ctx)?.status === 'closing') observed = getStartupState(h.ctx)?.cleanup
    })
    await h.owner.dispose()
    assert.ok(observed)
    assert.equal(observed, getStartupState(h.ctx)?.cleanup)
    await observed
    assert.equal(getStartupState(h.ctx)?.status, 'closed')
    assert.equal(getStartupState(h.ctx)?.cleanupIntegrity, 'managed-stop')
    assert.equal(h.goal?.activation, 'disarmed')
  } finally { await h.dispose() }
})

test('startup requires an empty registry and never disarms a pre-existing agent goal', async () => {
  let existing: import('@deepseek-ai/dsh-agent').AgentHandle | undefined
  const h = new NativeFixture({ beforeStartup: async ctx => {
    existing = await ctx.agents.create({ sessionId: SessionId('synthetic-existing'), agentOptions: { provider: 'synthetic', model: 'local' } })
    ctx.goals.create(existing.agent, { objective: 'Synthetic existing objective' })
  } })
  try {
    await assert.rejects(h.initialize(), /empty agent registry/i)
    assert.ok(existing)
    assert.equal(h.ctx.goals.get(existing.agent)?.activation, 'armed')
    assert.equal(getStartupState(h.ctx), undefined)
  } finally { await existing?.dispose(); await h.dispose() }
})

test('startup rejects an existing isolated core service realm without disposing it', async () => {
  let isolated: import('@deepseek-ai/cordis').Fiber | undefined
  const h = new NativeFixture({ beforeStartup: async ctx => { isolated = await ctx.isolate('jobs').plugin(Jobs) } })
  try {
    await assert.rejects(h.initialize(), /shared core|realm/i)
    assert.equal(isolated?.state, 2)
    assert.equal(getStartupState(h.ctx), undefined)
  } finally { await h.dispose() }
})

test('failed native child publication awaits rejecting cleanup and preserves explicit failure', async () => {
  let rejectedCleanup = false
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = new NativeFixture({ config: { strategy: 'native' }, beforeStartup: async ctx => {
    ctx.on('internal/plugin', fiber => {
      if (fiber.uid === null || fiber.runtime?.callback !== NativeDriver.apply) return
      fiber.ctx.effect(() => async () => { entered.resolve(); await release.promise; rejectedCleanup = true; throw new Error('Synthetic rejected publication cleanup') }, 'synthetic publication cleanup')
      throw new Error('Synthetic child publication failed')
    }, { global: true })
  } })
  let initialization: Promise<NativeFixture> | undefined
  try {
    initialization = h.initialize()
    void initialization.catch(() => {})
    await entered.promise
    let cleanupDone = false
    void getStartupState(h.ctx)?.cleanup?.then(() => { cleanupDone = true })
    await h.settle()
    assert.equal(cleanupDone, false)
    release.resolve()
    await assert.rejects(initialization, /publication failed/i)
    assert.equal(rejectedCleanup, true)
    assert.equal(getStartupState(h.ctx)?.status, 'failed')
    assert.equal(getStartupState(h.ctx)?.cleanupIntegrity, 'unverified-native')
    assert.match(String(getStartupState(h.ctx)?.error), /publication failed/i)
  } finally { release.resolve(); await initialization?.catch(() => {}); await h.dispose() }
})

test('known copied owner labels are rejected before their callback runs', async () => {
  let applied = false
  const h = new NativeFixture({ config: { strategy: 'off' } })
  try {
    await h.initialize()
    assert.throws(() => h.ctx.plugin({ name: 'goal-wait-startup', apply() { applied = true } }), /owner|intrusion/i)
    assert.equal(applied, false)
    assert.equal(getStartupState(h.ctx)?.status, 'failed')
    await getStartupState(h.ctx)?.cleanup
    assert.match(String(getStartupState(h.ctx)?.error), /intrusion/i)
  } finally { await h.dispose() }
})

test('managed owner joins externally started rejecting native cleanup without claiming verification', async () => {
  let rejectedCleanup = false
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const h = new NativeFixture({ config: { strategy: 'native' }, beforeStartup: async ctx => {
    ctx.on('internal/plugin', fiber => {
      if (fiber.uid !== null && fiber.runtime?.callback === NativeDriver.apply) fiber.ctx.effect(() => async () => { entered.resolve(); await release.promise; rejectedCleanup = true; throw new Error('Synthetic rejected external native cleanup') }, 'synthetic slow disposal')
    }, { global: true })
  } })
  try {
    await h.initialize()
    const child = [...h.ctx.registry.get(NativeDriver)!.fibers][0]!
    const childDisposal = child.dispose()
    await entered.promise
    let ownerDone = false
    const ownerDisposal = h.owner.dispose().then(() => { ownerDone = true })
    await h.settle()
    assert.equal(ownerDone, false)
    assert.equal(getStartupState(h.ctx)?.status, 'closing')
    release.resolve()
    await Promise.all([childDisposal, ownerDisposal])
    assert.equal(rejectedCleanup, true)
    assert.equal(getStartupState(h.ctx)?.status, 'closed-unverified')
    assert.equal(getStartupState(h.ctx)?.cleanupIntegrity, 'unverified-native')
  } finally { release.resolve(); await h.dispose() }
})

test('startup freshly reads and rejects mismatched package metadata without JSON module imports', async t => {
  const originalReadFile = fsPromises.readFile
  t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof originalReadFile>) => {
    if (String(args[0]).endsWith('/dsh-goal/package.json')) return JSON.stringify({ name: '@deepseek-ai/dsh-goal', version: '0.2.0-rc.3' })
    return originalReadFile(...args)
  })
  syncBuiltinESMExports()
  const h = new NativeFixture()
  try {
    await assert.rejects(h.initialize(), /version|compatibility/i)
    assert.equal(h.ctx.registry.has(NativeDriver), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('startup checks optional query and SQLite package versions when sessionQuery participates', async t => {
  for (const packageName of ['dsh-session-query', 'dsh-session-query-sqlite']) {
    const originalReadFile = fsPromises.readFile
    t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof originalReadFile>) => {
      if (String(args[0]).endsWith('/' + packageName + '/package.json')) return JSON.stringify({ name: '@deepseek-ai/' + packageName, version: '0.2.0-rc.3' })
      return originalReadFile(...args)
    })
    syncBuiltinESMExports()
    const h = new NativeFixture({ children: true })
    try {
      await assert.rejects(h.initialize(), /compatibility version mismatch.*dsh-session-query/i)
      assert.equal(getStartupState(h.ctx), undefined)
      assert.equal(h.ctx.registry.has(NativeDriver), false)
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
  }
})

test('native selects the original native child and vetoes child configuration updates', async () => {
  const h = new NativeFixture({ config: { strategy: 'native' } })
  try {
    await h.initialize()
    const runtime = h.ctx.registry.get(NativeDriver)
    assert.ok(runtime, 'original native callback is mounted')
    const child = [...runtime.fibers][0]
    assert.ok(child)
    assert.throws(() => child.update({}), /startup|update/i)
    h.startJob(); h.human(); h.createGoal()
    await h.agent.whenIdle(); await h.settle()
    assert.equal(h.goal?.roundsStarted, 1)
    assert.equal(h.mainCalls, 2)
  } finally { await h.dispose() }
})

test('startup rejects a scoped or nested realm before taking ownership', async () => {
  for (const scoped of [false, true]) {
    const h = new NativeFixture({ beforeStartup: async ctx => {
      if (scoped) {
        const scope = createScope(ctx, {})
        await scope.ctx.plugin(goalWaitStartup, { strategy: 'off' })
      } else {
        await ctx.plugin({ name: 'synthetic-container', async apply(child: Context) { await child.plugin(goalWaitStartup, { strategy: 'off' }) } })
      }
    } })
    try { await assert.rejects(h.initialize(), /root|realm|scope/i) }
    finally { await h.dispose() }
  }
})

test('off retains a lifetime owner guard after disposal and cannot remount', async () => {
  const h = new NativeFixture({ config: { strategy: 'off' } })
  try {
    await h.initialize()
    await h.owner.dispose()
    assert.throws(() => h.ctx.plugin(NativeDriver), /owner|intrusion|conflict/i)
    assert.throws(() => h.ctx.plugin(goalWaitStartup, { strategy: 'off' }), /owner|lifetime|remount/i)
    h.human(); await h.agent.whenIdle(); await h.settle()
    assert.equal(h.mainCalls, 1)
  } finally { await h.dispose() }
})

test('startup configuration updates are synchronously vetoed without handoff', async () => {
  const h = new NativeFixture()
  try {
    await h.initialize()
    assert.throws(() => h.owner.update({ strategy: 'native' }), /startup|update/i)
    h.startJob(); h.createGoal(); await h.settle()
    assert.equal(h.goal?.activation, 'armed')
    assert.equal(h.goal?.roundsStarted, 0)
  } finally { await h.dispose() }
})

test('known runtime intrusion is vetoed before apply and fails the managed owner closed', async () => {
  const h = new NativeFixture()
  try {
    await h.initialize()
    h.startJob(); h.createGoal()
    assert.equal(h.goal?.activation, 'armed')
    assert.throws(() => h.ctx.plugin(NativeDriver), /owner|intrusion|conflict/i)
    await h.settle()
    assert.equal(h.goal?.activation, 'disarmed')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { await h.dispose() }
})

test('startup refuses pre-existing native or legacy owners without unloading them', async () => {
  for (const plugin of [NativeDriver, goalWaitGate]) {
    let original: import('@deepseek-ai/cordis').Fiber | undefined
    const h = new NativeFixture({ beforeStartup: async ctx => { original = await ctx.plugin(plugin) } })
    try {
      await assert.rejects(h.initialize(), /owner|conflict/i)
      assert.equal(original?.state, 2)
    } finally { await h.dispose() }
  }
})

test('startup rejects unknown and irrelevant configuration before scheduling', async () => {
  for (const config of [{ strategy: 'replacement', unexpected: true }, { strategy: 'native', waitForJobs: false }, { strategy: 'replacement', maxHoldMs: 0 }, { strategy: 'running-wait' }]) {
    const h = new NativeFixture({ config: config as StartupConfig })
    try { await assert.rejects(h.initialize(), /configuration|strategy|option|unknown/i) }
    finally { await h.dispose() }
  }
})

test('off runs human input without an automatic scheduler', async () => {
  const h = new NativeFixture({ config: { strategy: 'off' } })
  try {
    await h.initialize()
    h.human(); h.createGoal()
    await h.agent.whenIdle(); await h.settle()
    assert.equal(h.mainCalls, 1)
    assert.equal(h.goal?.roundsStarted, 0)
  } finally { await h.dispose() }
})

test('managed startup defaults to activation and unload never releases an owned hold', async () => {
  const h = new NativeFixture({ config: {} as StartupConfig })
  try {
    await h.initialize()
    h.startJob(); h.human(); h.createGoal()
    await h.agent.whenIdle(); await h.settle()
    assert.equal(h.goal?.activation, 'disarmed')
    assert.equal(h.goal?.roundsStarted, 0)
    await h.owner.dispose()
    assert.equal(h.goal?.activation, 'disarmed')
    assert.equal(h.mainCalls, 1)
  } finally { await h.dispose() }
})
