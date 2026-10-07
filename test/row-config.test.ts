/**
 * Row-level contract tests: the Schemastery config the Plugins page renders,
 * the bundle patch that grants this plugin the continuation slot, and which
 * driver each strategy mounts.
 *
 * Strategy mounting is exercised against a deterministic stand-in context (the
 * same shapes Cordis hands a plugin: `logger`, `on`, `effect`, `plugin`,
 * `agents`, `goals` and a fiber registry), so the child-mount decisions and
 * the lifetime rules are asserted without a live host.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Config, resolveRowConfig, strategies, type Strategy } from '../src/config.ts'
import { applyStrategy, foreignDriverActive, NATIVE_DRIVER_NAME, REPLACEMENT_DRIVER_NAME } from '../src/mode.ts'
import type { StrategyOptions } from '../src/mode.ts'

const root = new URL('../', import.meta.url)
const patchFile = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
const zh = JSON.parse(readFileSync(new URL('locale/zh.json', root), 'utf8')) as { meta: { title: string; description: string } }
const en = JSON.parse(readFileSync(new URL('locale/en.json', root), 'utf8')) as { meta: { title: string; description: string } }

/** The host driver stand-in: a plain plugin registered under the stock name. */
const nativeStandIn: Plugin<void> = { name: NATIVE_DRIVER_NAME, inject: [], apply() {} }

/** A mountable record of one fake realm. */
interface Realm {
  readonly ctx: Context
  readonly logs: string[]
  readonly disarmed: string[]
  readonly mounted: string[]
  readonly effects: (() => unknown)[]
  readonly disposals: number[]
  foreign(name: string): void
  /** Dispatch one plugin checkpoint exactly as cordis would. */
  emit(event: string, payload: unknown): void
}

/** Build a stand-in context with the service and fiber shapes cordis provides. */
function realm(): Realm {
  const logs: string[] = []
  const disarmed: string[] = []
  const mounted: string[] = []
  const effects: (() => unknown)[] = []
  const disposals: number[] = []
  const fibers: { runtime?: { name?: string }; uid: number | null; parent: { fiber: unknown } }[] = []
  const agent = { id: 'agent-1', status: 'idle', session: { id: 'session-1', header: { origin: 'root' } } }
  const jobs = {
    list: () => [{ id: 'job-1', kind: 'task', owner: 'session-1', status: 'running' }],
    events: { subscribe: () => () => {} },
  }
  const sessions = { flush: async () => {} }
  const goal = { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed' }
  const handlers = new Map<string, ((payload: never) => void)[]>()
  const fiber = { parent: undefined as { fiber: unknown } | undefined, uid: 1 }
  const ctx = {
    fiber,
    logger: {
      info: (...args: unknown[]) => logs.push('info ' + args.join(' ')),
      warn: (...args: unknown[]) => logs.push('warn ' + args.join(' ')),
      error: (...args: unknown[]) => logs.push('error ' + args.join(' ')),
    },
    agents: {
      list: () => [agent],
      get: (id: string) => (id === agent.id ? agent : undefined),
      isOwnedBy: () => false,
    },
    goals: {
      get: () => goal,
      disarm: () => { goal.activation = 'disarmed'; disarmed.push('disarm') },
      resume: () => { goal.activation = 'armed'; disarmed.push('resume') },
    },
    jobs,
    sessions,
    get: (name: string) => (name === 'jobs' ? jobs : name === 'sessions' ? sessions : undefined),
    on: (event: string, handler: (payload: never) => void) => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    },
    effect: (callback: () => unknown) => {
      const cleanup = callback()
      if (typeof cleanup === 'function') effects.push(cleanup as () => unknown)
    },
    plugin: (plugin: Plugin<unknown>) => {
      const child: { runtime?: { name?: string }; uid: number | null; parent: { fiber: unknown } } = { runtime: { name: plugin.name }, uid: 2, parent: { fiber } }
      fibers.push(child)
      mounted.push(String(plugin.name))
      const childFiber = {
        dispose: async () => { child.uid = null; disposals.push(1) },
        parent: { fiber },
      }
      return Object.assign(Promise.resolve(childFiber), { dispose: childFiber.dispose })
    },
    registry: { values: () => [{ fibers }] },
  } as unknown as Context
  return {
    ctx,
    logs,
    disarmed,
    mounted,
    effects,
    disposals,
    foreign(name: string) {
      fibers.push({ runtime: { name }, uid: 3, parent: { fiber: { uid: 99 } } })
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload as never)
    },
  }
}

