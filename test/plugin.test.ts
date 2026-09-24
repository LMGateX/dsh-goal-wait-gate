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

test('a running owned job disarms the goal before the agent reaches idle', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  await harness.turnStopping(agent)
  assert.deepEqual(
    harness.goals.byKind('disarm').map((call) => call.agentId),
    ['agent-1'],
    'the gate disarms at turn-stopping, before idle',
  )

  harness.idle(agent)
  assert.equal(harness.observations.at(-1), 'disarmed', 'the official driver sees a disarmed goal at idle')
  assert.equal(harness.goals.peek(agent)?.phase, 'active', 'gating never changes the durable phase')
  assert.equal(harness.goals.byKind('pause').length, 0, 'the gate never pauses')

  await harness.dispose()
})

test('a settled job releases the hold after its notice turn ends, resuming exactly once', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  const job = harness.job(agent)

  await harness.turnStopping(agent)
  harness.idle(agent)
  assert.equal(harness.goals.peek(agent)?.activation, 'disarmed', 'held while the job runs')

  harness.jobs.settle(job.id)
  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('resume').length, 1, 'the gate resumes exactly once when the notice turn ends')
  assert.equal(harness.goals.peek(agent)?.activation, 'armed', 'the goal is armed again')

  harness.idle(agent)
  assert.equal(harness.observations.at(-1), 'armed', 'the official driver can continue at the next idle')
  assert.equal(harness.goals.byKind('resume').length, 1, 'no double resume')

  await harness.dispose()
})

test('live subagent descendants hold continuation, and gone children release it', async () => {
  const harness = await createHarness()
  const parent = harness.agent('parent')
  harness.goal(parent)

  harness.agent('child-1', { parent: parent.session.id })
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'a live child holds continuation')

  harness.agent('grandchild-1', { parent: 'session-child-1' })
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'an already-held goal is not re-disarmed')

  harness.agents.drop('grandchild-1')
  harness.agents.drop('child-1')
  await harness.turnStopping(parent)
  assert.equal(harness.goals.byKind('resume').length, 1, 'release once no live descendant remains')
  assert.equal(harness.goals.peek(parent)?.activation, 'armed')

  await harness.dispose()
})

test('jobs owned by other sessions and unowned jobs never hold', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  const other = harness.agent('agent-2')
  harness.goal(agent)
  harness.job(other)
  harness.job(undefined)

  await harness.turnStopping(agent)
  assert.equal(harness.goals.byKind('disarm').length, 0, 'foreign and unowned jobs are not this agent\'s work')

  await harness.dispose()
})

test('an idle with no preceding turn-stopping still holds', async () => {
  const harness = await createHarness()
  const agent = harness.agent('agent-1')
  harness.goal(agent)
  harness.job(agent)

  harness.idle(agent)
  assert.equal(harness.goals.byKind('disarm').length, 1, 'the idle checkpoint is a safety net')
  assert.equal(harness.observations.at(-1), 'disarmed', 'the stand-in driver sees the gate first')

  await harness.dispose()
})

test('the plugin mounts and unloads on a live context', async () => {
  const harness = await createHarness()
  await harness.unload()
  await harness.dispose()
})
