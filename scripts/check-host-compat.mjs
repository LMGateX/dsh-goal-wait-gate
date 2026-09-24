#!/usr/bin/env node
/**
 * Two-host compatibility gate.
 *
 * For every supported DSH host version this script builds an isolated project
 * under `.host-compat/<version>/`: a copy of `src/` and `test/`, that host's
 * DSH type packages installed into the copy's own `node_modules`, and a
 * standalone tsconfig. The sources and tests are then typechecked there, so
 * module resolution can only reach that host's declarations. The script also
 * asserts the resolution really used the host copy and that the declared peer
 * ranges accept every host version.
 *
 * Nothing outside this repository is read or written: no DSH profile, no
 * session store, no running server.
 *
 * Usage: node scripts/check-host-compat.mjs [version ...]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_HOSTS = ['0.1.7-alpha.2', '0.1.7-rc.1']
const HOSTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_HOSTS
const DSH_PACKAGES = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-jobs']
const CORDIS_VERSION = '4.0.4'
const WORK = join(ROOT, '.host-compat')
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc')

const COMPILER_OPTIONS = {
  target: 'ES2023',
  lib: ['ES2023'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  types: ['node'],
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  verbatimModuleSyntax: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  noEmit: true,
}

const run = (command, args, cwd) => {
  process.stdout.write('  $ ' + command + ' ' + args.join(' ') + '\n')
  try {
    return execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  } catch (error) {
    if (error.stdout) process.stderr.write(String(error.stdout))
    if (error.stderr) process.stderr.write(String(error.stderr))
    throw error
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const failures = []

for (const host of HOSTS) {
  const hostDirectory = join(WORK, host)
  rmSync(hostDirectory, { recursive: true, force: true })
  mkdirSync(hostDirectory, { recursive: true })

  const manifest = {
    name: 'host-compat-' + host.replace(/[^a-z0-9]/gi, '-'),
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ['@deepseek-ai/cordis', CORDIS_VERSION],
      ...DSH_PACKAGES.map((name) => [name, host]),
      ['@types/node', '^24.0.0'],
    ]),
  }
  writeFileSync(join(hostDirectory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('host ' + host + ': installing that host\'s packages into the isolated copy')
  run('pnpm', ['install', '--ignore-scripts', '--prefer-offline', '--reporter=silent'], hostDirectory)

  cpSync(join(ROOT, 'src'), join(hostDirectory, 'src'), { recursive: true })
  cpSync(join(ROOT, 'test'), join(hostDirectory, 'test'), { recursive: true })
  const tsconfigPath = join(hostDirectory, 'tsconfig.json')
  writeFileSync(
    tsconfigPath,
    JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include: ['src/**/*.ts', 'test/**/*.ts'] }, null, 2) + '\n',
  )

  // Prove the copy can only reach its own node_modules before trusting the typecheck.
  const requireFromCopy = createRequire(join(hostDirectory, 'package.json'))
  for (const name of DSH_PACKAGES) {
    const resolved = requireFromCopy.resolve(name + '/package.json')
    if (!resolved.startsWith(hostDirectory)) {
      failures.push('host ' + host + ': ' + name + ' resolves outside the isolated copy (' + resolved + ')')
    }
  }

  console.log('host ' + host + ': typechecking the copied sources and tests')
  run(TSC, ['-p', tsconfigPath], hostDirectory)

  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    const version = name === '@deepseek-ai/cordis' ? CORDIS_VERSION : host
    if (!semver.satisfies(version, range)) failures.push(name + ': peer range "' + range + '" rejects ' + version)
  }
}

console.log('')
console.log('hosts checked: ' + HOSTS.join(', '))
console.log('peer ranges:   ' + JSON.stringify(pkg.peerDependencies))
if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error('FAIL ' + failure)
  process.exit(1)
}
console.log('OK: every host copy typechecks against its own declarations and satisfies the peer ranges')
