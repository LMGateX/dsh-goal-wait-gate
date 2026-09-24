import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from './harness.ts'

test('with no background work the gate consults the goal and mutates nothing', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)

  await harness.turnStopping(agent)
  harness.idle(agent)

  assert.equal(harness.goals.byKind('disarm').length, 0, 'no disarm without live work')
  assert.equal(harness.goals.byKind('resume').length, 0, 'no resume without a hold')
  assert.equal(harness.goals.byKind('pause').length, 0, 'the gate never pauses')
  assert.ok(harness.goals.byKind('get').length >= 2, 'the gate consults the goal at both checkpoints')
  assert.equal(harness.observations.at(-1), 'armed', 'the official driver still sees an armed goal')

  await harness.dispose()
})

test('the plugin mounts and unloads on a live context', async () => {
  const harness = await createHarness()
  await harness.unload()
  await harness.dispose()
})
