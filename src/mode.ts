/**
 * Row strategy mounting: which implementation owns goal continuation.
 *
 * The bundle layer this package ships disables the host's own
 * `goal-round-driver` row, so this plugin is the thing that mounts a driver in
 * every strategy except `off`. The driver is a child of this row's fiber —
 * no root-parent requirement, no lifetime tombstone, and a saved config change
 * remounts the plugin, which switches the driver in place.
 *
 * Strategy vocabulary and the rollback contract:
 * - `activation` (default): the host's published native driver callback, mounted
 *   by us, plus the disarm/resume gate — today's installed behaviour.
 * - `native`: the same host callback with no gate: official DSH behaviour.
 *   Composition is unchanged, so this is the in-page rollback.
 * - `off`: no driver at all, so nothing continues a goal automatically.
 * - `replacement`: the pinned TypeScript port owns scheduling and waits by
 *   background eligibility instead of by disarming.
 *
 * Uninstalling the plugin removes the bundle layer, and with it the
 * `disabled: true` line that hides the host's own row: official behaviour
 * returns. No strategy writes to any profile file.
 */
import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { ResolvedRowConfig } from './config.ts'
import { GoalWaitGate } from './gate.ts'
import { createBackgroundPolicy } from './driver/background-work.ts'
import { assertHostVersion } from './driver/host-version.ts'
import { installNativeDriver } from './driver/native-driver.ts'

/** Registered plugin name of the host's own goal-round driver. */
export const NATIVE_DRIVER_NAME = 'goal-round-driver'

/** Registered plugin name of the child that hosts the ported driver. */
export const REPLACEMENT_DRIVER_NAME = 'goal-wait-owned-replacement-driver'

/** The published host module this plugin mounts for activation/native. */
type NativeDriverModule = Plugin<void>

/** Timing knobs, overridable so tests do not need real timers. */
export interface StrategyOptions {
  /** Import the host's driver module through this function instead of the real one. */
  readonly importNativeDriver?: () => Promise<NativeDriverModule>
  /** Resolve the pinned host profile through this function instead of the real one. */
  readonly detectHost?: (ctx: Context) => Promise<{ distribution: string; driver: { removeCancelledQueuedMessage: boolean } }>
  /** How long a child mount may stay pending before it is reported, in ms. */
  readonly mountTimeoutMs?: number
}

/** Outcome of waiting for a child fiber to settle. */
type MountOutcome = 'mounted' | 'pending' | 'failed'

/**
 * Read one optional service without widening this plugin's inject list.
 *
 * @param ctx - this plugin's context.
 * @param name - service name as registered by the host.
 * @returns the service, or undefined when this realm does not provide it.
 */
function service(ctx: Context, name: string): unknown {
  const lookup = (ctx as unknown as { get?: (key: string) => unknown }).get
  return typeof lookup === 'function' ? lookup.call(ctx, name) : undefined
}

/**
 * Whether one fiber is this plugin's own descendant.
 *
 * The walk must be cycle-safe: in a real Cordis realm a fiber whose parent
 * context is the root points back at itself two steps later (`fiber` ->
 * `fiber.parent.fiber` -> the same fiber), so an unguarded ancestor walk
 * never terminates and blocks the event loop. Every visited fiber is
 * recorded, and the walk starts at the fiber itself so that the row's own
 * child drivers are recognized and a foreign fiber never is.
 *
 * @param ctx - this plugin's context.
 * @param fiber - the fiber being classified.
 * @returns whether the fiber is this row or one of its descendants.
 */
function ownedByUs(ctx: Context, fiber: Fiber): boolean {
  const seen = new Set<Fiber>()
  let cursor: Fiber | undefined = fiber
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    if (cursor === ctx.fiber) return true
    cursor = (cursor as unknown as { parent?: { fiber?: Fiber } }).parent?.fiber
  }
  return false
}

/**
 * Whether a goal-continuation driver that this plugin does not own is mounted.
 *
 * @param ctx - any context in the realm being inspected.
 * @returns whether a foreign driver fiber is live.
 */
export function foreignDriverActive(ctx: Context): boolean {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber.uid === null || ownedByUs(ctx, fiber)) continue
      if (fiber.runtime?.name === NATIVE_DRIVER_NAME) return true
    }
  }
  return false
}

/** The host driver module as published; imported lazily, never at load time. */
function importNativeDriver(): Promise<NativeDriverModule> {
  return import('@deepseek-ai/dsh-goal-round-driver') as Promise<NativeDriverModule>
}

/**
 * Apply the configured strategy on this plugin's fiber.
 *
 * @param ctx - this plugin's context.
 * @param config - the resolved row configuration.
 * @param options - seams used by tests.
 */
