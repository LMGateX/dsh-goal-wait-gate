// Derived from @deepseek-ai/dsh-goal-round-driver 0.2.0-rc.2 (published bundle).
// Copyright (c) 2026 DeepSeek. MIT; see UPSTREAM-LICENSE.txt and provenance.json.
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { GoalView } from '@deepseek-ai/dsh-goal';

/** Model-visible continuation prompt for one same-session goal round. */
/**
* Render the complete goal-round instruction retained in session history.
* @param goal - exact active goal revision being admitted.
* @param round - next positive round number.
* @returns a fresh one-block prompt for `Agent.followup()`.
*/
export function renderGoalRoundPrompt(goal: GoalView, round: number): ContentBlock[] {
	return [{
		type: "text",
		text: `<goal_round>
Objective: ${JSON.stringify(goal.objective)}\nRound: ${round}/${goal.maxGoalRounds}\n\nContinue working toward the objective in this same session. Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current. Make concrete progress and verify the result. Before claiming completion, gather evidence that the whole objective is achieved, read the current goal, and mark it complete. If work remains, leave the goal active for the next round. Follow the configured goal-tool policy before reporting a blocker.
</goal_round>`
	}];
}
