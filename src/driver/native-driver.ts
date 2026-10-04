// Derived from @deepseek-ai/dsh-goal-round-driver 0.2.0-rc.2 (published bundle).
// Copyright (c) 2026 DeepSeek. MIT; see UPSTREAM-LICENSE.txt and provenance.json.
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { GoalMessageSource, GoalRef, GoalView } from '@deepseek-ai/dsh-goal';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, MessageId, MessageSource, UserMessage } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';
import { renderGoalRoundPrompt } from './prompt.ts';

/**
* Same-session goal-round driver over public agent, session, and goal services.
* @module @deepseek-ai/dsh-goal-round-driver
*/
export const name = "background-aware-goal-driver";
/** The policy is sampled only before reservation and at both pre-step fences. */
export interface DriverPolicy {
	allows(agent: Agent): boolean;
	subscribe(wake: (agent: Agent) => void): () => void;
}

interface Attempt extends Pick<GoalMessageSource, 'goalId' | 'revision' | 'round'> {
	messageId: MessageId;
	content: ContentBlock[];
	phase: 'queued' | 'claimed' | 'admitted';
	cancelled: boolean;
	stale: boolean;
}

interface DriverState {
	agent: Agent;
	attempt: Attempt | undefined;
	competingQueued: boolean;
	needsCheckpoint: boolean;
	requested: boolean;
	run: Promise<void> | undefined;
	stopping: boolean;
}
/** Whether a source identifies an automatic, positive-numbered goal round. */
function isGoalRoundSource(source: MessageSource): source is GoalMessageSource {
	return source.kind === "goal" && source.round > 0;
}
/** Compare a source to one reserved identity. */
function sameRound(source: GoalMessageSource, round: Pick<GoalMessageSource, 'goalId' | 'revision' | 'round'>): boolean {
	return source.goalId === round.goalId && source.revision === round.revision && source.round === round.round;
}
/** Compare the complete queued record to the driver's reservation. */
function sameQueued(content: readonly ContentBlock[], source: MessageSource, attempt: Attempt): boolean {
	return isGoalRoundSource(source) && sameRound(source, attempt) && isDeepStrictEqual(content, attempt.content);
}
/** Exact current ref for a view. */
function goalRef(goal: GoalView): GoalRef {
	return {
		id: goal.id,
		revision: goal.revision
	};
}
/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}
/** Install automatic same-session continuation and its race fences. */
export function installNativeDriver(ctx: Context, policy?: DriverPolicy): { stop(): Promise<void> } {
	const states = new Map<Agent, DriverState>();
	let stopping = false;
	let stopPromise: Promise<void> | undefined;
	let unsubscribe: (() => void) | undefined;
	const allows = (agent: Agent): boolean => policy?.allows(agent) ?? true;
	/** Create state for an exact currently live agent. */
	function stateFor(agent: Agent): DriverState | undefined {
		if (stopping) return void 0;
		const existing = states.get(agent);
		if (existing !== void 0) return existing;
		const state: DriverState = {
			agent,
			attempt: void 0,
			competingQueued: false,
			needsCheckpoint: false,
			requested: false,
			run: void 0,
			stopping: false
		};
		states.set(agent, state);
		return state;
	}
	/** Read only when the exact Agent remains live. */
	function currentGoal(state: DriverState): GoalView | undefined {
		if (ctx.agents.get(state.agent.id) !== state.agent) return void 0;
		return ctx.goals.get(state.agent);
	}
	/** Whether this exact lifecycle is quiescent with no competing prompt. */
	function readyToDrive(state: DriverState): boolean {
		return ctx.fiber.state === 2 && !stopping && !state.stopping && ctx.agents.get(state.agent.id) === state.agent && state.agent.status === "idle" && !state.competingQueued;
	}
	/** Recheck every condition that an awaited checkpoint may have changed. */
	function readyAfterCheckpoint(state: DriverState): boolean {
		return readyToDrive(state) && !state.needsCheckpoint;
	}
	/** Remove automatic authority while preserving the durable phase. */
	function disarm(state: DriverState): void {
		try {
			if (currentGoal(state)?.activation === "armed") ctx.goals.disarm(state.agent);
		} catch (error) {
			ctx.logger.warn(`goal-round-driver: could not disarm agent "${state.agent.id}": ${renderThrown(error)}`);
		}
	}
	/** Preserve claimed step context when this driver drops only its own round. */
	function restoreOtherClaimed(agent: Agent, messages: readonly UserMessage[], messageId: MessageId): void {
		const retained = messages.filter((message) => message.id !== messageId && !(message.source.kind === "goal" && message.source.round === 0));
		for (const message of retained.toReversed()) {
			if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id) || agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) continue;
			agent.inbox.prepend("next-step", message);
		}
	}
	/** Process admitted work at quiescence, then reserve at most one next round. */
	async function drive(state: DriverState): Promise<void> {
		const { agent } = state;
		if (!readyToDrive(state)) return;
		if (state.needsCheckpoint) {
			state.needsCheckpoint = false;
			try {
				await ctx.sessions.flush(agent.session);
			} catch (error) {
				ctx.logger.warn(`goal-round-driver: durability checkpoint failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
				return;
			}
			if (!readyAfterCheckpoint(state)) return;
		}
		if (state.attempt !== void 0) {
			state.attempt = void 0;
			state.needsCheckpoint = true;
			state.requested = true;
			return;
		}
		const goal = currentGoal(state);
		if (goal === void 0 || goal.phase !== "active" || goal.activation !== "armed") return;
		if (goal.roundsStarted >= goal.maxGoalRounds) {
			ctx.goals.block(agent, goalRef(goal), {
				code: "round-limit",
				message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`
			});
			return;
		}
		// Preserve native checkpoint, retirement, and cap handling even while held.
		if (!allows(agent)) return;
		const round = goal.roundsStarted + 1;
		const content = renderGoalRoundPrompt(goal, round);
		const message = createUserMessage({
			content,
			source: {
				kind: "goal",
				goalId: goal.id,
				revision: goal.revision,
				round
			}
		});
		state.attempt = {
			goalId: goal.id,
			revision: goal.revision,
			round,
			messageId: message.id,
			content,
			phase: "queued",
			cancelled: false,
			stale: false
		};
		try {
			agent.followup(message);
		} catch (error) {
			state.attempt = void 0;
			ctx.logger.warn(`goal-round-driver: could not queue round ${round} for agent "${agent.id}": ${renderThrown(error)}`);
			const latest = currentGoal(state);
			if (latest !== void 0 && latest.id === goal.id && latest.revision === goal.revision && latest.phase === "active" && latest.activation === "armed") ctx.goals.block(agent, goalRef(latest), {
				code: "queue-failed",
				message: `Could not queue goal round ${round}: ${renderThrown(error)}`
			});
		}
	}
	/** Coalesce triggers onto one agent-local serialized driver. */
	function requestDrive(state: DriverState): void {
		/* v8 ignore next -- teardown may race a final trigger after synchronously closing the step fence */
		if (stopping || state.stopping) return;
		state.requested = true;
		if (state.run !== void 0) return;
		let run: Promise<void>;
		try {
			run = ctx.agents.withoutInitiator(async () => {
				while (state.requested && !stopping && !state.stopping) {
					state.requested = false;
					try {
						await drive(state);
					} catch (error) {
						ctx.logger.warn(`goal-round-driver: driver failed for agent "${state.agent.id}": ${renderThrown(error)}`);
						disarm(state);
					}
				}
			});
		} catch (error) {
			ctx.logger.warn(`goal-round-driver: could not start driver for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			return;
		}
		state.run = run;
		const retire = () => {
			state.run = void 0;
			if (state.requested && !stopping && !state.stopping) requestDrive(state);
		};
		run.then(retire, (error) => {
			ctx.logger.warn(`goal-round-driver: driver task rejected for agent "${state.agent.id}": ${renderThrown(error)}`);
			disarm(state);
			retire();
		});
	}
	/** Close every fence synchronously; keep native listeners until the drain finishes. */
	function stop(): Promise<void> {
		if (stopPromise !== void 0) return stopPromise;
		stopping = true;
		// Publish the shared promise before callbacks from unsubscribe/disarm/cancel.
		let resolveStop: () => void = () => {};
		let rejectStop: (reason: unknown) => void = () => {};
		stopPromise = new Promise<void>((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		});
		const snapshot = [...states.values()];
		for (const state of snapshot) {
			state.stopping = true;
			state.requested = false;
			if (state.attempt !== void 0) state.attempt.stale = true;
		}
		const idleAgents: Agent[] = [];
		const waits: Promise<unknown>[] = [];
		let failed = false;
		let failure: unknown;
		const recordFailure = (error: unknown): void => {
			if (!failed) { failed = true; failure = error; }
		};
		try {
			const disposePolicy = unsubscribe;
			unsubscribe = void 0;
			disposePolicy?.();
		} catch (error) { recordFailure(error); }
		// Finish all synchronous revocation/cancellation before requesting drain promises.
		for (const state of snapshot) {
			disarm(state);
			if (state.attempt !== void 0 && state.agent.status === "running") {
				idleAgents.push(state.agent);
				try {
					state.agent.cancel({ kind: "parent" });
				} catch (error) { recordFailure(error); }
			}
			if (state.run !== void 0) waits.push(state.run);
		}
		for (const agent of idleAgents) {
			try { waits.push(agent.whenIdle()); }
			catch (error) { recordFailure(error); }
		}
		void Promise.allSettled(waits).then((results) => {
			for (const result of results) if (result.status === "rejected") recordFailure(result.reason);
			states.clear();
			if (failed) rejectStop(failure);
			else resolveStop();
		});
		return stopPromise;
	}
	ctx.effect(function* () {
		ctx.on("agent/error", ({ agent }) => {
			const state = stateFor(agent);
			if (state !== void 0) disarm(state);
		});
		ctx.on("agent/disposed", ({ agent }) => {
			if (!stopping) states.delete(agent);
		});
		ctx.on("agent/created", ({ agent }): undefined => {
			const state = stateFor(agent);
			if (state === void 0) return;
			state.attempt = void 0;
			state.competingQueued = false;
			state.needsCheckpoint = false;
		});
		ctx.on("agent/status", ({ agent, status }) => {
			const state = stateFor(agent);
			if (state === void 0) return;
			if (status === "idle") {
				state.competingQueued = false;
				const attempt = state.attempt;
				const goal = currentGoal(state);
				if (attempt !== void 0 && (attempt.phase === "queued" || attempt.phase === "claimed" || attempt.cancelled) && goal !== void 0 && goal.phase === "active" && goal.activation === "armed" && attempt.goalId === goal.id && attempt.revision === goal.revision) {
					state.attempt = void 0;
					try {
						ctx.goals.pause(agent, goalRef(goal));
					} catch (error) {
						ctx.logger.warn(`goal-round-driver: could not pause cancelled goal for agent "${agent.id}": ${renderThrown(error)}`);
						disarm(state);
					}
				}
				requestDrive(state);
			}
		});
		ctx.on("goal/changed", ({ agent, change }) => {
			const state = stateFor(agent);
			if (state === void 0) return;
			state.needsCheckpoint = true;
			if (change.operation === "pause" && agent.status === "running" && ctx.agents.currentInitiator() !== agent) agent.cancel({ kind: "user" }, { keepInbox: true });
			requestDrive(state);
		});
		ctx.on("agent/inbox/inserted", ({ agent, message }) => {
			if (!agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) return;
			const state = stateFor(agent);
			if (state === void 0) return;
			const attempt = state.attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) return;
			state.competingQueued = true;
			if (attempt?.phase === "queued") attempt.stale = true;
		});
		ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const attempt = stateFor(agent)?.attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) attempt.phase = "claimed";
		});
		ctx.on("agent/inbox/discarded", ({ agent, message }) => {
			const attempt = stateFor(agent)?.attempt;
			if (attempt !== void 0 && sameQueued(message.content, message.source, attempt)) attempt.cancelled = true;
		});
		ctx.on("session/event", (session, event) => {
			const agent = ctx.agents.get(session.id);
			if (agent === void 0 || agent.session !== session) return;
			const state = stateFor(agent);
			if (state === void 0) return;
			switch (event.type) {
				case "user/message":
					if (state.attempt !== void 0 && event.data.id === state.attempt.messageId) state.attempt.phase = "admitted";
					return;
				case "turn/end":
					if (event.data.reason.kind === "max-tokens") {
						disarm(state);
						return;
					}
					if (event.data.reason.kind !== "aborted") return;
					if (state.attempt?.phase === "claimed" || state.attempt?.phase === "admitted") state.attempt.cancelled = true;
					else disarm(state);
					return;
				default: return;
			}
		});
		/** Fail closed unless the queued prompt still owns the exact live revision. */
		function validReservation(state: DriverState, content: readonly ContentBlock[], source: GoalMessageSource): boolean {
			const attempt = state.attempt;
			const goal = currentGoal(state);
			return ctx.fiber.state === 2 && !stopping && !state.stopping && attempt !== void 0 && attempt.phase === "claimed" && !attempt.stale && sameQueued(content, source, attempt) && goal !== void 0 && goal.id === source.goalId && goal.revision === source.revision && goal.phase === "active" && goal.activation === "armed" && source.round === goal.roundsStarted + 1 && allows(state.agent);
		}
		ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
			const submitted = messages.find((message): message is UserMessage & { readonly source: GoalMessageSource } => isGoalRoundSource(message.source));
			if (submitted === void 0) return next();
			const { content, source } = submitted;
			const state = stateFor(agent);
			if (state === void 0) {
				restoreOtherClaimed(agent, messages, submitted.id);
				return { kind: "reject" };
			}
			let valid = false;
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`goal-round-driver: pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
			}
			if (!valid) {
				const attempt = state.attempt;
				if (attempt !== void 0 && sameRound(source, attempt)) {
					attempt.stale = true;
					state.attempt = void 0;
				}
				restoreOtherClaimed(agent, messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			let decision: PreStepDecision;
			try {
				decision = await next();
			} catch (error) {
				if (signal.aborted) throw error;
				state.attempt = void 0;
				requestDrive(state);
				throw error;
			}
			if (signal.aborted) {
				if (decision.kind === "enter") restoreOtherClaimed(agent, decision.messages, submitted.id);
				return decision;
			}
			if (decision.kind === "reject") {
				state.attempt = void 0;
				const goal = currentGoal(state);
				if (goal !== void 0 && goal.id === source.goalId && goal.revision === source.revision && goal.phase === "active" && goal.activation === "armed") ctx.goals.block(agent, goalRef(goal), {
					code: "prompt-rejected",
					message: "Goal round was rejected before entering its step."
				});
				return decision;
			}
			try {
				valid = validReservation(state, content, source);
			} catch (error) {
				ctx.logger.warn(`goal-round-driver: post-decision check failed for agent "${agent.id}": ${renderThrown(error)}`);
				disarm(state);
				valid = false;
			}
			if (!valid) {
				state.attempt = void 0;
				restoreOtherClaimed(agent, decision.messages, submitted.id);
				requestDrive(state);
				return { kind: "reject" };
			}
			return {
				...decision,
				startsRequestSeries: true
			};
		});
		for (const agent of ctx.agents.list()) {
			const state = stateFor(agent);
			if (state !== void 0) disarm(state);
		}
		// Install inside the composite effect, after the native mount disarm.
		// An eager subscription callback therefore sees all native fences installed.
		unsubscribe = policy?.subscribe((agent) => {
			if (stopping || ctx.fiber.state !== 2 || ctx.agents.get(agent.id) !== agent) return;
			const state = stateFor(agent);
			if (state !== void 0) requestDrive(state);
		});
		// Cordis unwinds this finalizer before removing the listeners above.
		yield stop;
	}, "background-aware-goal-driver lifecycle");
	return { stop };
}