export async function applyStrategy(ctx: Context, config: ResolvedRowConfig, options: StrategyOptions = {}): Promise<void> {
  if (config.strategy === 'off') {
    mountGate(ctx, config, true)
    ctx.logger.info('goal-wait-gate: strategy=off — no driver is mounted, so no goal continues automatically until this plugin is switched off or uninstalled')
    return
  }
  if (foreignDriverActive(ctx)) {
    ctx.logger.error('goal-wait-gate: another goal-round driver is already mounted; this plugin stays inert so a goal is never driven twice')
    return
  }
  const gate = config.strategy === 'activation' ? mountGate(ctx, config, false) : undefined
  const mounted = await mountDriver(ctx, config, options, gate)
  if (!mounted) return
  ctx.logger.info(`goal-wait-gate: strategy=${config.strategy} — ${describe(config, gate !== undefined)} (waitForJobs=${config.waitForJobs}, waitForSubagents=${config.waitForSubagents}, maxHoldMs=${config.maxHoldMs})`)
}

/** One line describing who is driving. */
function describe(config: ResolvedRowConfig, gated: boolean): string {
  if (config.strategy === 'native') return 'the host driver is mounted unchanged; this plugin does not interfere'
  if (config.strategy === 'replacement') return 'the ported driver owns the scheduler and waits on background eligibility'
  return gated ? 'the host driver is mounted beside the disarm/resume gate' : 'the host driver is mounted'
}

/**
 * Mount the configured driver as a child of this row.
 *
 * A strategy whose pinned identity does not match this distribution falls back
 * to activation-shaped behaviour: the host's own driver plus the gate. Goals
 * are never left undriven, and the failure is logged once.
 *
 * @param ctx - this plugin's context.
 * @param config - resolved row configuration.
 * @param options - seams used by tests.
 * @param gate - the already-mounted activation gate, when there is one.
 * @returns whether a driver is mounted.
 */
async function mountDriver(ctx: Context, config: ResolvedRowConfig, options: StrategyOptions, gate: GoalWaitGate | undefined): Promise<boolean> {
  // Cheap realm probe before the dynamic import: a unit-test realm or a
  // partial composition has no `sessions` service, and the host driver cannot
  // run there anyway (its own inject list requires it). Skipping the import
  // keeps such a realm from holding a fiber that can never start.
  if (service(ctx, 'sessions') === undefined) {
    ctx.logger.error(`goal-wait-gate: this realm provides no "sessions" service, so the host goal-round driver cannot run; no driver is mounted by the ${config.strategy} strategy`)
    return false
  }
  const load = options.importNativeDriver ?? importNativeDriver
  const detect = options.detectHost ?? (async (scope: Context) => await assertHostVersion(scope))
  if (config.strategy === 'replacement') {
    let profile
    try {
      profile = await detect(ctx)
    } catch (error) {
      return await fallbackToActivation(ctx, config, options, gate, `this host distribution is not pinned for the ported driver (${messageOf(error)})`)
    }
    if (foreignDriverActive(ctx)) {
      ctx.logger.error('goal-wait-gate: another goal-round driver appeared while mounting; the ported driver was not mounted')
      return false
    }
    const child = ctx.plugin({
      name: REPLACEMENT_DRIVER_NAME,
      inject: ['agents', 'goals', 'sessions', 'jobs'],
      apply(driverCtx: Context) {
        const driver = installNativeDriver(driverCtx, createBackgroundPolicy(driverCtx, config), profile.driver)
        driverCtx.effect(() => () => driver.stop(), 'goal-wait-gate replacement driver')
      },
    })
    const outcome = await settleMount(child, options)
    if (outcome === 'failed') {
      await child.dispose().catch(() => {})
      return await fallbackToActivation(ctx, config, options, gate, 'the ported driver could not be mounted')
    }
    if (outcome === 'pending') ctx.logger.error('goal-wait-gate: the ported driver is still waiting for the services it injects; it mounts as soon as they appear')
    return true
  }
  let native: NativeDriverModule
  try {
    native = await load()
  } catch (error) {
    ctx.logger.error(`goal-wait-gate: the host goal-round driver could not be imported (${messageOf(error)}); no driver is mounted`)
    return false
  }
  if (foreignDriverActive(ctx)) {
    ctx.logger.error('goal-wait-gate: another goal-round driver appeared while mounting; this plugin stays inert')
    return false
  }
  const missing = injectList(native).filter(name => service(ctx, name) === undefined)
  if (missing.length > 0) {
    ctx.logger.error(`goal-wait-gate: the host goal-round driver injects ${missing.join(', ')}, which this realm does not provide; no driver is mounted by the ${config.strategy} strategy`)
    return false
  }
  // The host module is mounted without blocking this row's apply: a plugin
  // whose inject list is not satisfied stays pending, which is how cordis
  // defers a mount until its dependencies exist, and waiting for that is not
  // something this row may impose on the whole composition.
  watchMount(ctx, ctx.plugin(native), 'the host goal-round driver', options)
  return true
}

