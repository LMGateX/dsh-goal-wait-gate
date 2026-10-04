/** Real native public interfaces; only model replies and producer completion are controlled. */
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Sessions, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents, { type Agent, type AgentHandle, type CreateAgentOptions, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import Llm, { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Goals from '@deepseek-ai/dsh-goal'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as GoalInvariant from '@deepseek-ai/dsh-goal-round-driver/invariant'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents from '@deepseek-ai/dsh-subagent'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { goalWaitStartup, type StartupConfig } from '../src/startup.ts'

export interface Call { agent: Agent; index: number; signal: AbortSignal | undefined }
export interface Answer { finish?: 'stop' | 'max-tokens'; error?: boolean; tool?: {name: string; args?: Record<string, unknown>} }
export interface FixtureOptions { children?: boolean; completionDelivery?: 'quiet' | 'wakeup'; decorateHandle?: (handle: AgentHandle, options: Pick<CreateAgentOptions, 'parentAgent'>) => AgentHandle; config?: StartupConfig; onCall?: (fixture: NativeFixture, call: Call) => Promise<Answer | void> | Answer | void; beforeStartup?: (ctx: Context) => Promise<void> }
export interface ControlledJob { finish(): void }
export class NativeFixture {
  readonly ctx = new Context()
  readonly calls: Call[] = []
  readonly events: SessionEvent[] = []
  readonly jobs: ControlledJob[] = []
  readonly toolResults: {name: string; error: boolean; code?: string}[] = []
  readonly waits = new Set<() => void>()
  scratch: string | undefined
  handle!: AgentHandle
  owner!: Fiber
  readonly options: FixtureOptions
  constructor(options: FixtureOptions = {}) { this.options = options }
  get agent(): Agent { return this.handle.agent }
  get goal() { return this.ctx.goals.get(this.agent) }
  get mainCalls(): number { return this.calls.filter(c => c.agent === this.agent).length }
  changed(): void { for (const check of [...this.waits]) check() }
  async until(predicate: () => boolean, stage = 'expected public state'): Promise<void> {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(check); reject(new Error('Synthetic fixture did not reach: ' + stage)) }, 2500)
      const check = () => { if (predicate()) { clearTimeout(timer); this.waits.delete(check); resolve() } }
      this.waits.add(check)
    })
  }
  async settle(): Promise<void> { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
  async initialize(): Promise<this> {
    const ctx = this.ctx
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(Agents)
    await ctx.plugin(Llm)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(Loop)
    await ctx.plugin(Goals)
    await ctx.plugin(Jobs)
    await ctx.plugin(Invariants)
    if (this.options.children) {
      this.scratch = await mkdtemp(join(tmpdir(), 'goal-driver-synthetic-'))
      await ctx.plugin(Persistence, {root: join(this.scratch, 'sessions'), compression: 'none'})
      await ctx.plugin(Query, {path: ':memory:', openAt: 'never'})
      await ctx.plugin(Subagents)
      await ctx.plugin(Spawn)
      await ctx.plugin(ToolSubagent, {provider: 'spawn', toolName: 'subagent', backgroundMode: 'one-shot', modelSelectionSettings: false, maxDepth: 2})
    }
    await ctx.plugin(ToolJobs, {completionDelivery: this.options.completionDelivery})
    await ctx.plugin(ToolGoal)
    await ctx.plugin(GoalInvariant)
    const fixture = this
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
        const agent = ctx.agents.currentInitiator()
        if (agent === undefined) throw new Error('Synthetic call has no exact native initiator')
        const call: Call = {agent, index: fixture.calls.filter(c => c.agent === agent).length + 1, signal: options.signal}
        fixture.calls.push(call); fixture.changed()
        const answer = (await fixture.options.onCall?.(fixture, call)) ?? {}
        options.signal?.throwIfAborted()
        if (answer.error) throw new Error('Synthetic provider error')
        const block = answer.tool
          ? {type: 'tool-call' as const, id: ToolCallId('synthetic-call-' + fixture.calls.length), name: answer.tool.name, arguments: JSON.stringify(answer.tool.args ?? {})}
          : {type: 'text' as const, text: 'Synthetic response.'}
        yield {type: 'block-start', index: 0, blockType: block.type}
        yield {type: 'block-end', index: 0, block}
        yield {type: 'finish', reason: {kind: answer.finish ?? (answer.tool ? 'tool-calls' : 'stop')}}
      }
    }
    ctx.llm.registerAdapter(['synthetic'], new Adapter())
    ctx.on('session/event', (session, event) => { if (session.id === this.handle?.agent.id) { this.events.push(event); this.changed() } })
    ctx.on('agent/status', () => this.changed())
    ctx.on('goal/activation-changed', () => this.changed())
    ctx.on('tools/result', (exec, result) => { this.toolResults.push({name: exec.name, error: result.isError, code: result.error?.info?.code}); this.changed() })
    if (this.options.decorateHandle) {
      const decorate = this.options.decorateHandle
      const factory = ctx.agentLoop
      const create = factory.createAgent
      factory.createAgent = async function (ownerCtx: Context, options: CreateAgentOptions) {
        return decorate(await create.call(this, ownerCtx, options), options)
      }
      const resume = factory.resume
      factory.resume = async function (ownerCtx: Context, options: ResumeAgentOptions) {
        return decorate(await resume.call(this, ownerCtx, options), options)
      }
    }
    await this.options.beforeStartup?.(ctx)
    this.owner = await ctx.plugin(goalWaitStartup, this.options.config ?? {strategy: 'replacement'})
    this.handle = await ctx.agents.create({sessionId: SessionId('synthetic-main'), agentOptions: {provider: 'synthetic', model: 'local'}})
    return this
  }
  startJob(): ControlledJob {
    const done = Promise.withResolvers<{status: 'completed'; result: string}>()
    this.ctx.jobs.start({kind: 'bash', label: 'Synthetic work', owner: this.agent.id, run: () => ({done: done.promise, cancel: () => done.resolve({status: 'completed', result: 'Synthetic cancelled cleanup'})})})
    const job = {finish: () => done.resolve({status: 'completed', result: 'Synthetic result'})}
    this.jobs.push(job)
    return job
  }
  createGoal(maxGoalRounds = 1): void { this.ctx.goals.create(this.agent, {objective: 'Synthetic objective', maxGoalRounds}) }
  human(text = 'Synthetic direct human request'): void { this.agent.followup(createUserMessage({content: [{type: 'text', text}], source: {kind: 'user'}})) }
  async dispose(): Promise<void> {
    if (this.handle && this.ctx.agents.get(this.agent.id) === this.agent) {
      const goal = this.goal
      if (goal && goal.phase !== 'complete') this.ctx.goals.complete(this.agent, goal)
    }
    for (const job of this.jobs) job.finish()
    if (this.handle) await this.handle.dispose()
    await this.ctx.fiber.dispose()
    if (this.scratch) {
      const target = resolve(this.scratch)
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('goal-driver-synthetic-')) throw new Error('Refusing unsafe synthetic-store cleanup')
      await rm(target, {recursive: true})
    }
  }
}
