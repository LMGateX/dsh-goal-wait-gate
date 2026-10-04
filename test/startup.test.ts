import test, {mock} from 'node:test'
import assert from 'node:assert/strict'
import { NativeFixture } from './native-fixture.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import type { SubagentRunInfo, SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'

test('replacement leaves a waiting parent genuinely idle and its goal armed', async () => {
  const h = await new NativeFixture().initialize()
  try {
    h.startJob(); h.human(); h.createGoal()
    await h.agent.whenIdle(); await h.settle()
    assert.equal(h.agent.status, 'idle')
    assert.equal(h.goal?.phase, 'active')
    assert.equal(h.goal?.activation, 'armed')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 1)
    assert.equal(h.events.filter(e => e.type === 'turn/end').length, 1)
  } finally { await h.dispose() }
})

test('replacement does not spend a goal round while a native local child is live', async () => {
  const release = Promise.withResolvers<void>()
  let started = false
  const h = await new NativeFixture({children: true, onCall: async (fixture, call) => {
    if (call.agent === fixture.agent && call.index === 1) {
      await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic child', request: {parent: fixture.agent, prompt: [{type: 'text', text: 'Synthetic child work'}], maxDepth: 2}, signal: new AbortController().signal})
      started = true
    } else if (call.agent !== fixture.agent) await release.promise
  }}).initialize()
  try {
    h.human(); h.createGoal()
    await h.until(() => started && h.agent.status === 'idle')
    await h.ctx.sessions.flush(h.agent.session)
    await h.settle()
    assert.equal(h.goal?.phase, 'active')
    assert.equal(h.goal?.activation, 'armed')
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.mainCalls, 1)
  } finally { release.resolve(); await h.dispose() }
})

test('local run epoch holds across genuine detach until native disposal and notification handoff end', async () => {
  const finishChild = Promise.withResolvers<void>()
  const detached = Promise.withResolvers<void>()
  const releaseDisposal = Promise.withResolvers<void>()
  let started = false
  const h = await new NativeFixture({children: true,
    decorateHandle: (handle, options) => options.parentAgent === undefined ? handle : {
      agent: handle.agent,
      async dispose() { await handle.dispose(); detached.resolve(); await releaseDisposal.promise },
    },
    onCall: async (fixture, call) => {
      if (call.agent === fixture.agent && call.index === 1) {
        await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic gap child', request: {parent: fixture.agent, prompt: [{type: 'text', text: 'Synthetic child work'}], maxDepth: 2}, signal: new AbortController().signal})
        started = true
      } else if (call.agent !== fixture.agent) await finishChild.promise
    },
  }).initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal()
    await h.until(() => started && h.agent.status === 'idle')
    finishChild.resolve(); await detached.promise
    job.finish()
    await h.until(() => h.mainCalls >= 2)
    await h.agent.whenIdle(); await h.ctx.sessions.flush(h.agent.session); await h.settle()
    assert.equal(h.goal?.roundsStarted, 0)
    assert.equal(h.goal?.activation, 'armed')
    releaseDisposal.resolve()
    await h.until(() => h.goal?.phase === 'blocked')
    const kinds = h.events.filter(e => e.type === 'user/message').map(e => e.data.source.kind)
    assert.ok(kinds.indexOf('subagent-settled') < kinds.indexOf('goal'))
  } finally { finishChild.resolve(); releaseDisposal.resolve(); await h.dispose() }
})

for (const completionDelivery of ['quiet', 'wakeup'] as const) test('job handoff preserves native ' + completionDelivery + ' input and round accounting', async () => {
  const h = await new NativeFixture({completionDelivery}).initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal()
    await h.agent.whenIdle()
    job.finish(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1)
    const messages = h.events.filter(e => e.type === 'user/message')
    const notice = messages.findIndex(e => e.data.source.kind === 'tool-jobs')
    const goal = messages.findIndex(e => e.data.source.kind === 'goal')
    assert.ok(notice >= 0 && notice < goal)
    assert.equal(h.mainCalls, completionDelivery === 'quiet' ? 2 : 3)
  } finally { await h.dispose() }
})