test('the config schema is a native Schemastery object with every field described', () => {
  const serialized = Config.toJSON() as {
    uid: number
    refs: Record<string, { type: string; meta?: { description?: string; default?: unknown }; list?: string[]; dict?: Record<string, string>; value?: unknown }>
  }
  const envelope = serialized.refs[String(serialized.uid)]!
  assert.equal(envelope.type, 'object')
  const fields = Object.keys(envelope.dict ?? {})
  assert.deepEqual(fields, ['strategy', 'waitForJobs', 'waitForSubagents', 'maxHoldMs'])
  for (const field of fields) {
    const node = serialized.refs[envelope.dict![field]!]!
    assert.ok((node.meta?.description ?? '').length > 0, field + ' has no description for the form')
  }
  const strategyNode = serialized.refs[envelope.dict!['strategy']!]!
  assert.equal(strategyNode.type, 'union')
  assert.equal(strategyNode.meta?.default, 'activation')
  const branches = (strategyNode.list ?? []).map(id => serialized.refs[id]!)
  assert.deepEqual(branches.map(branch => branch.value), [...strategies])
  for (const branch of branches) assert.ok((branch.meta?.description ?? '').length > 0, 'a strategy branch has no description')
  assert.equal(serialized.refs[envelope.dict!['waitForJobs']!]!.meta?.default, true)
  assert.equal(serialized.refs[envelope.dict!['waitForSubagents']!]!.meta?.default, true)
  assert.equal(serialized.refs[envelope.dict!['maxHoldMs']!]!.meta?.default, 0)
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, 'the form only renders native schemastery nodes')
  assert.equal(typeof Reflect.get(Config, 'type'), 'string')
})

test('resolveRowConfig applies defaults and rejects anything unknown', () => {
  assert.deepEqual(resolveRowConfig(), { strategy: 'activation', waitForJobs: true, waitForSubagents: true, maxHoldMs: 0 })
  assert.equal(resolveRowConfig({ strategy: 'off', maxHoldMs: 5 }).strategy, 'off')
  assert.throws(() => resolveRowConfig({ strategy: 'ours' as never }), /strategy must be one of/)
  assert.throws(() => resolveRowConfig({ wat: true } as never), /unknown configuration option/)
  assert.throws(() => resolveRowConfig({ maxHoldMs: -1 }), /non-negative whole number/)
  assert.throws(() => resolveRowConfig({ waitForJobs: 'yes' } as never), /must be a boolean/)
})

test('the bundle layer mounts this row and disables the host row', () => {
  assert.match(patchFile, /- insert:\n    - id: goal-wait-gate\n      name: dsh-goal-wait-gate\n/)
  assert.equal((patchFile.match(/- insert:/g) ?? []).length, 1, 'the bundle layer inserts more than one row list')
  assert.match(patchFile, /- id: goal-round-driver\n  disabled: true\n/, 'the host goal-round-driver row is not disabled')
  assert.equal((patchFile.match(/^\s*- id: goal-round-driver$/gm) ?? []).length, 1)
  const entries = patchFile.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
  assert.ok(!entries.includes('config:'), 'the shipped layer must not pin row config; defaults live in the schema')
})

test('the card text names every strategy and all three ways back to official behaviour', () => {
  for (const text of [zh.meta.description, en.meta.description]) {
    for (const strategy of strategies) assert.ok(text.includes(strategy), strategy + ' is missing from the card text')
    assert.match(text, /卸载|uninstall/iu)
    assert.match(text, /官方|official/iu)
  }
  assert.match(zh.meta.description, /默认/u)
  assert.match(en.meta.description, /default/iu)
  assert.match(zh.meta.title, /目标续行闸门/u)
})

/** Apply one strategy on a stand-in realm and return it. */
async function applyStrategyOn(config: Record<string, unknown>, options: StrategyOptions = {}): Promise<Realm> {
  const space = realm()
  await applyStrategy(space.ctx, resolveRowConfig(config), {
    importNativeDriver: async () => nativeStandIn,
    detectHost: async () => ({ distribution: '0.2.1-alpha.1', driver: { removeCancelledQueuedMessage: true } }),
    ...options,
  })
  return space
}

