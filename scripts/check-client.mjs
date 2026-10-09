#!/usr/bin/env node
/**
 * Browser-half smoke check.
 *
 * The plugin page has no generic configuration renderer: a row detail page renders
 * `plugins.row.config`, and each plugin's own browser half fills that slot. This
 * check runs that browser half in Node against a stubbed module loader, a minimal
 * React surface and a fake client context, and asserts the page it registers:
 *
 *   1. the slot registration targets `plugins.row.config` and is keyed to this
 *      bundle plus this row, with the row's own config form injected;
 *   2. the rendered page carries one control per owned field, with all four
 *      strategy choices and the Chinese labels the locale file uses;
 *   3. a staged change plus Save submits exactly the changed paths, revision-fenced;
 *   4. the file stays a classic script (no ESM syntax) and ships in the tarball.
 *
 * Usage: node scripts/check-client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'client', 'client.js')
const BUNDLE_ID = 'dsh-goal-wait-gate'
const ROW_ID = 'goal-wait-gate'
const REVISION = 7

const failures = []
const check = (condition, message) => {
  if (condition) return true
  failures.push(message)
  console.error('FAIL ' + message)
  return false
}

// --- the module-loader contract -------------------------------------------------
let loaded
const source = readFileSync(CLIENT, 'utf8')
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec
    },
  },
}
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
  },
  /** Minimal stand-in so a real error boundary can be declared in the bundle. */
  Component: class BoundaryComponent {
    constructor(props) { this.props = props === undefined ? {} : props }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}
const fakeRequire = (id) => {
  if (id !== 'react') throw new Error('unexpected require: ' + id)
  return React
}

check(!/^\s*(import|export)\s/m.test(source), 'client.js carries ESM syntax; the shell loads it as a classic script')
check(!/import\s*\(/.test(source), 'client.js uses a dynamic import; the shell loads it as a classic script')

// --- run the factory ------------------------------------------------------------
eval(source)
check(loaded !== undefined, 'the file did not call window.__ModuleLoader__.load')
if (loaded === undefined) {
  console.error('FAILED (1): the browser half never registered')
  process.exit(1)
}
check(loaded.id === BUNDLE_ID, `the loader id is ${String(loaded.id)}, expected ${BUNDLE_ID}`)

const api = loaded.factory(fakeRequire)
check(api !== null && typeof api === 'object', 'the factory returned no module namespace')
check(Array.isArray(api.inject) && api.inject.join(',') === 'slots,configForms', 'inject list is not [slots, configForms]')
check(typeof api.apply === 'function', 'the module exports no apply()')
check(typeof api.createEditor === 'function', 'the module exports no createEditor()')

// --- fake client context --------------------------------------------------------
const value = { strategy: 'activation', waitForJobs: true, waitForSubagents: true, maxHoldMs: 0 }
let snapshot = { status: 'ready', writable: true, revision: REVISION, value }
const mutations = []
const form = {
  getSnapshot: () => snapshot,
  subscribe: () => () => {},
  mutate: async (ops, revision) => {
    mutations.push({ ops, revision })
    snapshot = { ...snapshot, revision: revision + 1, value: { ...value, ...Object.fromEntries(ops.filter((op) => op.op === 'set').map((op) => [op.path[0], op.value])) } }
    return true
  },
}
const registrations = []
const effects = []
const ctx = {
  effect(job, label) {
    effects.push(label ?? '')
    return job() ?? (() => {})
  },
  configForms: {
    get(id) {
      check(id === ROW_ID, `the page asked for namespace ${id}, expected ${ROW_ID}`)
      return form
    },
    whileServed(namespaces, register) {
      check(namespaces.includes(ROW_ID), 'whileServed does not watch this row namespace')
      return register(new Set(namespaces))
    },
  },
  slots: {
    inject(name, register) {
      check(name === 'plugins.row.config', `inject targeted ${name}, expected plugins.row.config`)
      return register()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  },
}
api.apply(ctx)
check(registrations.length === 1, `expected exactly one slot registration, saw ${registrations.length}`)
const registration = registrations[0]
if (registration !== undefined) {
  check(registration.spec.name === 'plugins.row.config', 'the registration does not target plugins.row.config')
  check(registration.spec.key === BUNDLE_ID + '#' + ROW_ID, `registration key is ${String(registration.spec.key)}`)
  const injected = registration.spec.inject()
  check(injected.configForm === form, 'the registration does not inject the row config form')
}

// --- the rendered tree ----------------------------------------------------------
const component = registration?.component
check(typeof component === 'function', 'the slot registration carries no component')
const summary = component?.({ view: 'summary' })
check(typeof summary === 'string' && summary.length > 0, 'the summary view is not a non-empty string')
const tree = component?.({ view: 'page', configForm: form })
const nodes = []
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk)
  if (node === null || typeof node !== 'object') return
  // Resolve function components the way React would, so the smoke check walks the
  // rendered element tree rather than the component references.
  if (typeof node.type === 'function') { const isClass = node.type.prototype !== undefined && typeof node.type.prototype.render === 'function'; return walk(isClass ? new node.type(node.props).render() : node.type(node.props)); }
  nodes.push(node)
  walk(node.children)
}
walk(tree)
const ofType = (type) => nodes.filter((node) => node.type === type)
const byId = (id) => nodes.find((node) => node.props.id === id)
check(ofType('form').length === 1, 'the page is not a single form')
const select = byId('dsh-goal-wait-gate-strategy')
check(select !== undefined && select.type === 'select', 'no strategy select is rendered')
const options = select === undefined ? [] : select.children.filter((child) => child.type === 'option').map((child) => child.props.value)
check(options.join('|') === 'activation|replacement|native|off', `strategy choices are ${options.join('|')}`)
const labels = select === undefined ? [] : select.children.filter((child) => child.type === 'option').map((child) => child.children.join(''))
check(labels.some((label) => label.includes('官方原生驱动＋闸门')), 'the first choice does not carry the locale label for activation')
check(labels.some((label) => label.includes('官方原样')), 'no choice carries the locale label for native')
check(labels.some((label) => label.includes('关闭续行')), 'no choice carries the locale label for off')
for (const id of ['dsh-goal-wait-gate-waitForJobs', 'dsh-goal-wait-gate-waitForSubagents']) {
  const input = byId(id)
  check(input !== undefined && input.type === 'input' && input.props.type === 'checkbox', `no boolean control for ${id}`)
}
const duration = byId('dsh-goal-wait-gate-maxHoldMs')
check(duration !== undefined && duration.props.type === 'number' && duration.props.min === 0, 'no non-negative number control for maxHoldMs')