test('failed native first acceptance closes a started epoch without inventing a notice debt', async () => {
  const cancel = new AbortController()
  let failed = false
  let starts = 0, ends = 0
  const h = await new NativeFixture({children: true,
    beforeStartup: async ctx => {
      ctx.on('subagent/start', () => { starts++; cancel.abort() })
      ctx.on('subagent/end', () => { ends++ })
    },
    onCall: async (fixture, call) => {
      if (call.agent === fixture.agent && call.index === 1) {
        try {
          await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic failed acceptance', request: {parent: fixture.agent, prompt: [{type: 'text', text: 'Synthetic child work'}], maxDepth: 2}, signal: cancel.signal})
        } catch { failed = true }
      }
    },
  }).initialize()
  try {
    h.human(); h.createGoal(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(failed, true)
    assert.equal(starts, 1); assert.equal(ends, 1)
    assert.equal(h.goal?.roundsStarted, 1)
    assert.equal(h.events.some(e => e.type === 'user/message' && e.data.source.kind === 'subagent-settled'), false)
    assert.equal(h.ctx.agents.list().length, 1)
  } finally { await h.dispose() }
})

test('ordinary wakeup notice cannot borrow automatic goal-round completion authority', async () => {
  const h = await new NativeFixture({onCall: (fixture, call) => {
    if (call.agent !== fixture.agent) return
    if ([2, 5].includes(call.index)) return {tool: {name: 'get_goal'}}
    if ([3, 6].includes(call.index)) {
      const goal = fixture.goal
      if (!goal) throw new Error('Missing synthetic goal')
      return {tool: {name: 'update_goal', args: {action: 'complete', goal_id: goal.id, revision: goal.revision}}}
    }
  }}).initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal(); await h.agent.whenIdle()
    job.finish(); await h.until(() => h.goal?.phase === 'complete'); await h.agent.whenIdle()
    const updates = h.toolResults.filter(result => result.name === 'update_goal')
    assert.equal(updates.length, 2)
    assert.equal(updates[0]?.code, 'GOAL_TOOL_AUTHORITY_REQUIRED')
    assert.equal(updates[1]?.error, false)
    assert.equal(h.goal?.roundsStarted, 1)
  } finally { await h.dispose() }
})

test('old notice and old run end cannot release a later cold-resumed epoch with the same child id', async () => {
  const finishA = Promise.withResolvers<void>(), finishB = Promise.withResolvers<void>()
  const detachedB = Promise.withResolvers<void>(), disposalB = Promise.withResolvers<void>()
  const starts: SubagentRunInfo[] = [], ends: SubagentRunEndInfo[] = []
  let childHandles = 0, childCalls = 0, initialStarted = false
  const h = await new NativeFixture({children: true,
    beforeStartup: async ctx => { ctx.on('subagent/start', info => { starts.push(info) }); ctx.on('subagent/end', info => { ends.push(info) }) },
    decorateHandle: (handle, options) => {
      if (!options.parentAgent || ++childHandles === 1) return handle
      return {agent: handle.agent, async dispose() { await handle.dispose(); detachedB.resolve(); await disposalB.promise }}
    },
    onCall: async (fixture, call) => {
      if (call.agent === fixture.agent && call.index === 1) {
        await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic repeated epoch', request: {parent: fixture.agent, prompt: [{type: 'text', text: 'Synthetic A'}], maxDepth: 2}, signal: new AbortController().signal})
        initialStarted = true
      } else if (call.agent !== fixture.agent) { childCalls++; await (childCalls === 1 ? finishA.promise : finishB.promise) }
    },
  }).initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal()
    await h.until(() => initialStarted && h.agent.status === 'idle')
    finishA.resolve(); await h.until(() => ends.length === 1, 'epoch A end'); await h.agent.whenIdle()
    const childId = starts[0]?.id
    assert.ok(childId)
    await h.ctx.subagents.sendMessage(h.agent, childId, [{type: 'text', text: 'Synthetic B'}], {signal: new AbortController().signal})
    await h.until(() => starts.length === 2 && h.calls.filter(call => call.agent !== h.agent).length === 2, 'epoch B first request')
    assert.equal(starts[0]?.id, starts[1]?.id)
    assert.notEqual(starts[0]?.runId, starts[1]?.runId)
    finishB.resolve(); await detachedB.promise
    job.finish(); await h.until(() => h.mainCalls >= 3, 'job notice while B disposal delayed'); await h.agent.whenIdle()
    h.agent.inject(createUserMessage({content: [{type: 'text', text: 'Synthetic stale notice'}], source: {kind: 'subagent-settled', form: 'notice', summary: 'Synthetic stale epoch A', senderSessionId: childId}}))
    const oldEnd = ends[0]
    assert.ok(oldEnd)
    h.ctx.emit(scopeTarget(h.ctx.subagents, h.agent), 'subagent/end', oldEnd)
    await h.ctx.sessions.flush(h.agent.session); await h.settle()
    assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.activation, 'armed'); assert.equal(h.goal?.roundsStarted, 0)
    disposalB.resolve(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1)
  } finally { finishA.resolve(); finishB.resolve(); disposalB.resolve(); await h.dispose() }
})

