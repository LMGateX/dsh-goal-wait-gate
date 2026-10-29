import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { NativeFixture, startBackgroundChild } from './native-fixture.ts'
import { getStartupState } from '../src/startup.ts'
import { matchHostProfile, supportedHosts, type HostFacts, type HostProfile } from '../src/driver/host-version.ts'
import * as NativeDriver from '@deepseek-ai/dsh-goal-round-driver'

const profileFor = (distribution: string): HostProfile => {
  const profile = supportedHosts.find(candidate => candidate.distribution === distribution)
  assert.ok(profile, 'pinned host ' + distribution)
  return profile
}
const baseline = profileFor('0.2.0-rc.2')
const alpha = profileFor('0.2.1-alpha.1')
const alpha2 = profileFor('0.2.1-alpha.2')
const alpha3 = profileFor('0.2.1-alpha.3')
const alpha4 = profileFor('0.2.1-alpha.4')
const rc1 = profileFor('0.2.1-rc.1')
const rc2 = profileFor('0.2.1-rc.2')
const alpha22 = profileFor('0.2.2-alpha.2')

/** Pinned profile of the host this suite really runs on; the same suite must pass on each. */
function detectInstalledProfile(): HostProfile {
  const require = createRequire(import.meta.url)
  const metadata: unknown = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-goal-round-driver/package.json'), 'utf8'))
  const version = metadata !== null && typeof metadata === 'object' && 'version' in metadata ? String(metadata.version) : 'unknown'
  const sha256 = crypto.createHash('sha256').update(readFileSync(require.resolve('@deepseek-ai/dsh-goal-round-driver'))).digest('hex')
  const profile = supportedHosts.find(candidate => candidate.distribution === version && candidate.driverSha256 === sha256)
  assert.ok(profile, 'pinned installed host ' + version + ' ' + sha256)
  return profile
}
const installed = detectInstalledProfile()

function facts(profile: HostProfile, overrides: Record<string, string> = {}): HostFacts {
  return {
    versions: { '@deepseek-ai/cordis': profile.cordis, '@deepseek-ai/dsh-goal-round-driver': profile.distribution, ...overrides },
    driverSha256: profile.driverSha256,
  }
}

/**
 * Present one exact published host identity over the real installed artifacts:
 * every participating package version, plus the resolved driver fingerprint.
 * Only the identity is simulated; the driver behavior under test is the port.
 */
function simulateHost(t: TestContext, profile: HostProfile): void {
  const originalReadFile = fsPromises.readFile
  t.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof originalReadFile>) => {
    const matched = /@deepseek-ai\/([^/\\]+)\/package\.json$/.exec(String(args[0]))
    if (matched === null) return originalReadFile(...args)
    const name = '@deepseek-ai/' + matched[1]
    return JSON.stringify({ name, version: name === '@deepseek-ai/cordis' ? profile.cordis : profile.distribution })
  })
  const originalCreateHash = crypto.createHash
  t.mock.method(crypto, 'createHash', ((algorithm: string) => {
    const real = originalCreateHash(algorithm)
    let seen = ''
    const wrapper = {
      update(chunk: unknown) { seen += String(chunk); real.update(chunk as never); return wrapper },
      digest() { return seen.includes('goal-round-driver') ? profile.driverSha256 : real.digest('hex') },
    }
    return wrapper as unknown as crypto.Hash
  }) as typeof crypto.createHash)
  syncBuiltinESMExports()
}

/** Cancel a freshly reserved round with keepInbox and report what the inbox retained. */
async function cancelQueuedRound(h: NativeFixture): Promise<{ parked: boolean }> {
  let cancelled = false
  h.ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running' && !cancelled) { cancelled = true; agent.cancel({ kind: 'user' }, { keepInbox: true }) }
  })
  h.createGoal(3)
  await h.until(() => cancelled && h.agent.status === 'idle', 'kept queued round after cancellation')
  await h.settle()
  return { parked: h.agent.inbox.nextTurn.some(message => message.source.kind === 'goal') }
}

