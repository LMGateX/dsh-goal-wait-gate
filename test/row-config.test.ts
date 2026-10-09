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
import { gateStatusPath, type GateStatus } from '../src/status.ts'

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
  /** The realm's single live goal, read the way a test asserts on it. */
  readonly goal: { id: string; revision: number; phase: string; activation: string; roundsStarted: number }
  /** The owner's live jobs, which a test may add to or clear between decisions. */
  readonly jobs: { id: string; kind: string; owner?: string; status: string }[]
  /** How the mounted host-driver stand-in behaves, so a test can model the pinned host. */
  readonly driver: {
    /** The pinned host driver disarms every goal it drove when its stop runs. */
    disarmsOnTeardown: boolean
    /** Extra teardown work; return a promise to model a stop that never settles. */
    onTeardown?: (() => unknown) | undefined
  }
  /** Mount a driver fiber that this row does not own; returns it for the watch event. */
  foreign(name: string): unknown
  /** Dispatch one plugin checkpoint exactly as cordis would. */
  emit(event: string, payload: unknown): void
}

/** The record the plugin just wrote, read the way a person would. */
function readStatus(): GateStatus | undefined {
  try {
    return JSON.parse(readFileSync(gateStatusPath(), 'utf8')) as GateStatus
  } catch {
    return undefined
  }
}

/** Build a stand-in context with the service and fiber shapes cordis provides. */
function realm(options: { readonly onDriverMount?: (ctx: Context) => unknown } = {}): Realm {
  const logs: string[] = []
  const disarmed: string[] = []
  const mounted: string[] = []
  const effects: (() => unknown)[] = []
  const disposals: number[] = []
  const fibers: { runtime?: { name?: string }; uid: number | null; parent: { fiber: unknown } }[] = []
  const agent = { id: 'agent-1', status: 'idle', session: { id: 'session-1', header: { origin: 'root' } } }
  // The owner's live jobs are realm state a test can change between decisions.
  const jobs = [{ id: 'job-1', kind: 'task', owner: 'session-1', status: 'running' }]
  const jobService = {
    list: () => jobs.map(job => ({ ...job })),
    events: { subscribe: () => () => {} },
  }
  const sessions = { flush: async () => {} }
  const goal = { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 0 }
  const handlers = new Map<string, ((payload: never) => void)[]>()
  const fiber = { parent: undefined as { fiber: unknown } | undefined, uid: 1 }
  /**
   * How the mounted host-driver stand-in behaves. The pinned host driver
   * disarms every goal it drove when its stop runs, and a test may also model
   * an official edit landing mid-switch or a stop that never settles.
   */
  const driver: Realm['driver'] = { disarmsOnTeardown: false }
  const emit = (event: string, payload: unknown): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload as never)
  }
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
    jobs: jobService,
    sessions,
    get: (name: string) => (name === 'jobs' ? jobService : name === 'sessions' ? sessions : undefined),
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
      // Cordis publishes every fiber through internal/plugin; the row watches
      // those events, so the stand-in publishes its children the same way.
      emit('internal/plugin', child)
      // A test may model what the pinned host driver does once it is mounted.
      const stopDriver = plugin.name === NATIVE_DRIVER_NAME ? options.onDriverMount?.(ctx as unknown as Context) : undefined
      const childFiber = {
        dispose: async () => {
          child.uid = null
          disposals.push(1)
          if (typeof stopDriver === 'function') (stopDriver as () => void)()
          if (plugin.name === NATIVE_DRIVER_NAME) {
            if (driver.disarmsOnTeardown) goal.activation = 'disarmed'
            await driver.onTeardown?.()
          }
        },
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
    goal,
    jobs,
    driver,
    foreign(name: string) {
      const intruder = { runtime: { name }, uid: 3, parent: { fiber: { uid: 99 } } }
      fibers.push(intruder)
      return intruder
    },
    emit,
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
  // The two mount shapes look alike in a transcript, so the record is what tells
  // them apart afterwards — and it must name the real driver, not the request.
  const status = readStatus()
  assert.equal(status?.requested, 'replacement')
  assert.equal(status?.mounted, 'replacement-port')
  assert.equal(status?.fallback, undefined)
  assert.equal(status?.host?.distribution, '0.2.1-alpha.1')
})