test('nested runtime ownership holds the root while its idle resident child owns a grandchild', async () => {
  const finish = Promise.withResolvers<void>()
  let middle: import('@deepseek-ai/dsh-agent').Agent | undefined
  let started = false
  const h = await new NativeFixture({children: true, onCall: async (fixture, call) => {
    if (call.agent === fixture.agent && call.index === 1) {
      await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic middle', request: {parent: fixture.agent, prompt: [{type: 'text', text: 'Synthetic middle'}], maxDepth: 3}, signal: new AbortController().signal})
      started = true
    } else if (call.agent.session.header.parentSession === fixture.agent.id && call.index === 1) {
      middle = call.agent
      await fixture.ctx.subagents.startContinuable({provider: 'spawn', label: 'Synthetic grandchild', request: {parent: call.agent, prompt: [{type: 'text', text: 'Synthetic grandchild'}], maxDepth: 3}, signal: new AbortController().signal})
    } else if (call.agent !== fixture.agent && call.agent !== middle) await finish.promise
  }}).initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal()
    await h.until(() => started && middle?.status === 'idle' && h.agent.status === 'idle' && h.calls.some(call => call.agent.session.header.parentSession === middle?.id), 'idle resident with grandchild')
    job.finish(); await h.until(() => h.mainCalls >= 2); await h.agent.whenIdle(); await h.ctx.sessions.flush(h.agent.session); await h.settle()
    assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.goal?.activation, 'armed')
    finish.resolve(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1)
  } finally { finish.resolve(); await h.dispose() }
})

test('durable subagent lineage without runtime ownership does not hold an independent conversation', async () => {
  const h = await new NativeFixture().initialize()
  const other = await h.ctx.agents.create({sessionId: (await import('@deepseek-ai/dsh-session')).SessionId('synthetic-independent'), meta: {origin: 'subagent', parentSession: h.agent.id}, agentOptions: {provider: 'synthetic', model: 'local'}})
  try {
    assert.equal(h.ctx.agents.isOwnedBy(other.agent.id, h.agent), false)
    h.createGoal(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1); assert.equal(h.mainCalls, 1)
  } finally { await other.dispose(); await h.dispose() }
})