test('artifact identity selects the exact ported behavior of that pinned host', () => {
  assert.deepEqual(matchHostProfile(facts(baseline)).driver, { removeCancelledQueuedMessage: false, joinsProgressingDescendants: false })
  assert.deepEqual(matchHostProfile(facts(alpha)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: false })
  assert.deepEqual(matchHostProfile(facts(alpha2)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: false })
  assert.deepEqual(matchHostProfile(facts(alpha3)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: true })
  assert.deepEqual(matchHostProfile(facts(alpha4)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: true })
  assert.deepEqual(matchHostProfile(facts(rc1)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: true })
  assert.deepEqual(matchHostProfile(facts(rc2)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: true })
  assert.deepEqual(matchHostProfile(facts(alpha22)).driver, { removeCancelledQueuedMessage: true, joinsProgressingDescendants: true })
  assert.equal(matchHostProfile(facts(alpha, { '@deepseek-ai/dsh-session': alpha.distribution })).distribution, '0.2.1-alpha.1')
})

test('a byte-identical republish is a new identity with the same ported behavior', () => {
  // 0.2.1-alpha.2 republishes the alpha.1 driver, 0.2.1-alpha.4 republishes the
  // alpha.3 driver and 0.2.1-rc.2 republishes the rc.1 driver; each is still its
  // own pinned identity, and a host that self-reports one of them must be
  // admitted with that artifact's behavior.
  for (const [republish, original] of [[alpha2, alpha], [alpha4, alpha3], [rc2, rc1]] as const) {
    assert.notEqual(republish.distribution, original.distribution)
    assert.equal(republish.driverSha256, original.driverSha256)
    assert.equal(republish.cordis, original.cordis)
    assert.deepEqual(republish.driver, original.driver)
    assert.deepEqual(matchHostProfile(facts(republish)).driver, original.driver)
  }
  // 0.2.1-rc.1 republishes the alpha.4 driver, but Cordis graduated to the
  // stable 4.0.5 release in the same step, so it cannot be paired with alpha.4
  // in the loop above; 0.2.1-rc.2 republishes rc.1 and joins that loop.
  assert.notEqual(rc1.distribution, alpha4.distribution)
  assert.equal(rc1.driverSha256, alpha4.driverSha256)
  assert.notEqual(rc1.cordis, alpha4.cordis)
  assert.deepEqual(matchHostProfile(facts(rc1)).driver, alpha4.driver)
  // 0.2.2-alpha.2 republishes the rc.1/rc.2 driver while Cordis moves to the
  // 4.0.6 alpha line: a new identity with the same ported behavior.
  assert.notEqual(alpha22.distribution, rc2.distribution)
  assert.equal(alpha22.driverSha256, rc2.driverSha256)
  assert.notEqual(alpha22.cordis, rc2.cordis)
  assert.deepEqual(matchHostProfile(facts(alpha22)).driver, rc2.driver)
  // The fingerprint identifies the artifact, the version identifies the
  // distribution: a republish under an unpinned version is still refused.
  assert.throws(
    () => matchHostProfile({ ...facts(alpha4), versions: { ...facts(alpha4).versions, '@deepseek-ai/dsh-goal-round-driver': '0.2.1-alpha.5' } }),
    /unsupported @deepseek-ai\/dsh-goal-round-driver version 0\.2\.1-alpha\.5/,
  )
})

test('an unpinned distribution version is refused instead of borrowing a port', () => {
  assert.throws(() => matchHostProfile(facts(alpha, { '@deepseek-ai/dsh-goal-round-driver': '0.2.2-alpha.0' })), /unsupported.*0\.2\.2-alpha\.0/)
})

test('a matching version without the exact bundle fingerprint is refused', () => {
  assert.throws(() => matchHostProfile({ ...facts(alpha), driverSha256: baseline.driverSha256 }), /fingerprint/)
})

test('a mixed first-party version inside one distribution is refused', () => {
  assert.throws(() => matchHostProfile(facts(baseline, { '@deepseek-ai/dsh-goal': '0.2.0-rc.3' })), /version mismatch.*dsh-goal/)
  assert.throws(() => matchHostProfile(facts(baseline, { '@deepseek-ai/cordis': '4.0.5-alpha.1' })), /version mismatch.*cordis/)
})

