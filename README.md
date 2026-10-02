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

**Hold and release.** While live work exists and the goal is `active` + `armed`, the gate calls `ctx.goals.disarm` and remembers the goal id it holds for the exact live agent; release reads the current revision. When no live work remains — the work settled *and* its completion-notice turn has ended — the gate calls `ctx.goals.resume` on its own hold. The official driver then performs its normal next round.

Policy boundaries:

- The durable goal phase is never touched. The gate never calls `pause`; only the process-local activation toggles.
- Goals the gate did not disarm are never resumed. A session-resume, fork, or driver-failure disarm with no existing gate-owned hold stays disarmed. A later external disarm overlapping an owned hold cannot be distinguished by activation alone; see the [ownership limitation](<docs/adr/0001-retain-activation-gate.md>) and upgrade scenarios.
- An explicit human re-arm wins for the rest of that wait: the gate drops its hold and does not fight it. The next wait is gated again.
- A `goal/changed` event (creation, edit, host resume) is evaluated before the official driver's own drive request, so a goal created while work is already pending cannot start an empty round.
- A goal that is no longer `active` is never disarmed and never re-armed. Completion, pausing, blocking, clearing, and replacement all disarm by themselves, and the driver only drives `active` + `armed` goals, so a finished goal produces no further rounds and this gate does not resurrect it.
- Nothing survives a host restart by design, and nothing needs to: continuation authority is process-local, so a restored goal reads `disarmed` until an explicit start. Every start (create, `/goal resume`, the goal tool, the GUI) commits and emits `goal/changed`, which this gate evaluates `prepend`ed, before the official driver's own drive request.
- Unloading the plugin re-arms the goals it still holds, so removing the gate restores official behavior instead of stranding a disarmed goal.
- Failures are contained and logged; a failing read never mutates a goal.

## Design decision and upstream watch

We deliberately retain the activation-based bridge for now; no runtime policy changes accompany this decision. Disarming does not pause, hide, or make a goal uneditable. In the checked DSH `0.2.0-rc.2` baseline, model edits require direct human input in the current top-level turn regardless of activation, and goal mutations do not automatically refresh model-visible context.

- [Decision and trade-offs (中文)](<docs/adr/0001-retain-activation-gate.md>): why we keep `disarm/resume` rather than reject or indefinitely await an already queued goal prompt.
- [DSH upgrade watch checklist (中文)](<docs/upstream-goal-watch.md>): scheduling seams, edit authority, goal visibility, lifecycle changes, isolated acceptance scenarios, and a version-review template.
- [Domain glossary](<CONTEXT.md>): goal phase, continuation activation, scheduling gate, owned hold, and goal visibility are distinct concepts.

A clean future migration requires a public scheduling defer **and re-evaluation** contract, or native upstream background-work awareness. Generic interception hooks exist today, but they are not by themselves that contract. Revisit this decision on DSH upgrades rather than treating the current implementation as proof that every interaction is covered.

## Requirements

- DSH `0.1.7-alpha.2` through `0.2.0-rc.2` (declared peer range `>=0.1.7-alpha.2 <0.3`). DSH 0.2 enforces these peers **at load time with prereleases included**: a range that does not accept the running version makes the loader refuse the plugin (the explicit override is `dsh plugin allow-version`). `pnpm check:hosts` verifies the range against every host in the matrix.
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
pnpm check:hosts   # typecheck every supported host in isolated copies (default: 0.1.7-alpha.2, 0.1.7-rc.2, 0.2.0-rc.2)
pnpm check:patch   # isolated dry run of the patch above against the local profile composition
pnpm check         # all of the above
```

On every DSH upgrade, follow the [upstream watch checklist](<docs/upstream-goal-watch.md>) and rerun `pnpm check:hosts <new-version>`. Widen the `@deepseek-ai/dsh*` peer ranges in `package.json` only if needed and after checking the new version’s behavior; matching types and peers alone do not prove runtime compatibility. DSH 0.2 and later refuse a plugin whose peers do not accept the running version — the boot log reads `disabling profile plugin goal-wait-gate: Plugin dsh-goal-wait-gate@<version> is incompatible with dsh <version>` — and `dsh plugin allow-version` is the explicit per-plugin override.

**Isolation.** Every check stays inside this repository. `check:hosts` installs each host's packages into its own `.host-compat/` copy; `check:patch` builds a `.patch-check/` DSH home that symlinks the profile's `node_modules` but copies its small config files, then runs `dsh --dump-config`. No live profile, session store, or running server is written to or contacted.

### Live acceptance (manual)

Use a dedicated disposable DSH home/profile and a test session. Do not reload a shared profile, restart a working GUI, or reuse other users’ running sessions for acceptance experiments. Adapt the install and patch examples to that isolated profile.

1. Build, mount, and patch as above in the isolated environment; reload only that test profile.
2. In its test session: create a goal, start a long background job (`run_in_background: true`), and end the turn asking the agent to wait for the completion notice.
3. **Pass**: no `<goal_round>` appears while the job runs; `get_goal` shows `active` + `disarmed` and the round count unchanged; exactly one continuation round follows the completion notice.
4. **Control**: with the plugin unmounted, the same sequence produces a `<goal_round>` within seconds.

## Development

- `pnpm test` runs `node --test` on the TypeScript sources directly (Node's type stripping).
- The single test seam is the plugin boundary: tests mount the real plugin on a real cordis context with fake `agents`/`goals`/`jobs` services and a goal-call ledger, drive the real event names and payloads, and assert which goal mutations happen when. A stand-in "official driver" listener is registered *before* the plugin so dispatch ordering is tested rather than assumed.

## License

MIT