for (const waitForJobs of [true, false]) test('one-shot end retains subagent Job barrier with waitForJobs=' + waitForJobs, async () => {
  const detached = Promise.withResolvers<void>(), finishDispose = Promise.withResolvers<void>()
  let ends = 0
  const h = await new NativeFixture({children: true, config: {strategy: 'replacement', waitForJobs},
    beforeStartup: async ctx => { ctx.on('subagent/end', () => { ends++ }) },
    decorateHandle: (handle, options) => !options.parentAgent ? handle : {agent: handle.agent, async dispose() { await handle.dispose(); detached.resolve(); await finishDispose.promise }},
    onCall: (fixture, call) => call.agent === fixture.agent && call.index === 1 ? {tool: {name: 'subagent', args: {description: 'Synthetic one-shot', prompt: 'Synthetic work', run_in_background: true}}} : undefined,
  }).initialize()
  try {
    h.human(); h.createGoal(); await detached.promise
    await h.until(() => h.agent.status === 'idle' && h.toolResults.some(result => result.name === 'subagent'))
    await h.ctx.sessions.flush(h.agent.session); await h.settle()
    assert.equal(ends, 1)
    assert.ok(h.ctx.jobs.list(h.agent.id).some(job => job.owner === h.agent.id && job.status === 'running'))
    assert.equal(h.goal?.roundsStarted, 0)
    finishDispose.resolve(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1)
  } finally { finishDispose.resolve(); await h.dispose() }
})

test('goal creation on an already idle parent is gated without a stopping hook', async () => {
  const h = await new NativeFixture().initialize()
  try { h.startJob(); h.createGoal(); await h.ctx.sessions.flush(h.agent.session); await h.settle(); assert.equal(h.mainCalls, 0); assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.goal?.activation, 'armed') }
  finally { await h.dispose() }
})

for (const placement of ['queued', 'downstream'] as const) test('new work at ' + placement + ' reservation fence defers without goal pause/block', async () => {
  const h = await new NativeFixture().initialize()
  let raced = false
  try {
    if (placement === 'queued') h.ctx.on('agent/inbox/inserted', ({message}) => { if (!raced && message.source.kind === 'goal') { raced = true; h.startJob() } })
    else h.ctx.on('agent/pre-step', async ({messages}, next) => { if (!raced && messages.some(m => m.source.kind === 'goal')) { raced = true; h.startJob() } return next() })
    h.createGoal(2); await h.until(() => h.events.some(e => e.type === 'turn/end')); await h.agent.whenIdle()
    assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.activation, 'armed'); assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.mainCalls, 0)
    h.jobs[0]?.finish(); await h.until(() => h.goal?.phase === 'blocked'); assert.equal(h.goal?.roundsStarted, 2)
  } finally { await h.dispose() }
})

test('waiting goal edit keeps activation and next admission uses the latest revision', async () => {
  const h = await new NativeFixture().initialize()
  try {
    const job = h.startJob(); h.human(); h.createGoal(); await h.agent.whenIdle()
    const goal = h.goal; assert.ok(goal)
    h.ctx.goals.edit(h.agent, goal, {objective: 'Synthetic changed objective'})
    await h.ctx.sessions.flush(h.agent.session); await h.settle()
    assert.equal(h.goal?.revision, 2); assert.equal(h.goal?.activation, 'armed'); assert.equal(h.goal?.roundsStarted, 0)
    job.finish(); await h.until(() => h.goal?.phase === 'blocked')
    const admitted = h.events.find(e => e.type === 'user/message' && e.data.source.kind === 'goal')
    assert.ok(admitted?.type === 'user/message' && admitted.data.source.kind === 'goal')
    assert.equal(admitted.data.source.revision, 2)
  } finally { await h.dispose() }
})

for (const abnormal of ['max-tokens', 'error'] as const) test('native ' + abnormal + ' disarms without a waiting turn', async () => {
  const h = await new NativeFixture({onCall: () => abnormal === 'error' ? {error: true} : {finish: 'max-tokens'}}).initialize()
  try { h.startJob(); h.human(); h.createGoal(); await h.agent.whenIdle(); assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.activation, 'disarmed'); assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.mainCalls, 1) }
  finally { await h.dispose() }
})

test('original round limit is checked before background gate', async () => {
  const h = await new NativeFixture({onCall: (fixture, call) => { if (call.agent === fixture.agent && call.index === 1) fixture.startJob() }}).initialize()
  try { h.createGoal(); await h.until(() => h.goal?.phase === 'blocked'); assert.equal(h.goal?.roundsStarted, 1); assert.ok(h.ctx.jobs.list(h.agent.id).some(j => j.owner === h.agent.id && j.status === 'running')) }
  finally { await h.dispose() }
})

