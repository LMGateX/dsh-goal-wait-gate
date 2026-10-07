#!/usr/bin/env node
/**
 * Host-side end-to-end check for the row configuration form.
 *
 * The DSH Plugins page renders a row's configuration namespace only when the
 * host settings service (`@deepseek-ai/dsh-settings`) can build a *volatile*
 * form for it: `volatileForm(schema)` returns undefined when no field carries
 * `meta.volatile`, and `describe()` then omits the row entirely — which is
 * exactly the 0.4.0 defect (the row loaded, the page showed nothing).
 *
 * This script runs the real host class against the real plugin:
 *
 *   - a real cordis `Context` from the installed DSH;
 *   - the plugin mounted as a genuine fiber, so `entry.fiber.runtime.Config` and
 *     the volatile config accessors are the ones a real profile hands over;
 *   - the installed `@deepseek-ai/dsh-settings` `SettingsForms` class, whose
 *     `describe()` is the same source the browser's `ctx.configForms.describe()`
 *     mirrors.
 *
 * The profile plumbing `SettingsForms` injects (loader, configEditor,
 * profileContext) is stubbed to present this one real fiber; the predicate and
 * the projection are host code. Anything the host cannot be made to accept is
 * reported as a failure rather than worked around.
 *
 * Usage: node scripts/check-settings-form.mjs     (exit 0 = form namespace present)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(new URL(import.meta.url).pathname))
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const anchor = dshInstallAnchor()
const require = createRequire(anchor)
const candis = name => pathToFileURL(join(dirname(require.resolve(name + '/package.json')), 'lib', 'index.js')).href

const { Context } = await import(candis('@deepseek-ai/cordis'))
const settingsModule = await import(candis('@deepseek-ai/dsh-settings'))
const SettingsForms = settingsModule.default ?? settingsModule.SettingsForms
check(typeof SettingsForms === 'function', 'the installed dsh-settings exports no SettingsForms class')
if (typeof SettingsForms !== 'function') {
  console.error('FAILED: cannot reach the host settings service; this check cannot run')
  process.exit(1)
}

const gate = await import(pathToFileURL(join(ROOT, 'src', 'index.ts')).href)
const home = mkdtempSync(join(tmpdir(), 'dsh-settings-form-'))

// A real realm: the plugin mounts as a genuine fiber, so the host reads the
// Config and the config object the loader would hand over in a profile.
const ctx = new Context()
/** Register one stand-in service; cordis requires the name to be provided first. */
const provide = (name, value) => {
  ctx.provide(name)
  ctx.set(name, value)
}
provide('loader', { await: async () => {}, entries: () => [] })
provide('agents', { list: () => [] })
provide('goals', { get: () => undefined })

let fiber
try {
  fiber = ctx.plugin(gate.goalWaitGate, {})
  await fiber
} catch (error) {
  check(false, 'the plugin could not be mounted on a real cordis context: ' + String(error?.message ?? error))
}

if (fiber !== undefined) {
  check(fiber.state === 2, 'the plugin fiber is not started (state ' + String(fiber.state) + ')')
  check(fiber.runtime?.Config !== undefined, 'the mounted fiber publishes no runtime.Config')
  const entry = {
    options: { id: 'goal-wait-gate', config: {} },
    fiber,
    parent: { tree: { ctx: { fiber: { entry: { id: 'include' } } } } },
  }
  provide('configEditor', {
    documentPath: join(home, 'cordis.patch.yml'),
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: {} }],
    edit: async (_entry, change) => { await change({ strategy: 'native' }, {}, gate.Config) },
  })
  provide('profileContext', { name: 'settings-check', home, dir: home, installAnchor: anchor })

  let forms
  try {
    await ctx.plugin(SettingsForms)
    forms = ctx.get('settings')
  } catch (error) {
    check(false, 'the host settings service could not be mounted: ' + String(error?.message ?? error))
  }

  if (forms !== undefined) {
    let described
    try {
      described = forms.describe()
    } catch (error) {
      check(false, 'settings.describe() threw: ' + String(error?.message ?? error))
    }
    const row = (described ?? []).find(item => item.ns === 'goal-wait-gate')
    check(row !== undefined, 'the host settings service describes no namespace for "goal-wait-gate": the Plugins page renders nothing')
    if (row !== undefined) {
      check(row.applies === 'live', 'the described namespace is not live-applied: ' + String(row.applies))
      // describe() serializes the volatile form as schemastery JSON.
      const json = row.schema ?? {}
      const envelope = json.refs?.[String(json.uid)] ?? {}
      const dict = envelope.dict ?? {}
      const node = field => json.refs?.[dict[field]] ?? {}
      const fields = Object.keys(dict)
      check(JSON.stringify(fields) === JSON.stringify(['strategy', 'waitForJobs', 'waitForSubagents', 'maxHoldMs']), 'the described form fields are ' + JSON.stringify(fields))
      // The described form is `plainSchema`, which strips meta.volatile on purpose;
      // only volatile fields survive volatileForm, so a four-field projection is the
      // proof that the predicate passed. Volatility itself is read from the live schema.
      const live = fiber.runtime.Config.toJSON()
      const liveDict = live.refs[String(live.uid)].dict ?? {}
      const volatile = Object.fromEntries(Object.entries(liveDict).map(([field, id]) => [field, live.refs[id].meta?.volatile === true]))
      check(Object.values(volatile).every(Boolean), 'a live Config field is not volatile: ' + JSON.stringify(volatile))
      const strategy = node('strategy')
      check(strategy.type === 'union', 'the strategy field is not a union but ' + JSON.stringify(strategy.type))
      const choices = (strategy.list ?? []).map(id => json.refs[id]?.value)
      check(JSON.stringify(choices) === JSON.stringify(['activation', 'replacement', 'native', 'off']), 'the described strategy choices are ' + JSON.stringify(choices))
      check(strategy.meta?.default === 'activation', 'the described strategy default is ' + JSON.stringify(strategy.meta?.default))
      check(row.value?.strategy === 'activation', 'the live value of strategy is ' + JSON.stringify(row.value?.strategy))
      console.log(JSON.stringify({ ns: row.ns, applies: row.applies, liveVolatile: volatile, describedFields: fields, choices, default: strategy.meta?.default, value: row.value }, null, 2))
    }

    // The save path must accept the same fields: a non-volatile path throws
    // 'Config field "<path>" is not volatile' before any profile write.
    try {
      await forms.write('goal-wait-gate', draft => ({ ...draft, strategy: 'native' }), undefined, [['strategy']])
    } catch (error) {
      const message = String(error?.message ?? error)
      check(!/not volatile/i.test(message), 'the host refuses a live save for this row: ' + message)
    }
  }
}

rmSync(home, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAILED (' + failures.length + '): the host would not render this row on the Plugins page')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('OK: the host settings service describes a live "goal-wait-gate" namespace with the four volatile fields')
console.log('    and the four strategy choices; a saved strategy passes the volatility check on the write path.')

/** Resolve the dsh installation package.json behind the configured executable. */
function dshInstallAnchor() {
  const bin = process.env.DSH_BIN ?? 'dsh'
  const real = realpathSync(execFileSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).trim())
  for (let dir = dirname(real); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, 'package.json')
    if (!existsSync(candidate)) continue
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    if (parsed.name === '@deepseek-ai/dsh') return candidate
  }
  throw new Error('cannot locate the dsh installation behind ' + bin)
}
