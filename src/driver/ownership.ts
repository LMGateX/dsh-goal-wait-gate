import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { apply as legacyApply } from '../index.ts'

const coreServices = ['agents', 'goals', 'sessions', 'jobs', 'subagents', 'tools', 'llm']
export function assertRootRealm(ctx: Context): void {
  if (ctx.fiber.parent.fiber !== ctx.root.fiber || scopeOf(ctx) !== undefined || scopeOf(ctx.fiber.parent) !== undefined) throw new Error('Startup requires an unscoped root realm')
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      for (const key of coreServices) {
        if (fiber.ctx[Context.isolate][key] !== ctx.root[Context.isolate][key]) throw new Error('Startup requires a shared core service realm')
      }
    }
  }
}

/** Detected published host, recorded for diagnostics only; it grants no authority. */
export interface StartupHost {
  readonly distribution: string
  readonly cordis: string
  readonly driverSha256: string
}
export interface StartupState {
  readonly strategy: string
  /** Exact host artifact identity this managed driver was ported and pinned against. */
  readonly host: StartupHost
  /** Describes the explicit driver boundary, not arbitrary Cordis effect verification. */
  readonly cleanupIntegrity: 'unverified-native' | 'managed-stop'
  status: 'starting' | 'active' | 'closing' | 'closed' | 'closed-unverified' | 'failed'
  error?: unknown
  cleanup?: Promise<void>
}
interface Lease { owner: Fiber; state: StartupState }
const leaseKey = Symbol.for('goal-wait-startup.root-lifetime.v1')
const globalStore = globalThis as typeof globalThis & { [leaseKey]?: WeakMap<object, Lease> }
const leases = globalStore[leaseKey] ??= new WeakMap<object, Lease>()
/**
 * Diagnostics survive disposal. Cleanup retains only own stop/disarm failures
 * actually surfaced to this owner, not swallowed driver state-drain errors.
 * Original native exposes no stop handle; Cordis-hidden native/arbitrary effect
 * failures cannot be verified, even when its disposal promise completes.
 */
export function getStartupState(ctx: Context): Readonly<StartupState> | undefined {
  return leases.get(ctx.root[Context.isolate])?.state
}
export function claimLifetime(ctx: Context, strategy: string, host: StartupHost): StartupState {
  const rootIdentity = ctx.root[Context.isolate]
  if (leases.has(rootIdentity)) throw new Error('Startup root lifetime owner cannot remount')
  const state: StartupState = { strategy, host, status: 'starting', cleanupIntegrity: strategy === 'native' ? 'unverified-native' : 'managed-stop' }
  leases.set(rootIdentity, { owner: ctx.fiber, state })
  return state
}
const ownerCallback = Symbol.for('goal-wait-startup.owner-callback.v1')
/** Cooperating copies preserve callback recognition without changing host objects. */
export function markStartupCallback(callback: Function): void {
  Object.defineProperty(callback, ownerCallback, { value: true })
}
const ownerNames = new Set(['goal-round-driver', 'goal-wait-gate', 'goal-wait-startup', 'background-aware-goal-driver', 'goal-wait-owned-native-compatible-driver', 'goal-wait-owned-replacement-driver'])
export function isKnownOwner(fiber: Fiber, originalNative: Function): boolean {
  return fiber.runtime !== null && (fiber.runtime.callback === originalNative || fiber.runtime.callback === legacyApply || (fiber.runtime.callback as Function & { [ownerCallback]?: boolean })[ownerCallback] === true || ownerNames.has(fiber.runtime.name ?? ''))
}
export function assertNoOwner(ctx: Context, originalNative: Function): void {
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers) {
      if (fiber !== ctx.fiber && isKnownOwner(fiber, originalNative)) throw new Error('Conflicting goal continuation owner already exists')
    }
  }
}
/** Recognized cooperating owners only; not a distributed/global scheduler lease. */
export function watchOwners(ctx: Context, originalNative: Function, close: (error?: Error) => Promise<void>): { mount(plugin: Plugin<void>, captured: (fiber: Fiber) => void): Promise<Fiber> } {
  const owner = ctx.fiber
  let ticket: { callback: Function; parent: Fiber; raw?: Fiber; captured: (fiber: Fiber) => void } | undefined
  let child: Fiber | undefined
  const fail = (error: Error): never => {
    void close(error).catch(reason => ctx.root.logger.error(reason))
    throw error
  }
  ctx.root.on('internal/plugin', fiber => {
    if (fiber.uid === null) {
      if (fiber === owner || fiber === child) void close().catch(reason => ctx.root.logger.error(reason))
      return
    }
    if (ticket && !ticket.raw && fiber.runtime?.callback === ticket.callback && fiber.parent.fiber === ticket.parent) {
      ticket.raw = child = fiber
      ticket.captured(fiber)
      return
    }
    if (isKnownOwner(fiber, originalNative)) fail(new Error('Known goal continuation owner intrusion rejected'))
  }, { global: true, prepend: true })
  ctx.root.on('internal/update', function (this: Fiber, _config: unknown, _noSave: boolean, next: () => void) {
    if (this === owner || this === child || isKnownOwner(this, originalNative)) throw new Error('Startup ownership cannot update or hand off; restart the root')
    return next()
  }, { global: true, prepend: true })
  return {
    async mount(plugin, captured) {
      const callback = ctx.registry.resolve(plugin)
      if (!callback || ticket || child) throw new Error('Invalid startup child ticket')
      const expected = { callback, parent: owner, raw: undefined as Fiber | undefined, captured }
      ticket = expected
      try {
        const wrapper = ctx.plugin(plugin)
        if (!expected.raw) throw new Error('Startup child publication was not captured')
        await wrapper
        return expected.raw
      } finally { ticket = undefined }
    },
  }
}
