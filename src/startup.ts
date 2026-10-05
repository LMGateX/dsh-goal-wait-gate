import type { Context, Fiber } from '@deepseek-ai/cordis'
import { assertNoOwner, watchOwners, claimLifetime, assertRootRealm, markStartupCallback } from './driver/ownership.ts'
import { installNativeDriver } from './driver/native-driver.ts'
import { createBackgroundPolicy } from './driver/background-work.ts'
import { GoalWaitGate } from './gate.ts'
import { assertHostVersion } from './driver/host-version.ts'
import { resolveStartupConfig, type StartupConfig } from './startup-config.ts'
export type { StartupConfig } from './startup-config.ts'
export { getStartupState } from './driver/ownership.ts'

// Import the original module, not an apply wrapper: registry identity is its callback.
const importModule = () => import('@deepseek-ai/dsh-goal-round-driver')
export const name = 'goal-wait-startup'
export const inject = ['agents', 'goals', 'sessions', 'jobs']
export async function apply(ctx: Context, config: StartupConfig = {}): Promise<void> {
  const resolved = resolveStartupConfig(config)
  assertRootRealm(ctx)
  const profile = await assertHostVersion(ctx)
  const native = await importModule()
  assertRootRealm(ctx)
  assertNoOwner(ctx, native.apply)
  if (ctx.agents.list().length) throw new Error('Startup requires an empty agent registry')
  const state = claimLifetime(ctx, resolved.strategy, { distribution: profile.distribution, cordis: profile.cordis, driverSha256: profile.driverSha256 })
  const agents = ctx.agents
  const goals = ctx.goals
  const gate = resolved.strategy === 'activation' ? new GoalWaitGate(ctx, resolved) : undefined
  let driver: { stop(): Promise<void> } | undefined
  let child: Fiber | undefined
  let stopping = false
  const close = (error?: Error): Promise<void> => {
    if (error) { state.error = error; state.status = 'failed'; ctx.root.logger.error(error) }
    if (stopping) return state.cleanup ?? Promise.resolve()
    stopping = true // Revoke before any await or concurrent Cordis disposer.
    const completion = Promise.withResolvers<void>()
    state.cleanup = completion.promise
    if (!error) state.status = 'closing'
    gate?.closeWithoutRearm()
    const errors: unknown[] = []
    for (const agent of agents.list()) {
      try { goals.disarm(agent) } catch (reason) { errors.push(reason) }
    }
    let drain: Promise<void> | undefined
    try { drain = driver?.stop() } catch (reason) { errors.push(reason) }
    void (async () => {
      try { await drain } catch (reason) { errors.push(reason) }
      if (child) {
        try { await child.dispose(); await child.await() } catch (reason) { errors.push(reason) }
      }
      if (errors.length) {
        state.status = 'failed'
        state.error = new AggregateError(errors, 'Managed startup cleanup failed')
        throw state.error
      }
      // Original native has no explicit stop/error boundary. Cordis may have
      // swallowed native or arbitrary nested effect failures during disposal.
      if (state.status !== 'failed') state.status = state.cleanupIntegrity === 'unverified-native' ? 'closed-unverified' : 'closed'
    })().then(completion.resolve, completion.reject)
    return completion.promise
  }
  const ownership = watchOwners(ctx, native.apply, close)
  await ctx.effect(async () => {
    try {
      if (gate) {
        ctx.on('agent/turn-stopping', ({ agent }) => gate.evaluate(agent), { prepend: true })
        ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') gate.evaluate(agent) }, { prepend: true })
        ctx.on('goal/changed', ({ agent }) => gate.evaluate(agent), { prepend: true })
        ctx.on('agent/disposed', ({ agent }) => gate.forget(agent))
      }
      if (resolved.strategy === 'native') await ownership.mount(native, fiber => { child = fiber })
      else if (resolved.strategy !== 'off') {
        await ownership.mount({
          name: resolved.strategy === 'replacement' ? 'goal-wait-owned-replacement-driver' : 'goal-wait-owned-native-compatible-driver',
          apply(driverCtx: Context) {
            driver = installNativeDriver(driverCtx, resolved.strategy === 'replacement' ? createBackgroundPolicy(driverCtx, resolved) : undefined, profile.driver)
          },
        }, fiber => { child = fiber })
      }
      if (stopping) { await close(); throw state.error ?? new Error('Startup owner closed during child mounting') }
      state.status = 'active'
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error('Startup child failed', { cause: reason })
      await close(error)
      throw error
    }
    // Collected last: latch/drain runs before nested child and checkpoint removals.
    return () => close()
  }, 'managed startup composite')
}
markStartupCallback(apply)
export const goalWaitStartup = { name, inject, apply }
