import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
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

/** One scope able to resolve the host's own packages. */
type ModuleResolver = (id: string) => string

/**
 * Scopes this plugin may read the host's artifacts from, nearest host first.
 *
 * A published plugin is installed *inside* the host's profile, and pnpm
 * auto-installs its declared peer dependencies there — which is how a plugin
 * folder ends up carrying stale copies (cordis 4.0.4 beside a 4.0.5-alpha.1
 * runtime, dsh-agent 0.1.7-rc.2 beside 0.2.1-alpha.1). Reading the host identity
 * from the plugin's own tree therefore describes those copies, not the host, and
 * every pinned host looks unpinned. Walking outwards first reads the profile's
 * scope — what the host itself resolves — and the plugin's own tree stays the
 * last resort, for an in-tree host that genuinely shares it.
 *
 * @param root - absolute path of this plugin's package directory.
 * @returns resolution anchors, outermost first, the plugin's own tree last.
 */
export function hostScopes(root: string): readonly string[] {
  const scopes: string[] = []
  let directory = dirname(root)
  while (directory !== dirname(directory)) {
    scopes.push(join(directory, 'package.json'))
    directory = dirname(directory)
  }
  return [...scopes, join(root, 'package.json')]
}

/** The package directory this module was published in. */
function pluginRoot(): string {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))))
}

/** Read one installed package version, rejecting metadata that is not that package. */
async function readPackageVersion(resolve: ModuleResolver, packageName: string): Promise<string> {
  // Fresh filesystem data, with no per-check JSON modules retained in ESM's cache.
  const metadata: unknown = JSON.parse(await readFile(resolve(packageName + '/package.json'), 'utf8'))
  if (metadata === null || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) || metadata.name !== packageName || typeof metadata.version !== 'string') throw new Error('Startup compatibility: unreadable package metadata for ' + packageName)
  return metadata.version
}

/** Read the exact participating artifacts visible from one scope. */
async function readFactsFrom(ctx: Context, resolve: ModuleResolver): Promise<HostFacts> {
  const versions: Record<string, string> = {}
  for (const shortName of ['cordis', ...requiredPackages]) versions['@deepseek-ai/' + shortName] = await readPackageVersion(resolve, '@deepseek-ai/' + shortName)
  // Realm families participate exactly when their service is mounted; the
  // packages of an inactive family are not part of this host's continuation path.
  const families: readonly (readonly [boolean, readonly string[]])[] = [
    [ctx.get('subagents') !== undefined, ['dsh-subagent', 'dsh-subagent-in-process-driver', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process', 'dsh-tool-subagent', 'dsh-session-persistence', 'dsh-session-persistence-jsonl']],
    [ctx.get('sessionQuery') !== undefined, ['dsh-session-query', 'dsh-session-query-sqlite']],
  ]
  for (const [participating, packageShortNames] of families) {
    if (!participating) continue
    for (const shortName of packageShortNames) {
      try {
        versions['@deepseek-ai/' + shortName] = await readPackageVersion(resolve, '@deepseek-ai/' + shortName)
      } catch {
        // A family package a distribution no longer publishes must not void the
        // whole scope. 0.2.1-alpha.2 dropped dsh-subagent-in-process-driver, and
        // treating that as a broken scope left every pinned host unreachable.
        continue
      }
    }
  }
  // Companions are detected beside the resolved driver, not by module lookup, so
  // a mixed or hoisted tree can neither hide nor borrow a companion.
  const driverDirectory = dirname(resolve('@deepseek-ai/dsh-goal-round-driver/package.json'))
  for (const shortName of companionPackages) {
    if (!existsSync(join(driverDirectory, shortName, 'package.json'))) continue
    versions['@deepseek-ai/' + shortName] = await readPackageVersion(resolve, '@deepseek-ai/' + shortName)
  }
  const published = await readFile(resolve('@deepseek-ai/dsh-goal-round-driver'))
  return { versions, driverSha256: createHash('sha256').update(published).digest('hex') }
}

/**
 * Every distinct artifact identity this realm can resolve, nearest host first.
 *
 * A scope that cannot resolve the driver is not a view of a host at all and is
 * dropped; the same identity reachable from several scopes is reported once.
 *
 * @param ctx - realm whose mounted families participate.
 * @param root - plugin directory; defaults to this module's own package.
 * @returns one fact set per distinct identity, outermost scope first.
 */
export async function readHostFactSets(ctx: Context, root: string = pluginRoot()): Promise<readonly HostFacts[]> {
  const sets: HostFacts[] = []
  const seen = new Set<string>()
  for (const anchor of hostScopes(root)) {
    let facts: HostFacts
    try {
      // createRequire returns a loader; the identity reader needs its resolver.
      const anchored = createRequire(anchor)
      facts = await readFactsFrom(ctx, id => anchored.resolve(id))
    } catch {
      continue
    }
    const key = (facts.versions['@deepseek-ai/dsh-goal-round-driver'] ?? 'unknown') + '|' + facts.driverSha256
    if (seen.has(key)) continue
    seen.add(key)
    sets.push(facts)
  }
  return sets
}

/** Read the exact participating artifacts of this realm, from its host scope. */
export async function readHostFacts(ctx: Context): Promise<HostFacts> {
  const first = (await readHostFactSets(ctx))[0]
  if (first !== undefined) return first
  throw new Error('Startup compatibility: no @deepseek-ai/dsh-goal-round-driver artifact resolves from this realm')
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
/**
 * Detect and validate the exact published host this realm runs on.
 *
 * Every scope is tried: a stale copy inside the plugin own tree must not be
 * able to hide a pinned host that the profile scope resolves correctly.
 */
export async function assertHostVersion(ctx: Context): Promise<HostProfile> {
  let failure: unknown
  for (const facts of await readHostFactSets(ctx)) {
    try {
      return matchHostProfile(facts)
    } catch (error) {
      // The outermost scope speaks for the host; keep its verdict for the report.
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
  throw new Error('Startup compatibility: no @deepseek-ai/dsh-goal-round-driver artifact resolves from this realm')
}
