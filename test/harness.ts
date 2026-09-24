/**
 * The single test seam for dsh-goal-wait-gate: the plugin boundary.
 *
 * Tests mount the real plugin on a real cordis context whose DSH services are
 * fakes, drive the exact events the harness dispatches, and observe only the
 * goal mutations the plugin performs through the goal service interface.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalActivationChanged, GoalChanged } from '@deepseek-ai/dsh-goal'
import type { JobView } from '@deepseek-ai/dsh-jobs'
import { goalWaitGate, type Config } from '../src/index.ts'

export type Activation = 'armed' | 'disarmed'
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'
export type JobStatus = 'running' | 'stopping' | 'settled'

export interface FakeSession {
  id: string
  header: { parentSession?: string; origin?: string }
}

export interface FakeAgent {
  id: string
  status: 'idle' | 'running'
  session: FakeSession
}

export interface FakeGoal {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  activation: Activation
  roundsStarted: number
  maxGoalRounds: number
}

export interface FakeJob {
  id: string
  label: string
  status: JobStatus
  owner?: string
}

export interface GoalCall {
  kind: 'get' | 'disarm' | 'resume' | 'pause'
  agentId: string
  goalId?: string
  revision?: number
  seq: number
}

export class FakeAgents extends Service {
  readonly items = new Map<string, FakeAgent>()

  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  add(agent: FakeAgent): FakeAgent {
    this.items.set(agent.id, agent)
    return agent
  }

  drop(id: string): void {
    this.items.delete(id)
  }

  get(id: string): FakeAgent | undefined {
    return this.items.get(id)
  }

  list(): FakeAgent[] {
    return [...this.items.values()]
  }
}

export class FakeGoals extends Service {
  readonly calls: GoalCall[] = []
  private seq = 0
  private readonly bySession = new Map<string, FakeGoal>()

  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  set(sessionId: string, goal: FakeGoal | undefined): void {
    if (goal === undefined) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, goal)
  }

  peek(agent: FakeAgent): FakeGoal | undefined {
    return this.bySession.get(agent.session.id)
  }

  get(agent: FakeAgent): FakeGoal | undefined {
    const goal = this.bySession.get(agent.session.id)
    this.record('get', agent, goal)
    return goal === undefined ? undefined : { ...goal }
  }

  disarm(agent: FakeAgent): FakeGoal | undefined {
    const goal = this.bySession.get(agent.session.id)
    this.record('disarm', agent, goal)
    if (goal === undefined) return undefined
    goal.activation = 'disarmed'
    this.ctx.emit('goal/activation-changed', {
      sessionId: agent.session.id,
      goal: { id: goal.id, revision: goal.revision, activation: goal.activation },
    } as unknown as GoalActivationChanged)
    return { ...goal }
  }

  resume(agent: FakeAgent, ref: { id: string; revision: number }): FakeGoal {
    const goal = this.bySession.get(agent.session.id)
    this.record('resume', agent, goal, ref)
    if (goal === undefined) throw new Error('fake goals: no current goal to resume')
    if (goal.phase !== 'active' || goal.activation !== 'disarmed') {
      throw new Error(`fake goals: goal is ${goal.phase}/${goal.activation}, not active/disarmed`)
    }
    if (goal.id !== ref.id || goal.revision !== ref.revision) throw new Error('fake goals: stale ref')
    goal.activation = 'armed'
    goal.revision += 1
    this.ctx.emit('goal/changed', {
      agent: agent as unknown as Agent,
      change: { operation: 'resume', ref: { id: goal.id, revision: goal.revision } } as unknown as GoalChanged,
    })
    return { ...goal }
  }

  pause(agent: FakeAgent, ref: { id: string; revision: number }): FakeGoal {
    const goal = this.bySession.get(agent.session.id)
    this.record('pause', agent, goal, ref)
    if (goal === undefined) throw new Error('fake goals: no current goal to pause')
    goal.phase = 'paused'
    goal.activation = 'disarmed'
    return { ...goal }
  }

  byKind(kind: GoalCall['kind']): GoalCall[] {
    return this.calls.filter((call) => call.kind === kind)
  }

  private record(kind: GoalCall['kind'], agent: FakeAgent, goal?: FakeGoal, ref?: { id: string; revision: number }): void {
    this.calls.push({
      kind,
      agentId: agent.id,
      goalId: ref?.id ?? goal?.id,
      revision: ref?.revision ?? goal?.revision,
      seq: ++this.seq,
    })
  }
}

export class FakeJobs extends Service {
  readonly items: FakeJob[] = []

  constructor(ctx: Context) {
    super(ctx, 'jobs')
  }

  add(job: FakeJob): FakeJob {
    this.items.push(job)
    return job
  }

  settle(id: string): void {
    const job = this.items.find((candidate) => candidate.id === id)
    if (job !== undefined) job.status = 'settled'
  }

  list(caller?: string): JobView[] {
    return this.items
      .filter((job) => job.owner === undefined || job.owner === caller)
      .map((job) => ({ ...job })) as unknown as JobView[]
  }
}

export interface Harness {
  ctx: Context
  agents: FakeAgents
  goals: FakeGoals
  jobs: FakeJobs
  observations: (Activation | undefined)[]
  agent(id: string, options?: { parent?: string; status?: 'idle' | 'running' }): FakeAgent
  goal(agent: FakeAgent, overrides?: Partial<FakeGoal>): FakeGoal
  job(owner: FakeAgent | undefined, overrides?: Partial<FakeJob>): FakeJob
  turnStopping(agent: FakeAgent): Promise<void>
  idle(agent: FakeAgent): void
  unload(): Promise<void>
  dispose(): Promise<void>
}

export async function createHarness(options: { config?: Config; driver?: boolean } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(FakeAgents)
  await ctx.plugin(FakeGoals)
  await ctx.plugin(FakeJobs)
  const agents = ctx.agents as unknown as FakeAgents
  const goals = ctx.goals as unknown as FakeGoals
  const jobs = ctx.jobs as unknown as FakeJobs
  const observations: (Activation | undefined)[] = []

  if (options.driver !== false) {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      observations.push(goals.peek(agent as unknown as FakeAgent)?.activation)
    })
  }

  const fiber = ctx.plugin(goalWaitGate, options.config)
  await fiber

  let n = 0
  return {
    ctx,
    agents,
    goals,
    jobs,
    observations,
    agent(id, overrides = {}) {
      return agents.add({
        id,
        status: overrides.status ?? 'idle',
        session: { id: `session-${id}`, header: overrides.parent === undefined ? {} : { parentSession: overrides.parent, origin: 'subagent' } },
      })
    },
    goal(agent, overrides = {}) {
      const goal: FakeGoal = {
        id: 'goal-1',
        revision: 1,
        objective: 'ship the thing',
        phase: 'active',
        activation: 'armed',
        roundsStarted: 0,
        maxGoalRounds: 256,
        ...overrides,
      }
      goals.set(agent.session.id, goal)
      return goal
    },
    job(owner, overrides = {}) {
      return jobs.add({
        id: `job-${++n}`,
        label: 'background work',
        status: 'running',
        ...(owner === undefined ? {} : { owner: owner.session.id }),
        ...overrides,
      })
    },
    async turnStopping(agent) {
      agent.status = 'running'
      await ctx.emit('agent/turn-stopping', { agent: agent as unknown as Agent, turn: 1, signal: new AbortController().signal })
    },
    idle(agent) {
      agent.status = 'idle'
      ctx.emit('agent/status', { agent: agent as unknown as Agent, status: 'idle' })
    },
    async unload() {
      await fiber.dispose()
    },
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}
