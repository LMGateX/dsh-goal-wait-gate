import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'

const require = createRequire(import.meta.url)
const packages = ['dsh-agent', 'dsh-agent-loop', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-goal', 'dsh-jobs', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-invariants', 'dsh-scope']
/** Published-artifact compatibility, never a caller supplied version claim. */
export async function assertHostVersion(ctx: Context): Promise<void> {
  const participating = [...packages]
  if (ctx.get('subagents') !== undefined) participating.push('dsh-subagent', 'dsh-subagent-in-process-driver', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process', 'dsh-tool-subagent', 'dsh-session-persistence', 'dsh-session-persistence-jsonl')
  if (ctx.get('sessionQuery') !== undefined) participating.push('dsh-session-query', 'dsh-session-query-sqlite')
  for (const shortName of ['cordis', ...participating]) {
    const packageName = '@deepseek-ai/' + shortName
    const expected = shortName === 'cordis' ? '4.0.4' : '0.2.0-rc.2'
    try {
      // Fresh filesystem data, with no per-check JSON modules retained in ESM's cache.
      const metadata: unknown = JSON.parse(await readFile(require.resolve(packageName + '/package.json'), 'utf8'))
      if (metadata === null || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) || metadata.name !== packageName || metadata.version !== expected) throw new Error('mismatch')
    } catch { throw new Error('Startup compatibility version mismatch: ' + packageName + ' requires ' + expected) }
  }
  const published = await readFile(require.resolve('@deepseek-ai/dsh-goal-round-driver'))
  if (createHash('sha256').update(published).digest('hex') !== '3bca01a2e87de1683fa8b55ad54688eefc4e366c971c20e9afd654db3b5ab450') throw new Error('Startup compatibility source fingerprint mismatch for native goal driver')
}
