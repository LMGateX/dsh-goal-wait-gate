#!/usr/bin/env node
/**
 * Dry-run the documented profile patch against the local profile composition.
 *
 * The real profile is only read, and only through copies/symlinks inside this
 * repository: the script builds an isolated DSH home under `.patch-check/`,
 * copies the profile's small config files there, symlinks its node_modules,
 * applies the README's patch overlay with `dsh --dump-config`, and asserts
 * that the composed tree contains this plugin while the official goal-round
 * driver is still mounted.
 *
 * No running server is contacted and no live session state is touched.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const REAL_HOME = process.env.DSH_HOME_REAL ?? join(homedir(), '.dsh')
const REAL_PROFILE = join(REAL_HOME, 'profiles', PROFILE)
const WORK = join(ROOT, '.patch-check')
const ISOLATED_HOME = join(WORK, 'home')
const ISOLATED_PROFILE = join(ISOLATED_HOME, 'profiles', PROFILE)
const PATCH = join(WORK, 'goal-wait-gate.patch.yml')
const DUMP = join(WORK, 'dump.yml')

/** The exact insert the README tells users to add to their profile patch layer. */
const PATCH_BODY = [
  '- insert:',
  '    - id: goal-wait-gate',
  "      name: 'dsh-goal-wait-gate'",
  '      config:',
  '        waitForJobs: true',
  '        waitForSubagents: true',
  '        maxHoldMs: 0',
  '',
].join('\n')

if (!existsSync(REAL_PROFILE)) {
  console.error('no profile at ' + REAL_PROFILE + '; set DSH_HOME_REAL or DSH_PROFILE')
  process.exit(2)
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(ISOLATED_PROFILE, { recursive: true })

// Copy the small profile files and symlink only the dependency tree, which is
// read but never written. Other directories (package-manager state such as
// .plugin-manager) are skipped entirely: the isolated home is built from
// copies, so no live profile file can be reached for writing.
for (const entry of readdirSync(REAL_PROFILE, { withFileTypes: true })) {
  const source = join(REAL_PROFILE, entry.name)
  const target = join(ISOLATED_PROFILE, entry.name)
  if (entry.name === 'node_modules') symlinkSync(source, target)
  else if (!entry.isDirectory()) copyFileSync(source, target)
}

// The patch applied here is the patch the README documents; a drift between
// them fails the check instead of silently verifying different YAML.
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
if (!readme.includes(PATCH_BODY)) {
  console.error('FAIL README.md no longer documents the exact patch this check applies')
  process.exit(1)
}

writeFileSync(PATCH, PATCH_BODY)
process.stdout.write('dsh --profile ' + PROFILE + ' --patch ' + PATCH + ' --dump-config\n')
const dump = execFileSync('dsh', ['--profile', PROFILE, '--patch', PATCH, '--dump-config'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: ISOLATED_HOME },
})
writeFileSync(DUMP, dump)

const failures = []
if (!/^- id: goal-wait-gate\n  name: dsh-goal-wait-gate$/m.test(dump)) {
  failures.push('the composed tree does not contain the goal-wait-gate entry from the documented patch')
}
if (!/^- id: goal-round-driver$/m.test(dump)) {
  failures.push('the official goal-round-driver is missing from the composed tree')
}
if (!dump.includes("name: '@deepseek-ai/dsh-goal-round-driver'")) {
  failures.push('the official goal-round-driver entry does not keep its package name')
}

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL ' + failure)
  process.exit(1)
}
console.log('OK: the documented patch composes this plugin beside the official goal-round-driver')
console.log('    dump: ' + DUMP + ' (isolated home: ' + ISOLATED_HOME + ')')
