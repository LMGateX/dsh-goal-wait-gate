/**
 * Row strategy mounting: which implementation owns goal continuation.
 *
 * The bundle layer this package ships disables the host's own
 * `goal-round-driver` row, so this plugin is the thing that mounts a driver in
 * every strategy except `off`. The driver is a child of this row's fiber —
 * no root-parent requirement and no lifetime tombstone.
 *
 * The row configuration is volatile: the host's settings form hands every field
 * over as a live accessor, and a saved change does **not** remount this row.
 * {@link applyStrategy} therefore returns a handle whose `sync()` re-reads the
 * configuration and swaps the mounted driver in place. Sync runs on the
 * checkpoints this plugin already owns — `agent/turn-stopping`, `agent/status`
 * idle and `goal/changed` — so there is no polling timer and nothing that can
 * keep the event loop alive.
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
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveRowConfig, type ResolvedGateConfig, type ResolvedRowConfig, type RowConfig, type RowConfigInput, type Strategy } from './config.ts'
import { GoalWaitGate } from './gate.ts'
import { createBackgroundPolicy } from './driver/background-work.ts'
import { assertHostVersion } from './driver/host-version.ts'
import { installNativeDriver } from './driver/native-driver.ts'
import { publishLiveRow } from './status-route.ts'
import { writeGateStatus, type MountedDriver } from './status.ts'

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
  /** How long one child teardown may hold the serialized apply queue, in ms. */
  readonly teardownTimeoutMs?: number
}

/** A mounted row: what is driving now, and how to follow a saved change. */
export interface StrategyHandle {
  /**
   * Re-read the volatile configuration and switch the mounted driver when the
   * strategy changed. Idempotent, serialized, and safe to call on every
   * checkpoint.
   *
   * @returns a promise resolving once this row matches the saved configuration.
   */
  sync(): Promise<void>
  /**
   * Adopt a configuration the plugin page just saved.
   *
   * A settings document write does not re-resolve a running row, so the page
   * hands its own save back here: the row remounts to match it immediately
   * instead of waiting for a composition reload that never comes.
   *
   * @param config - the saved row fields.
   * @returns a promise resolving once this row matches the saved configuration.
   */
  applyLive(config: unknown): Promise<void>
  /** Dispose whatever this row mounted. Idempotent. */
  dispose(): Promise<void>
  /** The strategy mounted right now, or undefined before the first mount. */
  current(): Strategy | undefined
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
 * Mount the configured strategy and return the handle that keeps it current.
 *
 * @param ctx - this plugin's context.
 * @param config - the raw row configuration, live accessors included.
 * @param options - seams used by tests.
 * @returns the mounted row.
 */
export async function applyStrategy(ctx: Context, config: RowConfig | RowConfigInput = {}, options: StrategyOptions = {}): Promise<StrategyHandle> {
  const row = new RowStrategy(ctx, config, options)
  // The first mount is fatal on a bad configuration — a composition error must
  // fail the load — while a later checkpoint only reports one.
  await row.mount()
  return row
}

/** One mounted row: the driver child, its gate, and the live configuration behind them. */
class RowStrategy implements StrategyHandle {
  readonly #ctx: Context
  readonly #config: RowConfig | RowConfigInput
  #live: RowConfigInput | undefined
  readonly #options: StrategyOptions
  readonly #drivers: Fiber[] = []
  #gate: GoalWaitGate | undefined
  #strategy: Strategy | undefined
  #queue: Promise<void> = Promise.resolve()
  #closed = false
  /**
   * A goal-round driver this plugin does not own mounted after this row.
   *
   * Latched: the composition no longer matches what this row mounted for, so
   * it stays inert for the rest of its lifetime instead of racing the driver
   * the host just published.
   */
  #foreign = false