// --- staged edits and save ------------------------------------------------------
const editor = api.createEditor(form)
editor.start()
editor.edit('strategy', 'native')
editor.edit('waitForJobs', false)
editor.edit('maxHoldMs', '45000')
const saved = await editor.save()
check(saved === true, 'save() did not report success')
check(mutations.length === 1, `expected one mutation, saw ${mutations.length}`)
const mutation = mutations[0]
check(mutation?.revision === REVISION, `the mutation was fenced by revision ${String(mutation?.revision)}, expected ${REVISION}`)
check(JSON.stringify(mutation?.ops) === JSON.stringify([
  { op: 'set', path: ['strategy'], value: 'native' },
  { op: 'set', path: ['waitForJobs'], value: false },
  { op: 'set', path: ['maxHoldMs'], value: 45000 },
]), 'the mutation did not carry exactly the changed paths: ' + JSON.stringify(mutation?.ops))
editor.edit('maxHoldMs', '12.5')
const rejected = await editor.save()
check(rejected === false && mutations.length === 1, 'an invalid duration was submitted to the host')
check(/非负整数/.test(editor.getSnapshot().error), 'an invalid duration produced no readable error')

// --- packaging ------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
check(manifest.exports['./client']?.default === './client/client.js', 'package.json exports no ./client entry')
check(manifest.exports['./client']?.types === './client/public.d.ts', 'the ./client entry carries no types')
check(source.includes('/goal-wait-gate/status.json'), 'the browser half does not read the published driver status')
check(Array.isArray(manifest.files) && manifest.files.includes('client'), 'package.json files does not ship the client directory')
check(manifest.dsh?.client?.platform === 'web', 'package.json declares no dsh.client.platform')

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}): the browser half does not render the configuration page`)
  process.exit(1)
}
console.log('OK: the browser half registers plugins.row.config for ' + BUNDLE_ID + '#' + ROW_ID + ',')
console.log('    renders the four strategy choices plus the three policy controls, and saves')
console.log('    exactly the changed paths revision-fenced by ' + REVISION + '.')
