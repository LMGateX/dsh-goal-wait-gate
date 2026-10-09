# dsh-goal-wait-gate

A DeepSeek Harness (DSH) plugin that **withholds automatic goal continuation while the owning agent still has live background work**.

**The root entry owns the continuation slot.** The bundle layer disables DSH's own `goal-round-driver` row and this plugin mounts a driver per `strategy` — by default the host's published native driver plus the activation bridge: a bridge, not a fork, because the official goal packages stay exactly as they are and only the goal's process-local continuation activation is toggled, which is the input the official driver reads at every idle.

## Opt-in startup owner (0.2.1 preview)

A separate TypeScript `dsh-goal-wait-gate/startup` export implements mutually exclusive activation (default), replacement, native and off startup strategies, ported against the exact published goal-round drivers of DSH `0.2.0-rc.2` and `0.2.1-alpha.1`. It does **not** change the root export or the default strategy. [Support contract and delivery status](<docs/startup-driver.md>) and [opt-in decision](<docs/adr/0002-opt-in-pinned-driver.md>) describe the pin table, direct-root-only bootstrap, work/cleanup limits and the explicit late-admission counterexample. It is **not an ordinary profile/Loader row or GUI integration**, and no hot switching is supported. Since 0.4.0 the ordinary profile row above delivers the same four strategies (`activation` default, `replacement`, `native`, `off`) through a Plugins-page form, so this boot API matters only for a host that cannot be composed as a normal profile.

0.4.0 is a GitHub release (tag `v0.4.0`, installable tarball attached); it is not published to npm, so install it from the release tarball or a checkout. It declares one runtime dependency, `@deepseek-ai/schemastery` — the package DSH itself ships, resolved the way every profile plugin resolves host packages — plus peer dependencies that are mostly optional. The development lock graph was regenerated incidentally during implementation, so clean frozen-lock installation and native dependency-build policy for repository development remain unverified.

## The problem

The official driver injects a `<goal_round>` prompt whenever an agent is idle and its goal is active and armed. Idle only means "no turn is currently running", so an agent that deliberately ended its turn to wait for a background job or a background subagent is indistinguishable from one with nothing left to do. Every waiting gap becomes another goal round: the round budget is consumed, the whole session is re-prefilled, and models start reading the round count as elapsed time — sometimes interrupting healthy long-running subagents.

