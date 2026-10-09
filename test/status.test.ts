/**
 * The status record exists so a person can tell which driver is really live:
 * the two mount shapes hold continuation differently (a skipped round versus a
 * disarmed goal) and look alike in a transcript. It must be readable, complete
 * and never able to disturb the instance it describes.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { currentGateStatus, gateStatusPath, writeGateStatus } from '../src/status.ts'
import { registerStatusRoute } from '../src/status-route.ts'
import type { Context } from '@deepseek-ai/cordis'

test('the status record sits beside the DSH home', () => {
  assert.equal(gateStatusPath({ DSH_HOME: '/tmp/example-home' }), '/tmp/example-home/goal-wait-gate.status.json')
  const fallback = gateStatusPath({})
  assert.match(fallback, /[.]dsh[/\\]goal-wait-gate[.]status[.]json$/)
  assert.equal(gateStatusPath({ DSH_HOME: '' }), fallback, 'an exported empty home must not win')
})

test('a status record is written whole', () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-status-'))
  const path = gateStatusPath({ DSH_HOME: home })
  writeGateStatus({ at: '2026-10-09T00:00:00.000Z', requested: 'replacement', mounted: 'replacement-port', host: { distribution: '0.2.1-alpha.1', cordis: '4.0.5-alpha.1', driverSha256: 'abc' } }, path)
  const written = JSON.parse(readFileSync(path, 'utf8')) as { mounted?: string; host?: { distribution?: string } }
  assert.equal(written.mounted, 'replacement-port')
  assert.equal(written.host?.distribution, '0.2.1-alpha.1')
})

test('a status record can never disturb the instance it describes', () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-status-'))
  const blocker = join(home, 'blocker')
  writeFileSync(blocker, 'not a directory')
  // A path that cannot be created is swallowed: losing the record is allowed,
  // failing a mount because of it is not.
  assert.doesNotThrow(() => writeGateStatus({ at: '2026-10-09T00:00:00.000Z', requested: 'activation', mounted: 'host-driver+gate' }, join(blocker, 'goal-wait-gate.status.json')))
})

test('the status route serves what the plugin last recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-status-'))
  writeGateStatus({ at: '2026-10-09T00:00:00.000Z', requested: 'replacement', mounted: 'replacement-port', host: { distribution: '0.2.1-alpha.2' } }, join(home, 'goal-wait-gate.status.json'))
  assert.equal(currentGateStatus()?.mounted, 'replacement-port', 'the record is remembered for the route')
  let handler: ((request: unknown, response: FakeResponse) => void) | undefined
  const scoped = {
    get: () => ({ register: (route: { handler: (request: unknown, response: FakeResponse) => void }) => { handler = route.handler; return () => {} } }),
    // Cordis runs an effect body immediately and keeps its disposer.
    effect: (callback: () => unknown) => { callback() },
  }
  const ctx = { inject: (_names: readonly string[], callback: (scope: unknown) => void) => { callback(scoped) } }
  registerStatusRoute(ctx as unknown as Context)
  let body = ''
  assert.ok(handler, 'the route was not registered')
  // A GET, the shape a browser reader sends; the handler now reads the method
  // to tell a save POST from a status read.
  handler({ method: 'GET' }, { writeHead: () => {}, end: (value: string) => { body = value } })
  assert.equal(JSON.parse(body).mounted, 'replacement-port')
  assert.equal(JSON.parse(body).host.distribution, '0.2.1-alpha.2')
})

interface FakeResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}