test('the installed pinned host is detected and keeps its own published queued-round behavior', async () => {
  const h = await new NativeFixture().initialize()
  try {
    assert.equal(getStartupState(h.ctx)?.host?.distribution, installed.distribution)
    assert.equal(getStartupState(h.ctx)?.host?.driverSha256, installed.driverSha256)
    const observed = await cancelQueuedRound(h)
    assert.equal(observed.parked, !installed.driver.removeCancelledQueuedMessage)
    assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { await h.dispose() }
})

test('a pinned 0.2.1-alpha.1 identity is detected and retires the unclaimed queued round', async t => {
  simulateHost(t, alpha)
  const h = await new NativeFixture().initialize()
  try {
    assert.equal(getStartupState(h.ctx)?.host?.distribution, '0.2.1-alpha.1')
    assert.equal(getStartupState(h.ctx)?.host?.driverSha256, alpha.driverSha256)
    const observed = await cancelQueuedRound(h)
    assert.equal(observed.parked, false)
    assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('a pinned 0.2.1-alpha.2 identity is detected and retires the unclaimed queued round', async t => {
  simulateHost(t, alpha2)
  const h = await new NativeFixture().initialize()
  try {
    assert.equal(getStartupState(h.ctx)?.host?.distribution, '0.2.1-alpha.2')
    assert.equal(getStartupState(h.ctx)?.host?.driverSha256, alpha2.driverSha256)
    // The distribution moved while the native driver bundle did not, so the
    // ported behavior is the one already pinned for 0.2.1-alpha.1.
    assert.equal(alpha2.driverSha256, alpha.driverSha256)
    assert.equal(alpha2.driver.removeCancelledQueuedMessage, alpha.driver.removeCancelledQueuedMessage)
    const observed = await cancelQueuedRound(h)
    assert.equal(observed.parked, false)
    assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('a pinned 0.2.1-rc.1 identity is detected and retires the unclaimed queued round', async t => {
  simulateHost(t, rc1)
  const h = await new NativeFixture().initialize()
  try {
    assert.equal(getStartupState(h.ctx)?.host?.distribution, '0.2.1-rc.1')
    assert.equal(getStartupState(h.ctx)?.host?.driverSha256, rc1.driverSha256)
    // The release candidate republishes the alpha.3/alpha.4 driver under the
    // stable Cordis release, so the queued-round behavior carries over.
    assert.equal(rc1.driverSha256, alpha4.driverSha256)
    assert.equal(rc1.driver.removeCancelledQueuedMessage, alpha4.driver.removeCancelledQueuedMessage)
    const observed = await cancelQueuedRound(h)
    assert.equal(observed.parked, false)
    assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})
test('a pinned 0.2.2-alpha.2 identity is detected and retires the unclaimed queued round', async t => {
  simulateHost(t, alpha22)
  const h = await new NativeFixture().initialize()
  try {
    assert.equal(getStartupState(h.ctx)?.host?.distribution, '0.2.2-alpha.2')
    assert.equal(getStartupState(h.ctx)?.host?.driverSha256, alpha22.driverSha256)
    // The new distribution moves Cordis but republishes the rc.1/rc.2 driver,
    // so the queued-round behavior carries over unchanged.
    assert.equal(alpha22.driverSha256, rc2.driverSha256)
    assert.equal(alpha22.driver.removeCancelledQueuedMessage, rc2.driver.removeCancelledQueuedMessage)
    const observed = await cancelQueuedRound(h)
    assert.equal(observed.parked, false)
    assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 0)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('an unpinned newer host is refused before any driver is mounted', async t => {
  simulateHost(t, { ...alpha, distribution: '0.2.2-alpha.0' })
  const h = new NativeFixture()
  try {
    await assert.rejects(h.initialize(), /unsupported/)
    assert.equal(getStartupState(h.ctx), undefined)
    assert.equal(h.ctx.registry.has(NativeDriver), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('a version match without the pinned bundle fingerprint is refused at startup', async t => {
  simulateHost(t, { ...alpha, driverSha256: baseline.driverSha256 })
  const h = new NativeFixture()
  try {
    await assert.rejects(h.initialize(), /fingerprint/)
    assert.equal(getStartupState(h.ctx), undefined)
    assert.equal(h.ctx.registry.has(NativeDriver), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

/**
 * Publish the 0.2.1-alpha.3 subagent seam over the installed (older) subagent
 * package: a real installation of that distribution ships it, while this pinned
 * development host predates it. The join resolves only once every delegated
 * child has stopped progressing.
 */
function publishDescendantJoin(ctx: import('@deepseek-ai/cordis').Context): void {
  const runtime = ctx.get('subagents') as unknown as { waitForChildren?: (parent: import('@deepseek-ai/dsh-agent').Agent) => Promise<boolean> }
  runtime.waitForChildren = async (parent: import('@deepseek-ai/dsh-agent').Agent): Promise<boolean> => {
    let joined = false
    for (const agent of ctx.agents.list()) {
      if (agent === parent || agent.session.header.parentSession === undefined) continue
      joined = true
      await agent.whenIdle()
    }
    return joined
  }
}

/**
 * One real scenario on two pinned identities: an armed goal on a parent that
 * delegated to a child which is still progressing. The background policy is
 * switched off in both arms, so only the port's own published behavior is
 * observed; only 0.2.1-alpha.3 publishes the descendant join.
 */
async function progressingDescendant(t: TestContext, profile: HostProfile): Promise<{ h: NativeFixture; release: () => void }> {
  simulateHost(t, profile)
  const release = Promise.withResolvers<void>()
  let child: import('@deepseek-ai/dsh-agent').Agent | undefined
  const h = await new NativeFixture({
    children: true,
    config: { strategy: 'replacement', waitForJobs: false, waitForSubagents: false },
    beforeStartup: async ctx => { publishDescendantJoin(ctx) },
    onCall: async (fixture, call) => {
      if (call.agent === fixture.agent && call.index === 1) {
        void startBackgroundChild(fixture.ctx, {
          provider: 'spawn',
          label: 'Synthetic descendant',
          request: { parent: fixture.agent, prompt: [{ type: 'text', text: 'Synthetic descendant' }], maxDepth: 2 },
          signal: new AbortController().signal,
        })
        // The delegation materializes asynchronously. Hold the human turn open
        // until the child is a live running Agent, so the idle drive that
        // follows meets a descendant rather than an empty registry.
        await fixture.until(() => child !== undefined, 'delegated child materialized')
        return
      }
      if (call.agent !== fixture.agent) {
        child = call.agent
        // The predicate is already satisfied by the time this call blocks, so
        // the harness has to be told to re-check it.
        fixture.changed()
        await release.promise
      }
    },
  }).initialize()
  h.human()
  h.createGoal()
  await h.until(() => h.agent.status === 'idle', 'idle parent beside a progressing descendant')
  await h.ctx.sessions.flush(h.agent.session)
  await h.settle()
  return { h, release: () => release.resolve() }
}

test('a pinned 0.2.1-alpha.3 host withholds the round while a descendant progresses', async t => {
  const run = await progressingDescendant(t, alpha3)
  try {
    assert.equal(run.h.goal?.activation, 'armed')
    assert.equal(run.h.goal?.roundsStarted, 0)
    assert.equal(run.h.mainCalls, 1)
    run.release()
    await run.h.until(() => (run.h.goal?.roundsStarted ?? 0) >= 1, 'round admitted after the descendant settled')
  } finally { run.release(); t.mock.restoreAll(); syncBuiltinESMExports(); await run.h.dispose() }
})

test('an earlier pinned host without the join reserves the round while a descendant progresses', async t => {
  const run = await progressingDescendant(t, alpha2)
  try {
    assert.equal(run.h.goal?.activation, 'armed')
    await run.h.until(() => run.h.goal?.roundsStarted === 1, 'round admitted beside a progressing descendant')
  } finally { run.release(); t.mock.restoreAll(); syncBuiltinESMExports(); await run.h.dispose() }
})