  constructor(ctx: Context, config: RowConfig | RowConfigInput, options: StrategyOptions) {
    this.#ctx = ctx
    this.#config = config
    this.#options = options
    // The checkpoints this plugin already owns carry the live re-read: a saved
    // configuration change is applied at the next turn boundary, idle edge or
    // goal change. No timer is ever installed for it.
    ctx.on('agent/turn-stopping', ({ agent }) => this.#checkpoint(agent))
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.#checkpoint(agent)
    }, { prepend: true })
    ctx.on('goal/changed', ({ agent }) => this.#checkpoint(agent), { prepend: true })
    ctx.on('agent/disposed', ({ agent }) => this.#gate?.forget(agent))
    // A one-shot probe cannot see a driver that mounts after this row, and two
    // drivers would race for the same goal. Watch every plugin mount for this
    // row's lifetime, as the startup owner already does, and stand down the
    // moment the host's own row appears.
    ctx.on('internal/plugin', (fiber: Fiber) => this.#watchIntruder(fiber), { global: true })
    ctx.effect(() => () => this.#close(), 'goal-wait-gate teardown')
  }

  current(): Strategy | undefined {
    return this.#strategy
  }

  sync(): Promise<void> {
    return this.#enqueue(false)
  }

  applyLive(config: unknown): Promise<void> {
    const saved = config as RowConfigInput
    this.#live = saved
    // A policy-only save changes nothing to mount: the policy reads the live
    // settings, so an unchanged strategy must not touch the driver at all.
    // Deciding that here -- rather than inside the queued apply -- also keeps a
    // checkpoint that is already running from re-reading the new value first.
    try {
      if (resolveRowConfig(saved).strategy === this.#strategy) return Promise.resolve()
    } catch {
      // An invalid save falls through to the queued apply, which reports it.
    }
    return this.#enqueue(false)
  }

  mount(): Promise<void> {
    return this.#enqueue(true)
  }

  /**
   * Serialize one application of the live configuration.
   *
   * @param fatal - when true the returned promise rejects on a bad configuration
   *   (the initial mount); otherwise the error is logged and the row survives it.
   * @returns the queued application.
   */
  #enqueue(fatal: boolean, force = false): Promise<void> {
    const next = this.#queue.then(async () => await this.#apply(force))
    this.#queue = next.catch((error: unknown) => {
      this.#ctx.logger.error(`goal-wait-gate: could not apply the saved configuration: ${messageOf(error)}`)
    })
    return fatal ? next : this.#queue
  }

  dispose(): Promise<void> {
    this.#close()
    return Promise.resolve()
  }

  /** One checkpoint: follow the saved configuration, then evaluate the live gate. */
  #checkpoint(agent: Agent): void {
    void this.sync()
    this.#gate?.evaluate(agent)
  }