test('activation mounts the host driver beside the gate', async () => {
  const space = await applyStrategyOn({ strategy: 'activation' })
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME])
  assert.equal(foreignDriverActive(space.ctx), false, 'our own child counts as foreign')
  assert.deepEqual(space.disarmed, ['disarm'], 'the gate did not withhold continuation for live work')
  for (const cleanup of space.effects) cleanup()
  assert.deepEqual(space.disarmed, ['disarm', 'resume'], 'unload must re-arm the hold it owns')
})

test('native mounts the host driver and leaves goals alone', async () => {
  const space = await applyStrategyOn({ strategy: 'native' })
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME])
  assert.deepEqual(space.disarmed, [], 'native must not touch goal activation')
})

test('off mounts no driver and withholds continuation unconditionally', async () => {
  const space = await applyStrategyOn({ strategy: 'off', waitForJobs: false, waitForSubagents: false })
  assert.deepEqual(space.mounted, [], 'off must not mount a driver')
  assert.deepEqual(space.disarmed, ['disarm'], 'off did not hold the goal')
  for (const cleanup of space.effects) cleanup()
  assert.deepEqual(space.disarmed, ['disarm', 'resume'], 'unload must re-arm the hold it owns')
})

test('replacement mounts the ported driver under its own name', async () => {
  const space = await applyStrategyOn({ strategy: 'replacement' })
  assert.deepEqual(space.mounted, [REPLACEMENT_DRIVER_NAME])
  assert.deepEqual(space.disarmed, [], 'the ported driver waits by eligibility, not by disarming')
})

test('replacement falls back to the host driver when the host is not pinned', async () => {
  const space = await applyStrategyOn({ strategy: 'replacement' }, {
    detectHost: async () => { throw new Error('unsupported distribution') },
  })
  assert.ok(space.logs.some(line => line.startsWith('error ') && line.includes('falling back')), 'the fallback was not logged')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME], 'the fallback did not mount the host driver')
  assert.deepEqual(space.disarmed, ['disarm'], 'the fallback did not keep the gate')
})

test('a foreign driver makes the row stay inert instead of driving twice', async () => {
  const space = realm()
  space.foreign(NATIVE_DRIVER_NAME)
  assert.equal(foreignDriverActive(space.ctx), true)
  await applyStrategy(space.ctx, resolveRowConfig({ strategy: 'activation' }), { importNativeDriver: async () => nativeStandIn })
  assert.deepEqual(space.mounted, [], 'the row mounted a second driver')
  assert.equal(space.logs.filter(line => line.includes('already mounted')).length, 1, 'the conflict was not reported once')
  assert.deepEqual(space.disarmed, [], 'the row must not fight a foreign driver')
})

/**
 * The host predicate that decides whether the Plugins page gets a form at all,
 * copied from `@deepseek-ai/dsh-settings` (`volatileForm`): recurse into an
 * object, return a field only when it carries `meta.volatile`, and return
 * undefined when no field survives.
 */
function volatileForm(schema: Schema): Schema | undefined {
  if (Reflect.get(schema.meta, 'volatile') === true) return new Schema(schema.toJSON())
  if (Reflect.get(schema, 'type') === 'object') {
    const dict: Record<string, Schema> = {}
    for (const [key, child] of Object.entries((Reflect.get(schema, 'dict') ?? {}) as Record<string, Schema>)) {
      const field = volatileForm(child)
      if (field !== undefined) dict[key] = field
    }
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
  }
  return undefined
}

test('every row-config field is volatile, which is what gives the card a form', () => {
  const serialized = Config.toJSON() as {
    refs: Record<string, { type: string; meta?: { volatile?: unknown; description?: string }; dict?: Record<string, string> }>
  }
  const envelope = serialized.refs[String((Config.toJSON() as { uid: number }).uid)]!
  for (const field of Object.keys(envelope.dict ?? {})) {
    const node = serialized.refs[envelope.dict![field]!]!
    assert.equal(node.meta?.volatile, true, field + ' is not volatile, so the host serves no form field for it')
  }
  // The volatile marker belongs to the field, never to a node beneath one:
  // cordis rejects "volatile fields require a fixed object path without an
  // enclosing volatile field" when a volatile node has a volatile ancestor.
  const strategyNode = serialized.refs[envelope.dict!['strategy']!]!
  assert.equal(strategyNode.meta?.volatile, true, 'the strategy field is not volatile')
  for (const branch of (strategyNode as { list?: string[] }).list ?? []) {
    assert.equal(serialized.refs[branch]!.meta?.volatile ?? false, false, 'a union branch must not be volatile inside a volatile union')
  }
})

