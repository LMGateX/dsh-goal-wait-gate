import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { NativeFixture } from './native-fixture.ts'
import { getStartupState } from '../src/startup.ts'
import { matchHostProfile, supportedHosts, type HostFacts, type HostProfile } from '../src/driver/host-version.ts'
import * as NativeDriver from '@deepseek-ai/dsh-goal-round-driver'

const profileFor = (distribution: string): HostProfile => {
  const profile = supportedHosts.find(candidate => candidate.distribution === distribution)
  assert.ok(profile, 'pinned host ' + distribution)
  return profile
}
const rc2 = profileFor('0.2.0-rc.2')
const alpha = profileFor('0.2.1-alpha.1')

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
  assert.deepEqual(matchHostProfile(facts(rc2)).driver, { removeCancelledQueuedMessage: false })
  assert.deepEqual(matchHostProfile(facts(alpha)).driver, { removeCancelledQueuedMessage: true })
  assert.equal(matchHostProfile(facts(alpha, { '@deepseek-ai/dsh-session': alpha.distribution })).distribution, '0.2.1-alpha.1')
})

test('an unpinned distribution version is refused instead of borrowing a port', () => {
  assert.throws(() => matchHostProfile(facts(alpha, { '@deepseek-ai/dsh-goal-round-driver': '0.2.1-alpha.2' })), /unsupported.*0\.2\.1-alpha\.2/)
})

test('a matching version without the exact bundle fingerprint is refused', () => {
  assert.throws(() => matchHostProfile({ ...facts(alpha), driverSha256: rc2.driverSha256 }), /fingerprint/)
})

test('a mixed first-party version inside one distribution is refused', () => {
  assert.throws(() => matchHostProfile(facts(rc2, { '@deepseek-ai/dsh-goal': '0.2.0-rc.3' })), /version mismatch.*dsh-goal/)
  assert.throws(() => matchHostProfile(facts(rc2, { '@deepseek-ai/cordis': '4.0.5-alpha.1' })), /version mismatch.*cordis/)
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

test('an unpinned newer host is refused before any driver is mounted', async t => {
  simulateHost(t, { ...alpha, distribution: '0.2.1-alpha.2' })
  const h = new NativeFixture()
  try {
    await assert.rejects(h.initialize(), /unsupported/)
    assert.equal(getStartupState(h.ctx), undefined)
    assert.equal(h.ctx.registry.has(NativeDriver), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})

test('a version match without the pinned bundle fingerprint is refused at startup', async t => {
  simulateHost(t, { ...alpha, driverSha256: rc2.driverSha256 })
  const h = new NativeFixture()
  try {
    await assert.rejects(h.initialize(), /fingerprint/)
    assert.equal(getStartupState(h.ctx), undefined)
    assert.equal(h.ctx.registry.has(NativeDriver), false)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await h.dispose() }
})
