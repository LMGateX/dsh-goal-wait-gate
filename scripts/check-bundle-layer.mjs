#!/usr/bin/env node
/**
 * Isolated bundle-layer check.
 *
 * DSH composes a profile as: the bundles named in `dsh.profile.bundles`, then
 * the profile's own `cordis.patch.yml`, then any `--patch` overlays. This
 * script proves that this repository, switched on as one of those bundles,
 * mounts the gate exactly once and reads back as a manageable bundle to the
 * same host readers the sidebar Plugins page uses.
 *
 * Isolation: the real profile is only read. Its small config files are copied
 * into a disposable DSH home under `.bundle-check/`, its `node_modules` is
 * symlinked entry by entry with this repository standing in for the plugin, and
 * the hand-written `insert` block the README's migration removes is stripped
 * from the copy. Nothing outside `.bundle-check/` is written, no live profile
 * is modified and no running server is contacted.
 *
 * Usage: node scripts/check-bundle-layer.mjs
 *   DSH_PROFILE   profile name to mirror (default: web)
 *   DSH_HOME_REAL real DSH home to read (default: ~/.dsh)
 *   DSH_BIN       dsh executable to compose with (default: dsh on PATH)
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DSH = process.env.DSH_BIN ?? 'dsh'
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const REAL_HOME = process.env.DSH_HOME_REAL ?? join(homedir(), '.dsh')
const REAL_PROFILE = join(REAL_HOME, 'profiles', PROFILE)
const WORK = join(ROOT, '.bundle-check')
const ISOLATED_HOME = join(WORK, 'home')
const ISOLATED_PROFILE = join(ISOLATED_HOME, 'profiles', PROFILE)
const OVERRIDE = join(WORK, 'gate-config-override.yml')
const DUMP = join(WORK, 'dump.yml')
const DUMP_OVERRIDE = join(WORK, 'dump-override.yml')
/** The block a pre-bundle install carried; the README's migration removes it. */
const LEGACY_BLOCK = /^# >>> dsh-goal-wait-gate >>>$[\s\S]*?^# <<< dsh-goal-wait-gate <<<$\n?/m

const packageManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const NAME = packageManifest.name

if (!existsSync(REAL_PROFILE)) {
  console.error('no profile at ' + REAL_PROFILE + '; set DSH_HOME_REAL or DSH_PROFILE')
  process.exit(2)
}

const failures = []
const check = (condition, message) => {
  if (condition) return true
  failures.push(message)
  console.error('FAIL ' + message)
  return false
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(ISOLATED_PROFILE, 'node_modules'), { recursive: true })

// Mirror the profile: this repository replaces the installed plugin everywhere,
// and every other entry stays a read-only link to the real dependency tree.
for (const entry of readdirSync(join(REAL_PROFILE, 'node_modules'), { withFileTypes: true })) {
  const source = join(REAL_PROFILE, 'node_modules', entry.name)
  symlinkSync(entry.name === NAME ? ROOT : source, join(ISOLATED_PROFILE, 'node_modules', entry.name))
}
let legacyBlockRemoved = false
for (const entry of readdirSync(REAL_PROFILE, { withFileTypes: true })) {
  if (entry.isDirectory()) continue
  const source = join(REAL_PROFILE, entry.name)
  const target = join(ISOLATED_PROFILE, entry.name)
  if (entry.name === 'cordis.patch.yml') {
    const text = readFileSync(source, 'utf8')
    legacyBlockRemoved = LEGACY_BLOCK.test(text)
    writeFileSync(target, text.replace(LEGACY_BLOCK, '').replace(/\n{3,}/g, '\n\n'))
    continue
  }
  copyFileSync(source, target)
}

// The manifest after `dsh plugin add` and the manager's reconciliation: the
// dependency is recorded and the bundle is switched on.
const isolatedManifest = JSON.parse(readFileSync(join(ISOLATED_PROFILE, 'package.json'), 'utf8'))
isolatedManifest.dependencies[NAME] = 'link:' + ROOT
const bundles = isolatedManifest.dsh?.profile?.bundles ?? []
if (!bundles.includes(NAME)) bundles.push(NAME)
isolatedManifest.dsh = { ...isolatedManifest.dsh, profile: { ...isolatedManifest.dsh?.profile, bundles } }
writeFileSync(join(ISOLATED_PROFILE, 'package.json'), JSON.stringify(isolatedManifest, null, 2) + '\n')

// Compose without the bundle's own row in the profile layer, then again with a
// policy override, which must still win over the bundle layer.
writeFileSync(OVERRIDE, '- id: goal-wait-gate\n  config:\n    maxHoldMs: 45000\n')
const compose = (extra) => execFileSync(DSH, ['--profile', PROFILE, ...extra, '--dump-config'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, DSH_HOME: ISOLATED_HOME },
})
const dump = compose([])
const dumpOverride = compose(['--patch', OVERRIDE])
writeFileSync(DUMP, dump)
writeFileSync(DUMP_OVERRIDE, dumpOverride)

// The documented install must be the bundle install; a hand-written insert in
// the README would mount the same row a second time beside the shipped layer.
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
check(readme.includes('dsh plugin --profile web add'), 'README.md no longer documents the bundle install command')
check(!readme.includes('- insert:'), 'README.md still documents a hand-written insert beside the shipped bundle layer')

console.log('composed   ' + NAME + ' as a bundle of profile ' + PROFILE + (legacyBlockRemoved ? ' (legacy hand-written insert removed from the copy)' : ' (no legacy hand-written insert was present)'))