test('the host volatileForm filter yields a non-empty object schema for this row', () => {
  assert.equal(Reflect.get(Config, Symbol.for('schemastery')), true, 'not a native schemastery node')
  assert.equal(Reflect.get(Config, 'type'), 'object', 'the row Config is not an object schema')
  assert.equal(typeof Reflect.get(Config, 'meta'), 'object', 'the row Config has no meta object')
  const form = volatileForm(Config)
  assert.notEqual(form, undefined, 'volatileForm(Config) returned undefined: the Plugins page would render no namespace at all')
  assert.equal(Reflect.get(form!, 'type'), 'object')
  const dict = Reflect.get(form!, 'dict') as Record<string, Schema>
  assert.deepEqual(Object.keys(dict).sort(), ['maxHoldMs', 'strategy', 'waitForJobs', 'waitForSubagents'])
  const union = dict['strategy']!
  assert.equal(Reflect.get(union, 'type'), 'union')
  const list = Reflect.get(union, 'list') as Schema[]
  assert.deepEqual(list.map(branch => Reflect.get(branch, 'value')), [...strategies])
  assert.equal(Reflect.get(Reflect.get(union, 'meta') as object, 'default'), 'activation')
})

test('a changed live strategy swaps the driver in place, with exactly one driver left', async () => {
  const space = realm()
  let strategy: Strategy = 'activation'
  let waitForJobs = true
  const live = {
    strategy: { get: () => strategy },
    waitForJobs: { get: () => waitForJobs },
    waitForSubagents: { get: () => true },
    maxHoldMs: { get: () => 0 },
  }
  const handle = await applyStrategy(space.ctx, live, {
    importNativeDriver: async () => nativeStandIn,
    detectHost: async () => ({ distribution: '0.2.1-alpha.1', driver: { removeCancelledQueuedMessage: true } }),
  })
  assert.equal(handle.current(), 'activation')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME])
  assert.deepEqual(space.disarmed, ['disarm'], 'the gate did not hold for the live job')

  // A saved change is visible at the next sync; nothing is remounted but the driver.
  strategy = 'native'
  await handle.sync()
  assert.equal(handle.current(), 'native')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME, NATIVE_DRIVER_NAME], 'the host driver was not remounted')
  assert.equal(space.disposals.length, 1, 'the previous driver child was not disposed')
  assert.deepEqual(space.disarmed, ['disarm', 'resume'], 'leaving activation must re-arm the hold this gate owned')
  const liveDrivers = () => [...space.ctx.registry.values()]
    .flatMap(runtime => [...runtime.fibers])
    .filter(fiber => fiber.uid !== null && fiber.runtime?.name === NATIVE_DRIVER_NAME).length
  assert.equal(liveDrivers(), 1, 'two drivers are mounted at once')

  // Idempotent: a second sync with the same strategy mounts nothing.
  await handle.sync()
  assert.equal(space.mounted.length, 2, 'sync is not idempotent')
  assert.equal(liveDrivers(), 1)

  // The row itself stays mounted after the swap.
  for (const cleanup of space.effects) cleanup()
  assert.equal(handle.current(), undefined)
})

test('a live policy change applies at the next evaluation without a remount', async () => {
  const space = realm()
  let waitForJobs = true
  const live = {
    strategy: { get: () => 'activation' as const },
    waitForJobs: { get: () => waitForJobs },
    waitForSubagents: { get: () => true },
    maxHoldMs: { get: () => 0 },
  }
  await applyStrategy(space.ctx, live, { importNativeDriver: async () => nativeStandIn })
  assert.deepEqual(space.disarmed, ['disarm'])

  waitForJobs = false
  // The gate's bookkeeping is keyed by the exact live agent object, as cordis dispatches it.
  space.emit('agent/turn-stopping', { agent: space.ctx.agents.list()[0] })
  assert.deepEqual(space.disarmed, ['disarm', 'resume'], 'the saved waitForJobs change did not apply at the next evaluation')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME], 'a policy change must not remount the driver')
})

