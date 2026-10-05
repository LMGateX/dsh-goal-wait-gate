#!/usr/bin/env node
/**
 * Startup host type gate: typecheck the managed startup sources against the
 * declarations of a DSH installation that already exists on this machine.
 *
 * Nothing is installed, downloaded or written outside `.host-compat/`, and the
 * provided installation is only read through symlinks. The script reports
 * whether that installation identity is one of the pinned host profiles.
 *
 * The native test fixture is dev infrastructure pinned to the repository's own
 * dev dependencies; this gate checks the shipped `src/` against a host instead.
 *
 * Usage: node scripts/check-startup-host.ts <DSH installation root or directory containing @deepseek-ai/*> [--allow-unpinned]
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supportedHosts } from '../src/driver/host-version.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [argument, ...flags] = process.argv.slice(2)
if (argument === undefined) {
  console.error('usage: node scripts/check-startup-host.ts <directory containing @deepseek-ai/*> [--allow-unpinned]')
  process.exit(2)
}
const provided = resolve(argument)
const driverIsHere = (directory: string) => existsSync(join(directory, 'dsh-goal-round-driver', 'package.json')) && existsSync(join(directory, 'dsh-goal-round-driver', 'lib', 'index.js'))
const hostPackages = [join(provided, '@deepseek-ai'), join(provided, 'node_modules', '@deepseek-ai'), provided].find(driverIsHere)
if (hostPackages === undefined) {
  console.error('not a DSH host installation or @deepseek-ai package directory: ' + provided)
  process.exit(2)
}
const driver = join(hostPackages, 'dsh-goal-round-driver')

const identity: unknown = JSON.parse(await readFileJSON(join(driver, 'package.json')))
if (identity === null || typeof identity !== 'object' || !('name' in identity) || identity.name !== '@deepseek-ai/dsh-goal-round-driver' || !('version' in identity) || typeof identity.version !== 'string') {
  console.error('unreadable goal driver metadata in ' + driver)
  process.exit(2)
}
const version = identity.version
const sha256 = createHash('sha256').update(readFileSync(join(driver, 'lib', 'index.js'))).digest('hex')
const profile = supportedHosts.find(candidate => candidate.distribution === version && candidate.driverSha256 === sha256)
console.log('host driver:   ' + version + ' ' + sha256)
console.log('pinned:        ' + (profile === undefined ? 'NONE' : profile.distribution + ' ' + JSON.stringify(profile.driver)))
if (profile === undefined && !flags.includes('--allow-unpinned')) {
  console.error('refusing to treat this as a supported host; pass --allow-unpinned to typecheck it anyway')
  process.exit(1)
}

const tag = version.replace(/[^a-z0-9]/gi, '-') + '-' + sha256.slice(0, 12)
const work = join(ROOT, '.host-compat', 'startup-' + tag)
rmSync(work, { recursive: true, force: true })
mkdirSync(join(work, 'node_modules', '@deepseek-ai'), { recursive: true })
let linked = 0
for (const entry of readdirSync(hostPackages, { withFileTypes: true })) {
  const source = join(hostPackages, entry.name)
  if (!existsSync(join(source, 'package.json'))) continue
  symlinkSync(source, join(work, 'node_modules', '@deepseek-ai', entry.name), 'dir')
  linked++
}
cpSync(join(ROOT, 'src'), join(work, 'src'), { recursive: true })
writeFileSync(join(work, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.json', include: ['src/**/*.ts'] }, null, 2) + '\n')
console.log('typechecking:  ' + linked + ' host package links')
execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', join(work, 'tsconfig.json')], { cwd: work, stdio: 'inherit' })
console.log('OK: startup sources typecheck against ' + version)

async function readFileJSON(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}
