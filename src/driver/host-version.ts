import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { DriverBehavior } from './native-driver.ts'

const require = createRequire(import.meta.url)

/**
 * Published-artifact identity of one supported DSH host, together with the
 * ported native behavior that exact artifact ships. A version string alone is
 * not enough: the bundle fingerprint selects the behavior, so a republished or
 * patched artifact can never silently reuse a port written for another one.
 */
export interface HostProfile {
  /** Version shared by every first-party package of this distribution. */
  readonly distribution: string
  /** Exact Cordis version shipped with that distribution. */
  readonly cordis: string
  /** SHA-256 of the goal-round-driver bundle this port is derived from. */
  readonly driverSha256: string
  /** Ported native behavior selected by that artifact identity. */
  readonly driver: DriverBehavior
}

/** Every host this managed driver is ported and pinned against, oldest first. */
export const supportedHosts: readonly HostProfile[] = [
  {
    distribution: '0.2.0-rc.2',
    cordis: '4.0.4',
    driverSha256: '3bca01a2e87de1683fa8b55ad54688eefc4e366c971c20e9afd654db3b5ab450',
    driver: { removeCancelledQueuedMessage: false },
  },
  {
    distribution: '0.2.1-alpha.1',
    cordis: '4.0.5-alpha.1',
    driverSha256: '68ed09208a7abe4e8722bc0e6ac666383046ed37dc8a4e6a0795234317c69cf8',
    driver: { removeCancelledQueuedMessage: true },
  },
  // 0.2.1-alpha.2 moves the distribution version while publishing the very same
  // native goal driver bundle (identical SHA-256, identical Cordis), so the
  // ported behavior carries over unchanged; only the identity grows a row.
  {
    distribution: '0.2.1-alpha.2',
    cordis: '4.0.5-alpha.1',
    driverSha256: '68ed09208a7abe4e8722bc0e6ac666383046ed37dc8a4e6a0795234317c69cf8',
    driver: { removeCancelledQueuedMessage: true },
  },
]

/** Packages whose exact version must equal the detected distribution version. */
const requiredPackages = ['dsh-agent', 'dsh-agent-loop', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-goal', 'dsh-jobs', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-scope']

/** Companions published beside the driver by some distributions and folded away by later ones. */
const companionPackages = ['dsh-invariants']

/** Artifact facts read from the installed host; never a caller supplied version claim. */
export interface HostFacts {
  /** Exact version of every participating package that is part of this host. */
  readonly versions: Readonly<Record<string, string>>
  /** SHA-256 of the exactly resolved native goal driver bundle. */
  readonly driverSha256: string
}

/** Read one installed package version, rejecting metadata that is not that package. */
async function readPackageVersion(packageName: string): Promise<string> {
  // Fresh filesystem data, with no per-check JSON modules retained in ESM's cache.
  const metadata: unknown = JSON.parse(await readFile(require.resolve(packageName + '/package.json'), 'utf8'))
  if (metadata === null || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) || metadata.name !== packageName || typeof metadata.version !== 'string') throw new Error('Startup compatibility: unreadable package metadata for ' + packageName)
  return metadata.version
}

/** Read the exact participating artifacts of this realm. */
export async function readHostFacts(ctx: Context): Promise<HostFacts> {
  const versions: Record<string, string> = {}
  for (const shortName of ['cordis', ...requiredPackages]) versions['@deepseek-ai/' + shortName] = await readPackageVersion('@deepseek-ai/' + shortName)
  // Realm families participate exactly when their service is mounted; the
  // packages of an inactive family are not part of this host's continuation path.
  const families: readonly (readonly [boolean, readonly string[]])[] = [
    [ctx.get('subagents') !== undefined, ['dsh-subagent', 'dsh-subagent-in-process-driver', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process', 'dsh-tool-subagent', 'dsh-session-persistence', 'dsh-session-persistence-jsonl']],
    [ctx.get('sessionQuery') !== undefined, ['dsh-session-query', 'dsh-session-query-sqlite']],
  ]
  for (const [participating, packageShortNames] of families) {
    if (!participating) continue
    for (const shortName of packageShortNames) versions['@deepseek-ai/' + shortName] = await readPackageVersion('@deepseek-ai/' + shortName)
  }
  // Companions are detected beside the resolved driver, not by module lookup, so
  // a mixed or hoisted tree can neither hide nor borrow a companion.
  const driverDirectory = dirname(require.resolve('@deepseek-ai/dsh-goal-round-driver/package.json'))
  for (const shortName of companionPackages) {
    if (!existsSync(join(driverDirectory, shortName, 'package.json'))) continue
    versions['@deepseek-ai/' + shortName] = await readPackageVersion('@deepseek-ai/' + shortName)
  }
  const published = await readFile(require.resolve('@deepseek-ai/dsh-goal-round-driver'))
  return { versions, driverSha256: createHash('sha256').update(published).digest('hex') }
}

/** Pure artifact-identity match; the only place a host profile may be selected. */
export function matchHostProfile(facts: HostFacts): HostProfile {
  const anchor = facts.versions['@deepseek-ai/dsh-goal-round-driver']
  const profile = supportedHosts.find(candidate => candidate.distribution === anchor)
  if (profile === undefined) throw new Error('Startup compatibility: unsupported @deepseek-ai/dsh-goal-round-driver version ' + (anchor ?? 'unknown'))
  if (profile.driverSha256 !== facts.driverSha256) throw new Error('Startup compatibility source fingerprint mismatch for native goal driver ' + profile.distribution)
  for (const [packageName, version] of Object.entries(facts.versions)) {
    if (packageName === '@deepseek-ai/dsh-goal-round-driver') continue
    const expected = packageName === '@deepseek-ai/cordis' ? profile.cordis : profile.distribution
    if (version !== expected) throw new Error('Startup compatibility version mismatch: ' + packageName + ' requires ' + expected)
  }
  return profile
}

/** Detect and validate the exact published host this realm runs on. */
export async function assertHostVersion(ctx: Context): Promise<HostProfile> {
  return matchHostProfile(await readHostFacts(ctx))
}
