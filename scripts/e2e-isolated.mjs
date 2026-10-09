/**
 * End-to-end check in a throwaway DSH home: install the built tarball into a
 * fresh profile, boot the real server, and read back which goal driver is live.
 *
 * This is the only check that exercises the real install layout — the unit suite
 * mounts the plugin in-process, where its own peer copies are absent. A plugin
 * folder that carries auto-installed stale peers (cordis 4.0.4, dsh-agent
 * 0.1.7-rc.2) used to make every pinned host look unpinned, and the ported driver
 * silently fell back to the disarming gate. `--stale-peers` replays exactly that
 * layout and must still end up with the ported driver mounted.
 *
 * Usage: node scripts/e2e-isolated.mjs [--strategy replacement|activation]
 *                                       [--stale-peers] [--tarball <path>] [--keep]
 */
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DSH = process.env['DSH_BIN'] ?? 'dsh'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}
const strategy = option('--strategy', 'replacement')
const stalePeers = args.includes('--stale-peers')
const keep = args.includes('--keep')

const expected = { replacement: 'replacement-port', activation: 'host-driver+gate', native: 'host-driver', off: 'none' }[strategy]
if (expected === undefined) {
  console.error('unknown strategy: ' + strategy)
  process.exit(2)
}

function newestTarball() {
  const explicit = option('--tarball', undefined)
  if (explicit !== undefined) return explicit
  const candidates = readdirSync(ROOT).filter(name => /^dsh-goal-wait-gate-.*[.]tgz$/.test(name)).sort()
  if (candidates.length === 0) throw new Error('no built tarball in ' + ROOT + '; run npm run build && npm pack first')
  return join(ROOT, candidates[candidates.length - 1])
}

const failures = []
const check = (condition, message) => {
  console.log((condition ? '  ok   ' : '  FAIL ') + message)
  if (!condition) failures.push(message)
}

/** The live peer copies this plugin's install layout used to grow, at the versions pnpm chose. */
const STALE = { cordis: '4.0.4', 'dsh-agent': '0.1.7-rc.2', 'dsh-goal': '0.1.7-rc.2', 'dsh-jobs': '0.1.7-rc.2' }

function plantStalePeers(pluginDirectory) {
  for (const [name, version] of Object.entries(STALE)) {
    const directory = join(pluginDirectory, 'node_modules', '@deepseek-ai', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version, main: 'index.js' }, null, 2))
    writeFileSync(join(directory, 'index.js'), '// stale peer copy\n')
  }
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = predicate()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + description)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

const home = mkdtempSync(join(tmpdir(), 'gate-e2e-'))
const profile = join(home, 'profiles', 'e2e')
const tarball = newestTarball()
const bootLog = join(home, 'boot.log')
const statusPath = join(home, 'goal-wait-gate.status.json')

console.log('e2e: strategy=' + strategy + (stalePeers ? ' +stale-peers' : '') + ', home=' + home)
console.log('e2e: tarball=' + tarball)

let child
try {
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-e2e',
    private: true,
    dependencies: { 'dsh-goal-wait-gate': 'file:' + tarball },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-goal-wait-gate'] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '# e2e override: ask for one strategy explicitly.',
    '- id: goal-wait-gate',
    '  name: dsh-goal-wait-gate',
    '  config:',
    '    strategy: ' + strategy,
    '    maxHoldMs: 0',
    '',
  ].join('\n'))

  const installed = spawnSync(DSH, ['plugin', '--profile', 'e2e', 'install'], { cwd: profile, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  if (installed.status !== 0) throw new Error('profile install failed: ' + (installed.stderr || installed.stdout))
  const pluginDirectory = join(profile, 'node_modules', 'dsh-goal-wait-gate')
  if (!existsSync(pluginDirectory)) throw new Error('the tarball did not install into the profile')
  if (stalePeers) {
    plantStalePeers(pluginDirectory)
    console.log('e2e: planted stale peer copies inside the plugin folder')
  }

  const log = []
  child = spawn(DSH, ['--profile', 'e2e', '--no-open', '--port', '0'], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const capture = chunk => { const text = String(chunk); log.push(text); writeFileSync(bootLog, log.join('')) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.on('exit', code => capture('\n[e2e] server exited with ' + code + '\n'))

  const url = await waitFor(() => {
    const match = /http:\/\/127[.]0[.]0[.]1:(\d+)/.exec(log.join(''))
    return match?.[1]
  }, 120000, 'the server to print its URL')
  console.log('e2e: server up on port ' + url)

  await waitFor(() => existsSync(statusPath) ? true : undefined, 60000, 'the plugin to record its status')
  const status = JSON.parse(readFileSync(statusPath, 'utf8'))
  const text = log.join('')

  check(status.requested === strategy, 'the record names the requested strategy (' + status.requested + ')')
  check(status.mounted === expected, 'mounted=' + status.mounted + ' (expected ' + expected + ')')
  check(expected !== 'replacement-port' || status.fallback === undefined, 'no fallback reason: ' + (status.fallback ?? 'none'))
  if (expected === 'replacement-port') {
    check(typeof status.host?.distribution === 'string' && status.host.distribution !== '', 'the record names the matched host identity')
    check(/^[0-9a-f]{64}$/.test(String(status.host?.driverSha256 ?? '')), 'the matched driver fingerprint is recorded')
  }
  const published = await fetch('http://127.0.0.1:' + url + '/goal-wait-gate/status.json').then(response => response.ok ? response.json() : undefined)
  check(published !== undefined, 'the plugin page can read the published status route')
  check(published?.mounted === status.mounted, 'the published status agrees with the record on disk')
  check(child.exitCode === null, 'the server is still running after the record appeared')
  check(!text.includes('falling back'), 'the boot log reported no fallback')
  // The plugin logs at info level, which this console does not carry, so the record
  // is the evidence; a mounted port also proves the bundle layer disabled the host
  // row, because an active host driver would have left this plugin inert.
  check(status.mounted !== 'none' || strategy === 'off', 'the bundle layer put this plugin in charge')
  check(!/Failed to load plugins|did not activate/.test(text), 'every plugin entry activated')
  check(!text.includes('another goal-round driver is already mounted'), 'no foreign driver claimed the slot')
} catch (error) {
  failures.push(String(error && error.message ? error.message : error))
  console.log('  FAIL ' + String(error && error.message ? error.message : error))
} finally {
  if (child !== undefined) {
    child.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  if (keep) console.log('e2e: kept ' + home)
  else rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('')
  for (const failure of failures) console.error('FAIL ' + failure)
  process.exit(1)
}
console.log('')
console.log('OK: ' + strategy + ' boots an isolated instance with ' + expected + ' live' + (stalePeers ? ', stale peer copies and all' : ''))