test('native durability failure revokes automatic authority without admitting a round', async () => {
  const h = await new NativeFixture().initialize()
  let once = false
  try {
    h.ctx.on('session/flush', () => { if (!once) { once = true; throw new Error('Synthetic checkpoint failure') } })
    h.createGoal(); await h.until(() => h.goal?.activation === 'disarmed')
    assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.mainCalls, 0)
  } finally { await h.dispose() }
})

test('public request-preparation window remains an explicitly bounded admission counterexample', async () => {
  const h = await new NativeFixture().initialize()
  let once = false
  try {
    h.ctx.on('agent/request', async (_request, next) => { if (!once) { once = true; h.startJob() } return next() })
    h.createGoal(2); await h.until(() => h.events.some(e => e.type === 'turn/end')); await h.agent.whenIdle(); await h.settle()
    assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.activation, 'armed'); assert.equal(h.goal?.roundsStarted, 1)
    assert.ok(h.ctx.jobs.list(h.agent.id).some(job => job.owner === h.agent.id && job.status === 'running'))
  } finally { await h.dispose() }
})

for (const cancelKind of ['user', 'parent'] as const) for (const stage of ['queued', 'claimed', 'admitted'] as const) test('public ' + cancelKind + ' cancellation at ' + stage + ' revokes automatic authority', async () => {
  const release = Promise.withResolvers<void>()
  const h = await new NativeFixture({onCall: async (_fixture, call) => { if (stage === 'admitted' && call.index === 1) await release.promise }}).initialize()
  let cancelled = false
  try {
    if (stage === 'queued') h.ctx.on('agent/inbox/inserted', ({message}) => { if (!cancelled && message.source.kind === 'goal') { cancelled = true; h.agent.cancel({kind: cancelKind}) } })
    if (stage === 'claimed') h.ctx.on('agent/pre-step', async ({messages}, next) => { if (!cancelled && messages.some(m => m.source.kind === 'goal')) { cancelled = true; h.agent.cancel({kind: cancelKind}, {keepInbox: true}) } return next() })
    h.createGoal(3)
    if (stage === 'admitted') { await h.until(() => h.mainCalls === 1); cancelled = true; h.agent.cancel({kind: cancelKind}); release.resolve() }
    await h.until(() => h.goal?.activation === 'disarmed'); await h.agent.whenIdle(); await h.settle()
    assert.equal(cancelled, true); assert.equal(h.goal?.phase, 'paused')
    assert.equal(h.goal?.roundsStarted, stage === 'admitted' ? 1 : 0)
    assert.equal(h.mainCalls, stage === 'admitted' ? 1 : 0)
  } finally { release.resolve(); await h.dispose() }
})

test('external pause with keepInbox preserves manual pending input without stale automatic admission', async () => {
  const h = await new NativeFixture().initialize()
  let raced = false
  try {
    h.ctx.on('agent/pre-step', async ({messages}, next) => {
      if (!raced && messages.some(m => m.source.kind === 'goal')) {
        raced = true
        const goal = h.goal; assert.ok(goal)
        h.ctx.goals.pause(h.agent, goal)
        h.agent.cancel({kind: 'user'}, {keepInbox: true})
        h.agent.inject(createUserMessage({content: [{type: 'text', text: 'Synthetic preserved manual input'}], source: {kind: 'user'}}))
      }
      return next()
    })
    h.createGoal(3); await h.until(() => h.goal?.phase === 'paused'); await h.agent.whenIdle()
    h.human('Synthetic wake for preserved input'); await h.until(() => h.mainCalls === 1); await h.agent.whenIdle(); await h.settle()
    assert.equal(h.goal?.phase, 'paused'); assert.equal(h.goal?.roundsStarted, 0)
    const inputs = h.events.filter(e => e.type === 'user/message')
    assert.equal(inputs.some(e => e.data.source.kind === 'goal'), false)
    assert.ok(inputs.some(e => e.data.content.some(part => part.type === 'text' && part.text === 'Synthetic preserved manual input')))
  } finally { await h.dispose() }
})