This is a known, still-unfixed upstream behavior through DSH `0.2.1-alpha.1` (discussions [#4664](https://github.com/deepseek-ai/deepseek-harness/discussions/4664), [#4715](https://github.com/deepseek-ai/deepseek-harness/discussions/4715), [#1421](https://github.com/deepseek-ai/deepseek-harness/discussions/1421)).

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
- [Domain glossary](<GLOSSARY.md>): goal phase, continuation activation, scheduling gate, owned hold, and goal visibility are distinct concepts.
- [Turn-stopping wait feasibility research (中文)](<docs/research/turn-stopping-wait-gate.md>): 30 isolated native-module scenarios, a conditional running-wait design, and remaining migration risks. The prototype stays on a separate research branch; the installed gate is unchanged.
- [Driver replacement and selectable-strategy research (中文)](<docs/research/goal-driver-replacement.md>): 32 separate native-module scenarios, measured native-derived scheduler deltas, notice/admission race limits, and the custom configuration-page/exclusive-owner contract. The separate opt-in startup implementation now follows this research; it is not deployed and does not add hot switching.

A clean future migration requires a public scheduling defer **and re-evaluation** contract, or native upstream background-work awareness. Generic interception hooks exist today, but they are not by themselves that contract. Revisit this decision on DSH upgrades rather than treating the current implementation as proof that every interaction is covered.

## Requirements

- DSH `0.1.7-alpha.2` through `0.2.0-rc.2` (declared peer range `>=0.1.7-alpha.2 <0.3`). DSH 0.2 enforces these peers **at load time with prereleases included**: a range that does not accept the running version makes the loader refuse the plugin (the explicit override is `dsh plugin allow-version`). `pnpm check:hosts` verifies the range against every host in the matrix.
- Node >= 22.
- Services: `agents` and `goals` are required; `sessions` must exist for a driver to mount (the row reports and mounts nothing without it); `jobs` is optional (without it, only subagent work gates).
- The opt-in `dsh-goal-wait-gate/startup` owner is stricter than that peer range: it runs only on an exactly pinned published host — today `0.2.0-rc.2` and `0.2.1-alpha.1` — matched by package versions **and** the published native driver SHA-256 together. Any other distribution, including a newer alpha, is refused before a driver is mounted. Support is per artifact identity, not a version range; see the [support contract](<docs/startup-driver.md>).

## Install

```bash
pnpm install
pnpm build
```

The package ships a **DSH bundle layer** (`cordis.patch.yml`), so the ordinary bundle path installs and mounts it in one step:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-goal-wait-gate   # checkout, tarball or link:<path>
```

That records the dependency and appends `dsh-goal-wait-gate` to the profile's `dsh.profile.bundles`, which is what switches the layer on; the sidebar **Plugins** page then lists it with its row, an on/off switch, its version and a configuration form. That form is this package's own **browser half** (`client/client.js`, declared by `exports["./client"]` and `dsh.client` in `package.json`): the page renders a `plugins.row.config` slot that every plugin has to fill itself, so a row with a described namespace but no client bundle shows no controls. The bundle registers under key `dsh-goal-wait-gate#goal-wait-gate` only while the host serves that namespace, renders a strategy selector plus the three policy controls under the same Chinese labels as `locale/zh.json`, and saves with one revision-fenced mutation; the host applies it live. `dsh plugin --profile web remove dsh-goal-wait-gate` removes both again, and with them the `disabled: true` entry this layer puts on the host's own `goal-round-driver` row, so official behaviour returns. To mount it by hand instead, add the package to `dsh.profile.bundles` and leave the profile patch layer alone.

**Migrating from a pre-bundle install:** delete the block between `# >>> dsh-goal-wait-gate >>>` and `# <<< dsh-goal-wait-gate <<<` in `$DSH_HOME/profiles/web/cordis.patch.yml`. The bundle layer mounts the same row id, so keeping both mounts the gate twice.

**One row owns the continuation slot.** The layer disables DSH's own `goal-round-driver` row (mounted by `@deepseek-ai/dsh-base`) and this plugin mounts the driver itself, so the two can never race. `strategy` selects which driver. Every field of the row schema is **volatile**: the host hands it over as a live accessor, and a saved change applies at once — no row remount and no restart. The form itself is `client/client.js`, the package's browser half (see the install section above). `strategy` switches the mounted driver at the next checkpoint (a turn boundary, an idle edge or a goal change); `waitForJobs`, `waitForSubagents` and `maxHoldMs` are re-read at each gate evaluation:

| `strategy` | Who drives | Composition change |
|---|---|---|
| `activation` (default) | the host's published native driver, mounted by this plugin, plus the disarm/resume gate | none beyond this layer |
| `replacement` | this plugin's pinned TypeScript port, waiting on background eligibility | none |
| `native` | the host's published native driver, untouched: official DSH behaviour | none |
| `off` | nothing: the gate holds every goal, so nothing continues automatically | none |

Policy defaults live in the plugin's Schemastery schema: `strategy=activation`, `waitForJobs=true`, `waitForSubagents=true`, `maxHoldMs=0`. The profile patch layer is applied **after** every bundle, so it still overrides them — the Plugins page writes exactly such an entry when you save the form:

```yaml
- id: goal-wait-gate
  config:
    strategy: native
    waitForJobs: false
```

**Three ways back to official behaviour**, none of which writes to your profile by hand: pick `native` in the form; uninstall the plugin (the layer, including its `disabled` entry, disappears with it); or switch the row off. Switching the row off means *no automatic goal continuation* — the plugin is what mounts a driver — so prefer `native` when you want DSH's own behaviour to continue.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `strategy` | `activation` | Which implementation owns goal continuation: `activation`, `replacement`, `native` or `off` (see the table above). |
| `waitForJobs` | `true` | Hold continuation while the session owns running/stopping jobs. |
| `waitForSubagents` | `true` | Hold continuation while the session owns live subagent descendants. |
| `maxHoldMs` | `0` | `0` holds indefinitely. A positive value releases a hold that outlives it, logs one warning per hold, and leaves the rest of that wait ungated (the release is not undone by the gate's own goal-change evaluation) — an escape hatch for stuck background work, not a silent stop. |

Invalid configuration fails at load with an error naming the field. A saved change is validated on the same path: a bad value is reported and the last good policy stays in force.

**Why volatile matters.** `@deepseek-ai/dsh-settings` builds a form only from volatile fields (`volatileForm` returns nothing when no field carries `meta.volatile`), so a row with a plain schema loads fine and still shows no configuration at all. Volatility is also what makes the save live: cordis rejects a volatile node beneath a volatile ancestor, so the union branches stay plain under the volatile `strategy` field.

## Which driver is really live

`strategy` is a request, not a promise. A host this build does not pin, a port
mount failure or a foreign driver makes the plugin fall back to the host driver
beside the gate. The two shapes hold continuation differently — the ported
driver simply never queues the next round and leaves the goal `active`/`armed`,
while the activation gate holds by **disarming** the goal — and they look alike
in a transcript. The plugin therefore writes what it mounted, and why, to
`$DSH_HOME/goal-wait-gate.status.json` (`~/.dsh` when the launcher exported no
home):

```json
{
  "at": "2026-10-09T14:02:11.000Z",
  "requested": "replacement",
  "mounted": "replacement-port",
  "host": { "distribution": "0.2.1-alpha.1", "cordis": "4.0.5-alpha.1", "driverSha256": "68ed0920…" }
}
```

`mounted` is one of `replacement-port`, `host-driver+gate`, `host-driver` or
`none`; `fallback` carries the reason whenever `mounted` does not honour
`requested`. Writing it is best-effort by contract — losing the file never
affects continuation.

## Verification

```bash
pnpm typecheck     # TypeScript, no emit (development tests/build require Node 24+)
pnpm test          # native startup/ownership assertions plus separate legacy fake-service tests
pnpm check:hosts   # legacy entry/tests ONLY; typecheck supported hosts in isolated copies (default: 0.1.7-alpha.2, 0.1.7-rc.2, 0.2.0-rc.2)
node scripts/check-startup-host.ts <dir>  # typecheck the shipped src/ against a DSH installation that already exists; reports whether that exact identity is pinned
pnpm check:bundle  # isolated dry run of the shipped bundle layer against the local profile composition
node scripts/check-settings-form.mjs  # mount the plugin on a real cordis context and ask the installed dsh-settings service for the row's namespace
pnpm check         # all of the above
```

On every DSH upgrade, follow the [upstream watch checklist](<docs/upstream-goal-watch.md>), rerun `pnpm check:hosts <new-version>`, and run the startup host gate against the new installation. A new host pin requires porting the published driver difference and its fingerprint, not just widening a range. Widen the `@deepseek-ai/dsh*` peer ranges in `package.json` only if needed and after checking the new version’s behavior; matching types and peers alone do not prove runtime compatibility. DSH 0.2 and later refuse a plugin whose peers do not accept the running version — the boot log reads `disabling profile plugin goal-wait-gate: Plugin dsh-goal-wait-gate@<version> is incompatible with dsh <version>` — and `dsh plugin allow-version` is the explicit per-plugin override.

**Isolation.** Every check stays inside this repository. The startup host gate never installs: it only reads a DSH installation the operator points at, through symlinks, and writes its copy of `src/` under `.host-compat/`. `check:hosts` installs each host's packages into its own `.host-compat/` copy; `check:bundle` builds a `.bundle-check/` DSH home that symlinks the profile's `node_modules` (this repository standing in for the installed plugin) but copies its small config files, strips the pre-bundle insert from that copy, then runs `dsh --dump-config` twice and asserts what the host's own `readProfilePlugins`/`readPluginMeta`/compatibility readers see. No live profile, session store, or running server is written to or contacted.

### Live acceptance (manual)

Use a dedicated disposable DSH home/profile and a test session. Do not reload a shared profile, restart a working GUI, or reuse other users’ running sessions for acceptance experiments. Adapt the install and patch examples to that isolated profile.

1. Build and mount as above in the isolated environment; reload only that test profile.
2. In its test session: create a goal, start a long background job (`run_in_background: true`), and end the turn asking the agent to wait for the completion notice.
3. **Pass**: no `<goal_round>` appears while the job runs; `get_goal` shows `active` + `disarmed` and the round count unchanged; exactly one continuation round follows the completion notice.
4. **Control**: with the plugin unmounted, the same sequence produces a `<goal_round>` within seconds.

### Isolated end-to-end check

The unit suite mounts the plugin in-process, where its own install layout does not
exist. `npm run check:e2e` covers that gap: it installs the packed tarball into a
throwaway `DSH_HOME`, boots the real server three times, and reads back which goal
driver is live from the status record.

```bash
npm run build && npm pack --ignore-scripts
DSH_BIN=/path/to/dsh npm run check:e2e
```

The three runs are `replacement`, `replacement --stale-peers` and `activation`. The
middle one replays the layout that used to break this plugin: pnpm auto-installs a
plugin's declared peers *inside its own folder*, so `@deepseek-ai/cordis@4.0.4` and
`@deepseek-ai/dsh-agent@0.1.7-rc.2` sat beside the host's `4.0.5-alpha.1` and
`0.2.1-alpha.1`. Reading identity from the plugin's own tree described those copies,
no pinned host matched, and `replacement` fell back to the disarming gate - while the
page still said `replacement`. Identity is now read from the profile's scope first
(see `hostScopes`), and every declared peer is optional so pnpm stops installing
stale copies at all.

## Development

- `pnpm test` runs `node --test` on the TypeScript sources directly (Node's type stripping).
- The single test seam is the plugin boundary: tests mount the real plugin on a real cordis context with fake `agents`/`goals`/`jobs` services and a goal-call ledger, drive the real event names and payloads, and assert which goal mutations happen when. A stand-in "official driver" listener is registered *before* the plugin so dispatch ordering is tested rather than assumed.

## License

MIT