test('replacement falls back to the host driver when the host is not pinned', async () => {
  const space = await applyStrategyOn({ strategy: 'replacement' }, {
    detectHost: async () => { throw new Error('unsupported distribution') },
  })
  assert.ok(space.logs.some(line => line.startsWith('error ') && line.includes('falling back')), 'the fallback was not logged')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME], 'the fallback did not mount the host driver')
  assert.deepEqual(space.disarmed, ['disarm'], 'the fallback did not keep the gate')
  const status = readStatus()
  assert.equal(status?.requested, 'replacement')
  assert.equal(status?.mounted, 'host-driver+gate', 'the record must name what really mounted')
  assert.match(status?.fallback ?? '', /unsupported distribution/)
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

test('a policy-only save never remounts the driver and leaves an armed goal armed', async () => {
  const space = realm()
  space.jobs.length = 0 // no live work: the mounted policy holds nothing
  let strategy: Strategy = 'activation'
  const live = {
    strategy: { get: () => strategy },
    waitForJobs: { get: () => true },
    waitForSubagents: { get: () => true },
    maxHoldMs: { get: () => 0 },
  }
  const handle = await applyStrategy(space.ctx, live, { importNativeDriver: async () => nativeStandIn })
  assert.equal(space.goal.activation, 'armed', 'an armed goal with no live work must be left alone')
  assert.deepEqual(space.disarmed, [], 'the gate held nothing')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME])

  // The page saves the mounted strategy with one policy field changed.
  await handle.applyLive({ strategy: 'activation', waitForJobs: false })
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME], 'a policy-only save remounted the driver')
  assert.equal(space.disposals.length, 0, 'a policy-only save disposed a driver')
  assert.equal(space.goal.activation, 'armed')

  // The saved policy is what the next decision reads, still without a remount.
  space.jobs.push({ id: 'job-2', kind: 'task', owner: 'session-1', status: 'running' })
  space.emit('agent/turn-stopping', { agent: space.ctx.agents.list()[0] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(space.goal.activation, 'armed', 'the saved waitForJobs=false did not apply')
  assert.deepEqual(space.disarmed, [], 'the gate withheld continuation on the stale policy')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME], 'a checkpoint remounted the driver')
  for (const cleanup of space.effects) cleanup()
})

