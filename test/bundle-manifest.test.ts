/**
 * Bundle-layer contract.
 *
 * The package ships a DSH bundle layer: the manifest points at
 * `cordis.patch.yml`, that patch mounts exactly the row the plugin registers,
 * and the localized card text ships beside it. The assertions are structural on
 * purpose — the real YAML composition, and the host readers the sidebar Plugins
 * page uses, are exercised by `scripts/check-bundle-layer.mjs` in a disposable
 * DSH home.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { name as pluginName } from '../src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest: Record<string, any> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

/** The locale filename grammar DSH accepts for `<package>/locale/<id>.json`. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

test('the manifest declares the shipped bundle patch and ships it', () => {
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'), 'files ships cordis.patch.yml')
  assert.ok(manifest.files.includes('locale'), 'files ships the locale dictionaries')
  // DSH resolves `<name>/locale/<id>.json` through the exports map before reading
  // the dictionaries, so a package without this subpath shows its technical name.
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
})

test('the bundle patch is one insert mounting the registered plugin name', () => {
  assert.equal((patch.match(/^- insert:$/gm) ?? []).length, 1)
  const ids = [...patch.matchAll(/^ {4}- id: (.+)$/gm)].map(match => match[1])
  assert.deepEqual(ids, [pluginName], 'the row id is the name the plugin registers')
  assert.match(patch, new RegExp('^ {6}name: ' + manifest.name + '$', 'm'))
  assert.doesNotMatch(patch, /^\s*config:/m, 'defaults stay in the plugin, not in the mount declaration')
  assert.doesNotMatch(patch, /^\s*disabled:/m)
})

test('both locale dictionaries carry card text under a valid language id', () => {
  const ids = readdirSync(join(root, 'locale')).filter(file => file.endsWith('.json')).map(file => file.slice(0, -'.json'.length)).sort()
  assert.deepEqual(ids, ['en', 'zh'])
  const dictionaries: Record<string, any> = {}
  for (const id of ids) {
    assert.match(id, LANGUAGE_ID)
    const parsed = JSON.parse(readFileSync(join(root, 'locale', id + '.json'), 'utf8'))
    for (const field of ['title', 'description']) {
      assert.equal(typeof parsed.meta?.[field], 'string', id + ' meta.' + field)
      assert.ok(parsed.meta[field].trim().length > 0, id + ' meta.' + field + ' is not empty')
    }
    dictionaries[id] = parsed
  }
  assert.notEqual(dictionaries.en.meta.title, dictionaries.zh.meta.title)
  assert.notEqual(dictionaries.en.meta.description, dictionaries.zh.meta.description)
})