/**
 * Report the outcome of a mount this row does not block on.
 *
 * @param ctx - this plugin's context.
 * @param fiber - the child fiber being mounted.
 * @param label - how the driver is named in diagnostics.
 * @param options - timing overrides.
 */
function watchMount(ctx: Context, fiber: Fiber, label: string, options: StrategyOptions): void {
  const timer = setTimeout(() => {
    // Cancel the deferred mount instead of leaving a fiber that waits forever
    // for a service this realm never provides; nothing else can drive goals
    // here anyway, and a stuck fiber would keep the composition from settling.
    ctx.logger.error(`goal-wait-gate: ${label} never received the services it injects and was unmounted`)
    void (fiber as unknown as Promise<unknown>).then(() => {}, () => {})
    fiber.dispose().catch(() => {})
  }, options.mountTimeoutMs ?? 1500)
  timer.unref?.()
  void (fiber as unknown as Promise<unknown>).then(
    () => { clearTimeout(timer) },
    (error: unknown) => {
      clearTimeout(timer)
      ctx.logger.error(`goal-wait-gate: ${label} could not be mounted (${messageOf(error)})`)
    },
  )
}

/**
 * Wait for one child fiber without letting a missing service hang the row.
 *
 * A plugin whose `inject` list is not satisfied stays pending, which is how
 * cordis defers a mount until its dependencies exist. That is fine for the
 * composition but unacceptable for this row's own apply, so the wait is bounded
 * and a still-pending child is reported instead of awaited indefinitely.
 *
 * @param fiber - the child fiber to settle.
 * @param options - timing overrides.
 * @returns whether it mounted, is still pending, or failed.
 */
async function settleMount(fiber: Fiber, options: StrategyOptions): Promise<MountOutcome> {
  const timeout = options.mountTimeoutMs ?? 1000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'pending'>(resolve => {
    timer = setTimeout(() => resolve('pending'), timeout)
    timer.unref?.()
  })
  try {
    const settle = (fiber as unknown as Promise<unknown>).then(() => 'mounted' as const, () => 'failed' as const)
    return await Promise.race([settle, expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Keep goals driven: mount the host driver beside the gate after a failure. */
async function fallbackToActivation(ctx: Context, config: ResolvedRowConfig, options: StrategyOptions, gate: GoalWaitGate | undefined, why: string): Promise<boolean> {
  ctx.logger.error(`goal-wait-gate: ${config.strategy} cannot be honoured — ${why}; falling back to the host driver beside the gate`)
  mountGate(ctx, config, false, gate)
  return await mountDriver(ctx, { ...config, strategy: 'activation' }, options, gate ?? undefined)
}

/**
 * Mount the gate, optionally holding regardless of observed work.
 *
 * @param ctx - this plugin's context.
 * @param config - resolved row configuration.
 * @param alwaysHold - when true (`off`) continuation is withheld unconditionally.
 * @param existing - an already-mounted gate, so a fallback does not install two.
 * @returns the mounted gate.
 */
function mountGate(ctx: Context, config: ResolvedRowConfig, alwaysHold: boolean, existing?: GoalWaitGate): GoalWaitGate {
  if (existing !== undefined) return existing
  const gate = new GoalWaitGate(ctx, { ...config, alwaysHold })
  ctx.on('agent/turn-stopping', ({ agent }) => gate.evaluate(agent))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') gate.evaluate(agent)
  }, { prepend: true })
  ctx.on('goal/changed', ({ agent }) => gate.evaluate(agent), { prepend: true })
  ctx.on('agent/disposed', ({ agent }) => gate.forget(agent))
  ctx.effect(() => () => gate.dispose(), 'goal-wait-gate teardown')
  // A row mounts — or remounts after a saved configuration change — while
  // work may already be pending. Gate whatever is live right now instead of
  // waiting for a turn boundary that an idle agent may never reach.
  for (const agent of ctx.agents.list()) gate.evaluate(agent)
  return gate
}

/** The service names one plugin declares it needs, in either inject shape. */
function injectList(plugin: unknown): string[] {
  const inject = (plugin as { inject?: unknown } | undefined)?.inject
  if (Array.isArray(inject)) return inject.filter((name): name is string => typeof name === 'string')
  const required = (inject as { required?: unknown } | null | undefined)?.required
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []
}

/** One error message, whatever was thrown. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