test('a strategy switch re-arms the goal its teardown disarmed and keeps the next round queued', async () => {
  const space = realm({
    onDriverMount: ctx => ctx.on('agent/status', ({ status }) => {
      if (status !== 'idle') return
      // What the freshly mounted official driver does at idle: claim the next
      // round of an active armed goal. A goal the switch left disarmed claims
      // nothing, and the goal round silently ends.
      if (space.goal.phase === 'active' && space.goal.activation === 'armed' && space.goal.roundsStarted === 0) space.goal.roundsStarted = 1
    }),
  })
  space.jobs.length = 0
  space.driver.disarmsOnTeardown = true // the pinned host driver disarms in stop()
  let strategy: Strategy = 'activation'
  const live = {
    strategy: { get: () => strategy },
    waitForJobs: { get: () => true },
    waitForSubagents: { get: () => true },
    maxHoldMs: { get: () => 0 },
  }
  const handle = await applyStrategy(space.ctx, live, { importNativeDriver: async () => nativeStandIn })
  assert.equal(space.goal.activation, 'armed')
  assert.deepEqual(space.disarmed, [])

  strategy = 'native'
  await handle.sync()
  assert.equal(handle.current(), 'native')
  assert.equal(space.goal.activation, 'armed', 'the teardown disarmed the goal and the switch did not re-arm it')
  assert.deepEqual(space.disarmed, ['resume'], 'the switch did not resume exactly the goal the teardown disarmed')

  // The driver the switch mounted finds the armed goal at its next idle edge.
  space.emit('agent/status', { agent: space.ctx.agents.list()[0], status: 'idle' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(space.goal.roundsStarted, 1, 'the next goal round was not queued')
  for (const cleanup of space.effects) cleanup()
})

test('a switch does not resume a revision an official edit changed while it ran', async () => {
  const space = realm()
  space.jobs.length = 0
  space.driver.disarmsOnTeardown = true
  let strategy: Strategy = 'native'
  const live = {
    strategy: { get: () => strategy },
    waitForJobs: { get: () => true },
    waitForSubagents: { get: () => true },
    maxHoldMs: { get: () => 0 },
  }
  const handle = await applyStrategy(space.ctx, live, { importNativeDriver: async () => nativeStandIn })
  assert.equal(space.goal.activation, 'armed', 'the native strategy leaves goals alone')

  // An official edit commits a new revision while the switch is tearing down.
  space.driver.onTeardown = () => { space.goal.revision += 1 }
  strategy = 'activation'
  await handle.sync()
  assert.deepEqual(space.disarmed, [], 'a goal edited mid-switch must not be resumed with a stale ref')
  assert.equal(space.goal.activation, 'disarmed', 'the revised goal keeps whatever state the edit left')
  for (const cleanup of space.effects) cleanup()
})

test('a driver whose stop never settles cannot block a sync or a later save', async () => {
  const space = realm()
  space.driver.onTeardown = () => new Promise<void>(() => {})
  let strategy: Strategy = 'activation'
  const live = {
    strategy: { get: () => strategy },
    waitForJobs: { get: () => false },
    waitForSubagents: { get: () => false },
    maxHoldMs: { get: () => 0 },
  }
  const handle = await applyStrategy(space.ctx, live, {
    importNativeDriver: async () => nativeStandIn,
    teardownTimeoutMs: 20,
  })
  assert.equal(handle.current(), 'activation')

  strategy = 'native'
  const started = Date.now()
  await handle.sync()
  assert.equal(handle.current(), 'native', 'the switch did not apply')
  assert.ok(Date.now() - started < 1000, 'the hanging teardown pinned the serialized queue')

  // A later call still applies a strategy change.
  await handle.applyLive({ strategy: 'off' })
  assert.equal(handle.current(), 'off', 'a later save did not apply')
  assert.equal(space.goal.activation, 'disarmed', 'the off strategy withholds unconditionally')
  await handle.dispose()
})

test('a driver mounted after this row stands the row down instead of driving twice', async () => {
  const space = await applyStrategyOn({ strategy: 'activation' })
  assert.deepEqual(space.disarmed, ['disarm'], 'the gate holds for the live job')
  assert.deepEqual(space.mounted, [NATIVE_DRIVER_NAME])
  assert.equal(foreignDriverActive(space.ctx), false, 'our own child counts as foreign')

  // The host's own row appears after ours; the one-shot probe at mount could
  // not have seen it.
  const intruder = space.foreign(NATIVE_DRIVER_NAME)
  assert.equal(foreignDriverActive(space.ctx), true)
  space.emit('internal/plugin', intruder)
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(space.logs.filter(line => line.includes('mounted after')).length, 1, 'the second driver was not reported')
  assert.deepEqual(space.disposals, [1], 'the row did not tear its own driver down')
  assert.deepEqual(space.disarmed, ['disarm', 'resume'], 'the hold this row owned must go to the new driver')
  assert.equal(space.goal.activation, 'armed')

  // A later checkpoint must not remount a driver: the row stays inert.
  space.emit('agent/turn-stopping', { agent: space.ctx.agents.list()[0] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(space.mounted.length, 1, 'the row remounted a driver after standing down')
  for (const cleanup of space.effects) cleanup()
})