  /** Bring the mounted driver in line with the live configuration. */
  async #apply(force = false): Promise<void> {
    if (this.#closed || this.#foreign) return
    const config = resolveRowConfig(this.#live ?? this.#config)
    if (!force && this.#strategy === config.strategy) return
    // A switch tears a driver down, and a teardown disarms every goal it drove:
    // nothing in the host re-arms one by itself, so remember what was running.
    // The first mount tears nothing down and owes no goal anything; restoring
    // there would undo the hold this very mount records.
    const held = this.#strategy === undefined ? [] : this.#captureArmed()
    await this.#teardown()
    if (this.#closed) return
    if (this.#foreign) {
      // Stood down mid-switch: the teardown may have disarmed goals this row
      // was holding, and the foreign driver must find them armed.
      this.#resumeHeld(held)
      return
    }
    this.#strategy = config.strategy
    await this.#mount(config)
    this.#resumeHeld(held)
    if (this.#foreign) this.#strategy = undefined
  }

  /** Goals that must survive a switch armed, by identity and revision. */
  #captureArmed(): { agent: Agent; id: string; revision: number }[] {
    const held: { agent: Agent; id: string; revision: number }[] = []
    for (const agent of this.#ctx.agents.list()) {
      const goal = this.#ctx.goals.get(agent)
      if (goal === undefined || goal.phase !== 'active') continue
      // A goal this row's gate disarmed was armed before the row held it, and
      // the hold dies with the gate: the switch owes that goal the armed state.
      if (goal.activation !== 'armed' && this.#gate?.holds(agent, goal.id) !== true) continue
      held.push({ agent, id: goal.id, revision: goal.revision })
    }
    return held
  }

  /**
   * Re-arm exactly the goals the capture identified and that are still there,
   * disarmed, at the captured revision.
   *
   * The gate this switch just mounted is the new authority: a goal it has
   * already recorded as held must not be re-armed here.
   */
  #resumeHeld(held: readonly { agent: Agent; id: string; revision: number }[]): void {
    for (const item of held) {
      if (this.#ctx.agents.get(item.agent.id) !== item.agent) continue
      try {
        const goal = this.#ctx.goals.get(item.agent)
        if (goal === undefined || goal.id !== item.id || goal.revision !== item.revision) continue
        if (goal.phase !== 'active' || goal.activation !== 'disarmed') continue
        if (this.#gate?.holds(item.agent, goal.id) === true) continue
        this.#ctx.goals.resume(item.agent, { id: goal.id, revision: goal.revision })
      } catch (error) {
        this.#ctx.logger.warn(`goal-wait-gate: could not resume goal ${item.id} after the switch: ${messageOf(error)}`)
      }
    }
  }

  /** Mount what one strategy needs, recording every child for the next teardown. */
  async #mount(config: ResolvedRowConfig): Promise<void> {
    if (this.#foreign) return
    if (config.strategy === 'off') {
      this.#mountGate(config, true)
      this.#ctx.logger.info('goal-wait-gate: strategy=off — no driver is mounted, so no goal continues automatically until this plugin is switched off or uninstalled')
      this.#record('off', 'none', 'the off strategy mounts no driver')
      return
    }
    if (foreignDriverActive(this.#ctx)) {
      this.#ctx.logger.error('goal-wait-gate: another goal-round driver is already mounted; this plugin stays inert so a goal is never driven twice')
      this.#record(config.strategy, 'none', 'another goal-round driver is already mounted')
      return
    }
    const gated = config.strategy === 'activation'
    if (gated) this.#mountGate(config, false)
    const mounted = await this.#mountDriver(config)
    if (!mounted) return
    const snapshot = resolveRowConfig(this.#live ?? this.#config)
    this.#ctx.logger.info(`goal-wait-gate: strategy=${config.strategy} — ${describe(snapshot, gated)} (waitForJobs=${snapshot.waitForJobs}, waitForSubagents=${snapshot.waitForSubagents}, maxHoldMs=${snapshot.maxHoldMs})`)
  }

  /**
   * Install the gate with a live policy provider, then sweep every live agent.
   *
   * The provider is read at each evaluation, so `waitForJobs`,
   * `waitForSubagents` and `maxHoldMs` apply from the next decision without
   * remounting anything.
   *
   * @param config - the configuration the gate was mounted under.
   * @param alwaysHold - when true (`off`) continuation is withheld unconditionally.
   * @returns the mounted gate.
   */
  #mountGate(config: ResolvedRowConfig, alwaysHold: boolean): GoalWaitGate {
    const gate = new GoalWaitGate(this.#ctx, () => this.#policy(alwaysHold, config))
    this.#gate = gate
    // A row mounts — or switches strategy — while work may already be pending.
    // Gate whatever is live right now instead of waiting for a turn boundary
    // that an idle agent may never reach.
    for (const agent of this.#ctx.agents.list()) gate.evaluate(agent)
    return gate
  }

  /** The gate policy as it stands right now; a bad saved value keeps the last good shape. */
  #policy(alwaysHold: boolean, mounted: ResolvedRowConfig): ResolvedGateConfig {
    try {
      // `#live` is the save the page handed back: a settings-document write
      // does not push the new value back into the row's own config accessors.
      const live = resolveRowConfig(this.#live ?? this.#config)
      return { waitForJobs: live.waitForJobs, waitForSubagents: live.waitForSubagents, maxHoldMs: live.maxHoldMs, alwaysHold }
    } catch (error) {
      this.#ctx.logger.error(`goal-wait-gate: ignoring an invalid saved policy (${messageOf(error)})`)
      return { waitForJobs: mounted.waitForJobs, waitForSubagents: mounted.waitForSubagents, maxHoldMs: mounted.maxHoldMs, alwaysHold }
    }
  }

  /**
   * Mount the driver one strategy asks for, keeping the child for teardown.
   *
   * A strategy whose pinned identity does not match this distribution falls
   * back to activation-shaped behaviour: the host's own driver plus the gate.
   * Goals are never left undriven, and the failure is logged once.
   *
   * @param config - resolved row configuration.
   * @returns whether a driver is mounted.
   */
  async #mountDriver(config: ResolvedRowConfig): Promise<boolean> {
    const ctx = this.#ctx
    const options = this.#options
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
        return await this.#fallbackToActivation(config, `this host distribution is not pinned for the ported driver (${messageOf(error)})`)
      }
      if (foreignDriverActive(ctx)) {
        ctx.logger.error('goal-wait-gate: another goal-round driver appeared while mounting; the ported driver was not mounted')
        return false
      }
      // Captured for the child closure: the child's own `this` is not this row.
      const row = this
      const child = ctx.plugin({
        name: REPLACEMENT_DRIVER_NAME,
        inject: ['agents', 'goals', 'sessions', 'jobs'],
        apply(driverCtx: Context) {
          const driver = installNativeDriver(driverCtx, createBackgroundPolicy(driverCtx, () => {
            try {
              const live = resolveRowConfig(row.#live ?? row.#config)
              return { waitForJobs: live.waitForJobs, waitForSubagents: live.waitForSubagents }
            } catch {
              return { waitForJobs: config.waitForJobs, waitForSubagents: config.waitForSubagents }
            }
          }), profile.driver)
          driverCtx.effect(() => () => driver.stop(), 'goal-wait-gate replacement driver')
        },
      }) as unknown as Fiber
      this.#drivers.push(child)
      const outcome = await settleMount(child, options)
      if (this.#closed || this.#foreign) {
        // The row closed or stood down while this child was still mounting:
        // dispose it here, or it would drive goals with nobody left to tear it
        // down.
        this.#drivers.splice(this.#drivers.indexOf(child), 1)
        void settleDispose(child, options.teardownTimeoutMs)
        return true
      }
      if (outcome === 'failed') {
        this.#drivers.splice(this.#drivers.indexOf(child), 1)
        await child.dispose().catch(() => {})
        return await this.#fallbackToActivation(config, 'the ported driver could not be mounted')
      }
      if (outcome === 'pending') ctx.logger.error('goal-wait-gate: the ported driver is still waiting for the services it injects; it mounts as soon as they appear')
      this.#record(config.strategy, 'replacement-port', undefined, profile)
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
    const fiber = ctx.plugin(native) as unknown as Fiber
    if (this.#closed || this.#foreign) {
      // The row closed or stood down while the host module was loading: the
      // child must not stay live, or two drivers would race for one goal.
      void settleDispose(fiber, options.teardownTimeoutMs)
      return false
    }
    this.#drivers.push(fiber)
    watchMount(ctx, fiber, 'the host goal-round driver', options)
    this.#record(config.strategy, config.strategy === 'activation' ? 'host-driver+gate' : 'host-driver')
    return true
  }

  /**
   * Record which driver is live, best-effort, for the person reading the row later.
   *
   * @param requested - strategy the row asked for.
   * @param mounted - driver that is actually live.
   * @param fallback - why the request was not honoured, when it was not.
   * @param profile - matched host identity, when the ported driver was selectable.
   */
  #record(requested: string, mounted: MountedDriver, fallback?: string, profile?: { distribution: string; cordis?: string; driverSha256?: string }): void {
    writeGateStatus({
      at: new Date().toISOString(),
      requested,
      mounted,
      ...(fallback === undefined ? {} : { fallback }),
      ...(profile === undefined ? {} : { host: { distribution: profile.distribution, ...(profile.cordis === undefined ? {} : { cordis: profile.cordis }), ...(profile.driverSha256 === undefined ? {} : { driverSha256: profile.driverSha256 }) } }),
    })
  }
  /** Keep goals driven: mount the host driver beside the gate after a failure. */
  async #fallbackToActivation(config: ResolvedRowConfig, why: string): Promise<boolean> {
    const ctx = this.#ctx
    ctx.logger.error(`goal-wait-gate: ${config.strategy} cannot be honoured — ${why}; falling back to the host driver beside the gate`)
    if (this.#gate === undefined) this.#mountGate(config, false)
    const mounted = await this.#mountDriver({ ...config, strategy: 'activation' })
    // Recorded last, and for the strategy that was asked for: the nested mount
    // writes its own record, and the person reading this file needs the request,
    // what really mounted, and why they differ — not the fallback silently
    // relabelled as a deliberate activation row.
    this.#record(config.strategy, mounted ? 'host-driver+gate' : 'none', why)
    return mounted
  }

  /** Drop the current driver and gate without closing the row. */
  async #teardown(): Promise<void> {
    const drivers = this.#drivers.splice(0, this.#drivers.length)
    const gate = this.#gate
    this.#gate = undefined
    this.#strategy = undefined
    gate?.dispose()
    for (const driver of drivers) await settleDispose(driver, this.#options.teardownTimeoutMs)
  }

  /** Close the row: the gate re-arms its holds, the children are disposed. */
  #close(): void {
    if (this.#closed) return
    this.#closed = true
    const drivers = this.#drivers.splice(0, this.#drivers.length)
    const gate = this.#gate
    this.#gate = undefined
    this.#strategy = undefined
    // A closed row must not stay reachable: a late POST would answer ok:true.
    publishLiveRow(undefined)
    gate?.dispose()
    for (const driver of drivers) void settleDispose(driver, this.#options.teardownTimeoutMs)
  }

  /**
   * One plugin mount: another goal-round driver after this row means
   * continuation is no longer this row's to drive.
   *
   * @param fiber - the fiber cordis just published.
   */
  #watchIntruder(fiber: Fiber): void {
    if (fiber.uid === null || fiber.runtime?.name !== NATIVE_DRIVER_NAME) return
    if (ownedByUs(this.#ctx, fiber)) return
    this.#standDown()
  }

  /**
   * Stop driving because a foreign goal-round driver mounted after this row.
   *
   * The latch is permanent for this row's lifetime: re-mounting at the next
   * checkpoint would race the driver the host just published. The gate is
   * disposed, which re-arms the holds it owned, so the new owner finds the
   * goals it is expected to drive.
   */
  #standDown(): void {
    if (this.#foreign || this.#closed) return
    this.#foreign = true
    this.#ctx.logger.error('goal-wait-gate: another goal-round driver was mounted after this row; this row stops driving so a goal is never driven twice')
    const drivers = this.#drivers.splice(0, this.#drivers.length)
    const gate = this.#gate
    this.#gate = undefined
    this.#strategy = undefined
    gate?.dispose()
    for (const driver of drivers) void settleDispose(driver, this.#options.teardownTimeoutMs)
  }
}

/**
 * Dispose a child without trusting what dispose() returns.
 *
 * A fiber disposed a second time resolves to undefined, not a promise, and this
 * teardown effect runs after the child registration effect on a parent unload.
 * An unguarded .catch there throws and aborts the rest of the disposer chain,
 * leaking this row's listeners and failing the reload that triggered it.
 */
function settleDispose(target: { dispose: () => unknown }, timeoutMs = 2000): Promise<void> {
  const done = Promise.resolve().then(() => target.dispose()).then(() => undefined, () => undefined)
  // A teardown that waits on real disk I/O must never pin the serialized queue:
  // the row would stop applying configuration and the page's save would hang.
  return Promise.race([done, new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })])
}

/** One line describing who is driving. */
function describe(config: ResolvedRowConfig, gated: boolean): string {
  if (config.strategy === 'native') return 'the host driver is mounted unchanged; this plugin does not interfere'
  if (config.strategy === 'replacement') return 'the ported driver owns the scheduler and waits on background eligibility'
  return gated ? 'the host driver is mounted beside the disarm/resume gate' : 'the host driver is mounted'
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
    void settleDispose(fiber)
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