const row = /^- id: goal-wait-gate\n  name: dsh-goal-wait-gate$/m
check(row.test(dump), 'the composed tree lacks the bundle row for goal-wait-gate')
check((dump.match(/^- id: goal-wait-gate$/gm) ?? []).length === 1, 'the bundle row is composed more than once')
// This plugin owns the continuation slot: the same layer that mounts it
// disables the host's own driver row, so no two drivers can race.
check(/^# == .*patched by dsh-goal-wait-gate\n- id: goal-round-driver\n  name: '@deepseek-ai\/dsh-goal-round-driver'\n  disabled: true$/m.test(dump), 'the bundle layer does not disable the host goal-round-driver row')
check((dump.match(/^- id: goal-round-driver$/gm) ?? []).length === 1, 'the host goal-round-driver row is composed more than once')
check(!/^- id: goal-round-driver\n  name: '[^\n]*'\n(?!  disabled: true)/m.test(dump), 'the host goal-round-driver row is still enabled beside this plugin')
check(/- id: goal-wait-gate\n  name: dsh-goal-wait-gate\n  config:\n    maxHoldMs: 45000$/m.test(dumpOverride), 'a profile-layer override no longer reaches the bundle row')

// The host readers behind the Plugins page: readProfilePlugins for the bundle
// list, resolveBundleDir + manifest for bundleManifest's decision, readPluginMeta
// for the card text, and evaluatePluginCompatibility for the install preflight.
const anchor = dshInstallAnchor()
const require = createRequire(anchor)
const appBoot = await import(pathToFileURL(join(dirname(require.resolve('@deepseek-ai/dsh-app-boot/package.json')), 'lib', 'index.js')).href)
const profileDir = ISOLATED_PROFILE

const plugins = appBoot.readProfilePlugins({ binName: 'dsh', profileDir, installAnchor: anchor })
const dependency = plugins.dependencies.find(item => item.name === NAME)
check(dependency !== undefined, 'readProfilePlugins does not list ' + NAME)
if (dependency !== undefined) {
  check(dependency.version === packageManifest.version, 'readProfilePlugins reports version ' + dependency.version + ', expected ' + packageManifest.version)
  check(dependency.bundle === true, 'readProfilePlugins does not read the package as a bundle')
  check(dependency.enabled === true, 'readProfilePlugins does not read the bundle as switched on')
}

const dir = appBoot.resolveBundleDir('dsh', NAME, anchor, profileDir)
const bundleManifest = appBoot.readProfileManifest('dsh', dir)
check(bundleManifest.dsh?.bundle?.patch === packageManifest.dsh.bundle.patch, 'bundleManifest would reject this package for the Plugins page')
check(appBoot.evaluatePluginCompatibility(bundleManifest) === undefined, 'the install preflight reads this package as incompatible with the running dsh')

const meta = appBoot.readPluginMeta(NAME, pathToFileURL(join(dir, 'package.json')).href)
const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8')).meta
check(meta?.title?.zh === zh.title && meta?.description?.zh === zh.description, 'the card text does not read back from locale/zh.json')
check(meta?.title?.en !== undefined && meta?.description?.en !== undefined, 'the card text has no English fallback')
check(meta?.error === undefined, 'plugin metadata diagnostics: ' + String(meta?.error))

const patchFiles = appBoot.bundlePatchPaths(dir, bundleManifest.dsh.bundle)
check(patchFiles.some(file => realpathSync(file) === realpathSync(join(ROOT, 'cordis.patch.yml'))), 'bundlePatchPaths does not resolve the shipped patch file: ' + patchFiles.join(', '))
const rows = appBoot.composeEntries([appBoot.loadOverlayPatches('dsh', patchFiles[0]).filter(item => item.insert !== undefined)]).flat(Infinity)
check(rows.some(item => item?.id === 'goal-wait-gate' && item?.name === NAME), 'the shipped patch declares no goal-wait-gate row')

// The configuration page renders only rows whose module publishes a native
// Schemastery node; its strategy union is the choice list on the card.
const entry = await import(pathToFileURL(join(ROOT, 'src', 'index.ts')).href)
check(appBoot.isNativeConfigSchema(entry.Config), 'the package entry exports no native Schemastery Config, so no form would render')
const schema = entry.Config.toJSON()
const envelope = schema.refs[String(schema.uid)]
const strategyNode = schema.refs[envelope.dict.strategy]
const choices = (strategyNode.list ?? []).map(id => schema.refs[id].value)
check(JSON.stringify(choices) === JSON.stringify(['activation', 'replacement', 'native', 'off']), 'the strategy union is not the four documented choices: ' + JSON.stringify(choices))
check(strategyNode.meta?.default === 'activation', 'the strategy union does not default to activation')
check(Object.keys(envelope.dict ?? {}).length === 4, 'the row schema exposes an unexpected field set: ' + Object.keys(envelope.dict ?? {}).join(', '))

if (failures.length > 0) {
  console.error('FAILED (' + failures.length + '): the package does not compose as a profile bundle')
  process.exit(1)
}
console.log('OK: the bundle layer composes once, disables the host driver, overrides still win,')
console.log('    and readProfilePlugins/readPluginMeta/the preflight read it as a manageable bundle')
console.log('    dumps: ' + DUMP + ', ' + DUMP_OVERRIDE + ' (isolated home: ' + ISOLATED_HOME + ')')

/** Resolve the dsh installation package.json behind the configured executable. */
function dshInstallAnchor() {
  const bin = realpathSync(execFileSync('sh', ['-c', 'command -v ' + DSH], { encoding: 'utf8' }).trim())
  for (let dir = dirname(bin); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (!existsSync(candidate)) continue
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    if (parsed.name === '@deepseek-ai/dsh') return candidate
  }
  throw new Error('cannot locate the dsh installation behind ' + bin)
}
