# dsh-goal-wait-gate

A DeepSeek Harness (DSH) plugin that **withholds automatic goal continuation while the owning agent still has live background work**.

It is a bridge, not a fork: the official goal packages stay exactly as they are. The plugin reads public services and toggles only the goal's process-local continuation activation, which is the input the official `dsh-goal-round-driver` reads at every idle.

## The problem

The official driver injects a `<goal_round>` prompt whenever an agent is idle and its goal is active and armed. Idle only means "no turn is currently running", so an agent that deliberately ended its turn to wait for a background job or a background subagent is indistinguishable from one with nothing left to do. Every waiting gap becomes another goal round: the round budget is consumed, the whole session is re-prefilled, and models start reading the round count as elapsed time — sometimes interrupting healthy long-running subagents.

This is a known, still-unfixed upstream behavior through DSH `0.1.7-rc.1` (discussions [#4664](https://github.com/deepseek-ai/deepseek-harness/discussions/4664), [#4715](https://github.com/deepseek-ai/deepseek-harness/discussions/4715), [#1421](https://github.com/deepseek-ai/deepseek-harness/discussions/1421)).

## What the gate does

**Live work** for one session is:

- a background job owned by the session whose status is `running` or `stopping` (read synchronously from `ctx.jobs.list`), or
- a live subagent descendant at any depth (live agents whose session header names a parent and carries the `subagent` origin), which covers one-shot and continuable children without resuming anything.

**Checkpoints.** The gate evaluates at `agent/turn-stopping` (the turn loop awaits it, so the decision lands before the agent turns idle) and at `agent/status` with status `idle` (registered with `prepend` as a safety net for turn shapes that end without `turn-stopping`).

**Hold and release.** While live work exists and the goal is `active` + `armed`, the gate calls `ctx.goals.disarm` and remembers the exact `{goalId, revision}` it owns. When no live work remains — the work settled *and* its completion-notice turn has ended — the gate calls `ctx.goals.resume` on its own hold. The official driver then performs its normal next round.

Policy boundaries:

- The durable goal phase is never touched. The gate never calls `pause`; only the process-local activation toggles.
- Goals the gate did not disarm are never resumed. A session-resume, fork, or driver-failure disarm stays disarmed, as the official design requires.
- An explicit human re-arm wins for the rest of that wait: the gate drops its hold and does not fight it. The next wait is gated again.
- A `goal/changed` event (creation, edit, host resume) is evaluated before the official driver's own drive request, so a goal created while work is already pending cannot start an empty round.
- Unloading the plugin re-arms the goals it still holds, so removing the gate restores official behavior instead of stranding a disarmed goal.
- Failures are contained and logged; a failing read never mutates a goal.

## Requirements

- DSH `0.1.7-alpha.2`, `0.1.7-rc.1`, or `0.1.7-rc.2` (declared peer range `>=0.1.7-alpha.2 <0.1.8`; the same-tuple prerelease comparator is what lets the `rc` prereleases satisfy it).
- Node >= 22.
- Services: `agents` and `goals` are required; `jobs` is optional (without it, only subagent work gates).

## Install

```bash
pnpm install
pnpm build
```

Make the package resolvable from the profile (any install method works; this uses the profile's own pnpm):

```bash
dsh plugin --profile web add /absolute/path/to/dsh-goal-wait-gate
```

Then add this to the profile's patch layer, `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: goal-wait-gate
      name: 'dsh-goal-wait-gate'
      config:
        waitForJobs: true
        waitForSubagents: true
        maxHoldMs: 0
```

**Do not disable `goal-round-driver`.** The gate is designed to sit beside it: the driver still owns round reservation, the round prompt, accounting, and the race fences; the gate only decides whether continuation is armed.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `waitForJobs` | `true` | Hold continuation while the session owns running/stopping jobs. |
| `waitForSubagents` | `true` | Hold continuation while the session owns live subagent descendants. |
| `maxHoldMs` | `0` | `0` holds indefinitely. A positive value releases a hold that outlives it, logs one warning per hold, and leaves the rest of that wait ungated (the release is not undone by the gate's own goal-change evaluation) — an escape hatch for stuck background work, not a silent stop. |

Invalid configuration fails at load with an error naming the field.

## Verification

```bash
pnpm typecheck     # TypeScript, no emit
pnpm test          # boundary tests (real cordis context, fake DSH services)
pnpm check:hosts   # typecheck against 0.1.7-alpha.2 and 0.1.7-rc.1 in isolated copies
pnpm check:patch   # isolated dry run of the patch above against the local profile composition
pnpm check         # all of the above
```

**Isolation.** Every check stays inside this repository. `check:hosts` installs each host's packages into its own `.host-compat/` copy; `check:patch` builds a `.patch-check/` DSH home that symlinks the profile's `node_modules` but copies its small config files, then runs `dsh --dump-config`. No live profile, session store, or running server is written to or contacted.

### Live acceptance (manual)

1. Build, mount, and patch as above; reload the profile.
2. In a session: create a goal, start a long background job (`run_in_background: true`), and end the turn asking the agent to wait for the completion notice.
3. **Pass**: no `<goal_round>` appears while the job runs; `get_goal` shows `active` + `disarmed` and the round count unchanged; exactly one continuation round follows the completion notice.
4. **Control**: with the plugin unmounted, the same sequence produces a `<goal_round>` within seconds.

## Development

- `pnpm test` runs `node --test` on the TypeScript sources directly (Node's type stripping).
- The single test seam is the plugin boundary: tests mount the real plugin on a real cordis context with fake `agents`/`goals`/`jobs` services and a goal-call ledger, drive the real event names and payloads, and assert which goal mutations happen when. A stand-in "official driver" listener is registered *before* the plugin so dispatch ordering is tested rather than assumed.

## License

MIT