for (const failure of ['throw', 'reject'] as const) test('downstream pre-step ' + failure + ' is contained and disarms native continuation', async () => {
  const h = await new NativeFixture().initialize()
  try {
    h.ctx.on('agent/pre-step', (_boundary, _next) => { if (failure === 'throw') throw new Error('Synthetic downstream failure'); return Promise.reject(new Error('Synthetic downstream rejection')) })
    h.createGoal(3); await h.until(() => h.goal?.activation === 'disarmed'); await h.agent.whenIdle()
    assert.equal(h.goal?.phase, 'active'); assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.mainCalls, 0)
  } finally { await h.dispose() }
})

test('managed replacement retains asynchronous public drain failure after synchronous revocation', async () => {
  const release = Promise.withResolvers<void>()
  const h = await new NativeFixture({onCall: async (_fixture, call) => { if (call.index === 1) await release.promise }}).initialize()
  const diagnostics = (await import('../src/startup.ts')).getStartupState
  let override: ReturnType<typeof mock.method> | undefined
  try {
    h.createGoal(3); await h.until(() => h.mainCalls === 1)
    override = mock.method(h.agent, 'whenIdle', () => Promise.reject(new Error('Synthetic asynchronous drain failure')))
    const disposal = h.owner.dispose(); release.resolve(); await disposal
    assert.equal(h.goal?.activation, 'disarmed')
    const state = diagnostics(h.ctx); assert.ok(state?.cleanup)
    await assert.rejects(state.cleanup, /Managed startup cleanup failed/)
    assert.equal(state.status, 'failed'); assert.equal(state.cleanupIntegrity, 'managed-stop')
  } finally { override?.mock.restore(); release.resolve(); await h.dispose() }
})

test('unowned and foreign-root Jobs are visible but cannot hold this goal', async () => {
  const h = await new NativeFixture().initialize()
  const other = await h.ctx.agents.create({sessionId: (await import('@deepseek-ai/dsh-session')).SessionId('synthetic-other-root'), agentOptions: {provider: 'synthetic', model: 'local'}})
  const done = [Promise.withResolvers<{status: 'completed' | 'killed'}>(), Promise.withResolvers<{status: 'completed' | 'killed'}>()]
  try {
    for (const [index, owner] of [undefined, other.agent.id].entries()) {
      const completion = done[index]; assert.ok(completion)
      h.ctx.jobs.start({kind: 'bash', label: 'Synthetic unrelated work', owner, run: () => ({done: completion.promise, cancel: () => completion.resolve({status: 'killed'})})})
    }
    h.createGoal(); await h.until(() => h.goal?.phase === 'blocked')
    assert.equal(h.goal?.roundsStarted, 1); assert.equal(h.mainCalls, 1)
  } finally { for (const completion of done) completion.resolve({status: 'completed'}); await other.dispose(); await h.dispose() }
})

test('waitForJobs false really ignores generic Jobs while preserving its separate subagent policy', async () => {
  const h = await new NativeFixture({config: {strategy: 'replacement', waitForJobs: false}}).initialize()
  try { h.startJob(); h.createGoal(); await h.until(() => h.goal?.phase === 'blocked'); assert.equal(h.goal?.roundsStarted, 1); assert.equal(h.mainCalls, 1) }
  finally { await h.dispose() }
})

test('semantic downstream decision reject keeps native prompt-rejected blocked behavior', async () => {
  const h = await new NativeFixture().initialize()
  try {
    h.ctx.on('agent/pre-step', async () => ({kind: 'reject', reason: 'Synthetic semantic rejection'}))
    h.createGoal(3); await h.until(() => h.goal?.phase === 'blocked'); await h.agent.whenIdle()
    assert.equal(h.goal?.blockedReason?.code, 'prompt-rejected')
    assert.equal(h.goal?.roundsStarted, 0); assert.equal(h.mainCalls, 0)
  } finally { await h.dispose() }
})
