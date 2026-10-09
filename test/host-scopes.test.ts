/**
 * Host-scope resolution: the bug this suite exists for was a plugin that read
 * its own auto-installed peer copies (cordis 4.0.4, dsh-agent 0.1.7-rc.2) as if
 * they were the host, so every pinned host looked unpinned and the ported driver
 * silently fell back to the disarming gate.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { hostScopes, readHostFactSets } from '../src/driver/host-version.ts'

/** Packages whose exact version the identity check reads. */
const REQUIRED = ['dsh-agent', 'dsh-agent-loop', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-session', 'dsh-session-projection', 'dsh-llm', 'dsh-system-prompt', 'dsh-tools', 'dsh-tool-goal', 'dsh-jobs', 'dsh-jobs-local', 'dsh-tool-jobs', 'dsh-scope']

function publish(modules: string, name: string, version: string): void {
  const directory = join(modules, name)
  mkdirSync(directory, { recursive: true })
  const entry = name === 'dsh-goal-round-driver' ? { main: 'index.js' } : {}
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version, ...entry }))
  if (name === 'dsh-goal-round-driver') writeFileSync(join(directory, 'index.js'), 'pinned bundle')
}

test('scopes run outward first and end with the plugin own tree', () => {
  assert.deepEqual(hostScopes('/a/b/node_modules/plugin'), [
    '/a/b/node_modules/package.json',
    '/a/b/package.json',
    '/a/package.json',
    '/a/b/node_modules/plugin/package.json',
  ])
})

test('the host scope speaks before stale copies inside the plugin', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-scope-'))
  const hostModules = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai')
  const plugin = join(home, 'profiles', 'web', 'node_modules', 'dsh-goal-wait-gate')
  const staleModules = join(plugin, 'node_modules', '@deepseek-ai')
  for (const name of ['cordis', ...REQUIRED]) {
    publish(hostModules, name, name === 'cordis' ? '4.0.5-alpha.1' : '0.2.1-alpha.1')
    publish(staleModules, name, name === 'cordis' ? '4.0.4' : '0.1.7-rc.2')
  }
  // No realm families mounted: only the required packages participate.
  const ctx = { get: () => undefined } as unknown as Context
  const sets = await readHostFactSets(ctx, plugin)
  assert.ok(sets.length >= 2, 'both identities should be reachable')
  assert.equal(sets[0]?.versions['@deepseek-ai/cordis'], '4.0.5-alpha.1')
  assert.equal(sets[0]?.versions['@deepseek-ai/dsh-agent'], '0.2.1-alpha.1')
  assert.ok(sets.some(set => set.versions['@deepseek-ai/dsh-agent'] === '0.1.7-rc.2'), 'the plugin own tree stays the last resort')
})
