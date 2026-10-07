# Implementation verification — bounded result

## Delivered in the feature worktree

TypeScript startup owner, native-derived driver ported against two pinned published hosts and work policy; legacy root/default retained. [Support contract](<startup-driver.md>) and [ADR 0002](<adr/0002-opt-in-pinned-driver.md>) define opt-in selection, direct-root/fixed-topology prerequisites, original-native unverified cleanup and admission/holder limits. No GUI, launcher adapter, hot switching, npm release or plugin deployment is included.

## Row-owned strategies (0.4.0)

The bundle layer now hands this plugin the only continuation slot: it disables the host's `goal-round-driver` row in the same file that mounts this row, and the plugin mounts a driver per `strategy` (`activation` default, `replacement`, `native`, `off`), configured from the Plugins page through a native Schemastery `Config`. Rollback paths: pick `native`, uninstall (the layer and its `disabled` entry disappear together), or switch the row off. Two behavioural points are new: a mount-time sweep gates work that was already pending when the row mounted, and the ancestor walk that recognizes this row's own child drivers is cycle-safe — in a real Cordis realm `fiber.parent` is the parent *context*, whose `.fiber` is that same fiber, so the naive walk never terminated and blocked the event loop (that was the 0.3.0-attempt stall, reproduced with a handle/stack probe and fixed).

| Layer | Result | Evidence scope |
|---|---|---|
| Row strategy/config tests | 10/10 PASS | Deterministic stand-in realm: schema shape and choices, bundle patch, card text, all four strategies, the foreign-driver guard and the unpinned-host fallback |
| Combined suite on 0.2.1-alpha.1 | 99/99 PASS | 89 prior assertions plus the 10 row tests; every file exits without `--test-force-exit` |
| Isolated bundle composition (`.bundle-check/`) | PASS | The host row is disabled by this layer, this row composes once, a profile-layer override still wins, and the entry exports a native Schemastery `Config` whose strategy union is the four documented choices |

**Not yet proven:** the rendered form (and its choice list) and the hot switch on a saved config change need a real GUI with the plugin installed and the server restarted — installing on this machine requires user approval, so that remains a manual step.

## Executed checks

| Layer | Result | Evidence scope |
|---|---|---|
| Strict TypeScript no-emit + source/declaration build + asset copy | PASS | Actual pinned declarations and direct compiler; build script typechecked |
| Replacement/native public boundary tests | 34/34 PASS | Actual SDK plugins, deterministic adapter, synthetic stores and ids |
| Startup ownership/lifecycle tests | 19/19 PASS | Actual Cordis mount/update/public effect/registry operations |
| Host profile pinning tests | 8/8 PASS | Pure artifact-identity matching plus simulated exact identities; both behavior flags mutation-checked red and green |
| Legacy activation tests | 25/25 PASS | Real Cordis with fake DSH services; not replacement parity proof |
| Combined suite on the installed rc.2 host | 86/86 PASS | No failed/skipped/cancelled tests |
| Same suite on a read-only 0.2.1-alpha.1 installation | 86/86 PASS | Sources/tests copied beside symlinked host packages; nothing installed or written into that installation |
| Bundle-layer contract tests | 3/3 PASS | Shipped manifest → patch → locale consistency, including the `./locale/*.json` export the host resolves card text through |
| Combined suite on 0.2.1-alpha.1 (bundle-layer change) | 89/89 PASS | 86 prior assertions plus the 3 bundle-layer tests; the linked development tree now resolves to that installation |
| Bundle layer in a disposable DSH home | PASS | `.bundle-check/` profile copy with this repository linked in as the installed bundle: the row composes exactly once, `goal-round-driver` stays mounted, a profile-layer override still wins, `readProfilePlugins` reads bundle + enabled, `readPluginMeta` returns the en/zh card text, and the install preflight reports compatible |
| Consumer tarball install (0.3.0) | PASS | 31-file tarball installed with `npm install --ignore-scripts` into an independent temporary directory; bundle patch and locale subpaths resolve and the card text reads back through the host reader |
| Package dry-run (0.3.0) | PASS, 31 files | npm pack ignore-scripts; adds the bundle patch and both locale dictionaries to the 0.2.1 set |
| rc.2 re-run of the suite for the bundle-layer change | NOT VERIFIED | No distinct 0.2.0-rc.2 package copy remains on this machine — the linked development tree and the `.host-compat` copy both follow the updated installation — and fetching rc.2 was not authorized. The runtime code is unchanged, so the prior 86/86 rc.2 record still covers it |
| Startup host type gate (0.2.1-alpha.1) | PASS | Shipped src/ typechecked against that installation's declarations through the same read-only links |
| Legacy type matrix | 3 hosts PASS | Current legacy entry/gate/tests copied into isolated projects; existing per-host declarations reused read-only for 0.1.7-alpha.2, 0.1.7-rc.2, 0.2.0-rc.2 |
| Host pin selection and refusal | PASS | 0.2.0-rc.2 and 0.2.1-alpha.1 accepted by version + bundle SHA-256; unpinned version, wrong fingerprint and mixed first-party version all refused before mounting |
| Consumer tarball install | PASS | 0.2.1 tarball installed into an independent temporary directory with npm --ignore-scripts; no profile, DSH installation or shared server touched |
| Compiled root/startup package imports | PASS | Distinct exports and unchanged legacy name/default; prerelease peer range smoke |
| Package dry-run | PASS, 28 files | npm pack ignore-scripts; both declarations, source modules, upstream MIT notice/provenance and support document included |
| Privacy/whitespace scan | PASS | New source/tests/docs contain no captured private paths, addresses, sessions or credentials; no runtime dump committed |
| Clean frozen-lock installation/native dependency build policy | NOT VERIFIED | Regenerated registry lock exists, but no clean install/release acceptance claimed |
| Real launcher/profile/GUI/live sessions | NOT TESTED | Deliberately outside installation authorization |

The bundle-layer change is packaging only: the manifest gains `dsh.bundle.patch`, the package ships `cordis.patch.yml` and `locale/*.json`, and the row id stays `goal-wait-gate` so existing profile overrides keep applying. Two findings are locked by checks: DSH renders one card per bundle and attaches rows only inside their bundle, so a plain dependency with a hand-written patch row is invisible on the Plugins page; and the host reads `<name>/locale/<id>.json` through package resolution, so a package without the `./locale/*.json` export shows its technical name instead of its card text.

One test-infrastructure fix ships with it: the native fixture's optional invariant companions are now imported through non-literal specifiers, so the strict typecheck still passes on a host that dropped the package and the driver subpath (0.2.1-alpha.1) while the guarded imports stay runtime-correct on rc.2.

Behavior selection is artifact-bound: forcing either pinned host's queued-round flag to the other pin's value turns exactly the matching behavior test red, and the alpha simulation removes a kept queued goal message from the inbox while the rc.2 run keeps it parked. Public regressions include genuine detach→disposal→continuable-end; standard one-shot result/end before final disposal with both Jobs-wait flag values; failed acceptance; repeated cold-resumed epochs and old notice/end; nested idle residency; runtime-owner versus durable lineage; exact/unowned/foreign-root Jobs; quiet/wakeup; goal edit/revision; completion authority; queued/downstream fences; cap/errors/checkpoint; user/parent cancellation at queued/claimed/admitted stages; external pause/keepInbox/manual retention; synchronous/async downstream faults; semantic reject with exact prompt-rejected code; surfaced asynchronous managed drain failure; positive late request-window admission counterexample.

## Independent review axes

### Standards

Two original P2 findings: original native cleanup falsely marked verified; unique-URL JSON metadata imports retained unbounded ESM cache. Public RED→GREEN corrections expose closed-unverified/unverified-native and use fresh readFile/JSON.parse. Additional explicit drain rejection visibility was corrected and tested. Follow-up source inspection reports no remaining concrete backend/standards finding within the declared contract; reviewers did not independently rerun checks.

### Spec

Original P1: one-shot end is result settlement, not disposal. Standard subagent Jobs are now independently guarded even with generic job waiting disabled; actual delayed-disposal tests prove the configuration distinction. Direct holder-owned no-Job finalization remains unsupported. Review identified direct-root bootstrap, fixed topology and artifact-not-provider-attestation boundaries; documentation now states them rather than claiming normal Loader/GUI integration or a lifetime global lease. Additional cancellation/fault/semantic-decision evidence closes reviewed cases; mixed multi-input permutations, arbitrary/late providers and final atomic admission remain unproven.

## Isolation correction and release gate

The attempted pnpm 11 build unexpectedly ran dependency synchronization, followed by an ignored native build failure. It temporarily rewrote 25 SDK leaf links through a shared parent-directory symlink. All 25 were restored to the verified original distribution; the exact original native source fingerprint is unchanged. The main linked plugin working tree and profile configuration remained untouched; no GUI/server/session restart or plugin deployment occurred. This incident is not represented as zero transient impact on other running sessions.

The implementation now owns its dependency-group directory; subsequent verification runs directly, without pnpm implicit synchronization. The generated lock contains registry integrities and no private file/link resolution; the incidental build-approval placeholder was removed, not approved.

## 0.2.1 release status

`v0.2.1` is a GitHub source release: the release commit is on master, tagged, and documented here. Registry publication is a separate maintainer step and has not been performed, so `npm install dsh-goal-wait-gate` does not resolve. The released package declares no runtime dependencies (peer dependencies only, mostly optional), so a consumer install does not resolve an ambient dependency graph; the development workflow's clean frozen-lock installation and native dependency-build policy remain unverified and are not implied by this release. The default linked plugin checkout was not modified, rebuilt or replaced by the release.

## 0.3.0 change status

0.3.0 is packaging plus documentation: the shipped bundle layer, the localized card text and the replaced isolated check described above, on the same runtime code as 0.2.1. The tree also follows the upstream Skills v1.3 rename, where the domain document convention changed with no fallback: the root glossary is now `GLOSSARY.md`, `docs/agents/domain.md` was refreshed from the template the installed `setup-matt-pocock-skills` skill ships, and `AGENTS.md`, the README and the ADR/research links point at the new name. `git grep -n -E 'CONTEXT(-MAP)?\.md'` returns nothing. It is committed on the feature branch and verified only in disposable homes; the tag, GitHub release, registry publication and any installation into a live profile are separate maintainer steps and have not been performed here. The default linked plugin checkout, the running server and every live profile were left untouched.

## 0.4.0 change status

0.4.0 turns the shipped bundle row into the sole owner of goal continuation. The layer that mounts `goal-wait-gate` also disables DSH's own `goal-round-driver` row, and the plugin mounts a driver per `strategy`: `activation` (default) mounts the host's published native driver plus the existing disarm/resume gate, `replacement` mounts the pinned TypeScript port, `native` mounts the host driver with no gate (official behaviour), and `off` mounts no driver. The strategy comes from a native Schemastery `Config` export, so the Plugins page renders one control per branch from the profile's own schema; every field and branch carries bilingual text and the Chinese card text names all four strategies, the default, and the three rollback paths (pick `native`, uninstall, or switch the row off). Rollback needs no profile edit: uninstalling the plugin removes the layer and its `disabled` entry together, and no strategy writes to any profile file.

Verification in disposable homes only: strict typecheck exit 0; six suites 99/99 (startup 34, ownership 19, host-profile 8, bundle-manifest 3, row-config 10, legacy 25), every file exiting 0 without `--test-force-exit`; `scripts/check-bundle-layer.mjs` exit 0, now also asserting that the composed tree disables the host row exactly once, that only one driver path is active, and that the entry exports a native Schemastery config whose strategy union is exactly `activation | replacement | native | off` with default `activation`. The tarball installs into an isolated profile whose plugin directory is the extracted package rather than a link; `dsh --profile web --dump-config` there exits 0 with one `goal-wait-gate` row and the host row disabled, and an isolated `dsh web` instance boots on a spare port with no plugin error. The stall that blocked the first attempt was a synchronous infinite loop in the ancestor walk — in a real Cordis realm `fiber.parent` is the parent context whose `.fiber` is that same fiber — and is fixed with a cycle-safe walk; a mount-time sweep now also gates work that was already pending when the row mounted.

The rendered form and the hot switch on a saved change still require a live GUI, and installing into the live profile, the tag and the GitHub release are separate maintainer steps. `npm install dsh-goal-wait-gate` still does not resolve: registry publication has not been performed.

## 0.4.1 change status

0.4.1 fixes the user-visible defect that made 0.4.0's configuration form invisible on the Plugins page, and adds live application of every field. The defect was in the host contract, not in the schema shape: `@deepseek-ai/dsh-settings` `describe()` mounts a namespace only when `volatileForm(schema)` returns a form, and `volatileForm` (lib/index.js, ~line 122) recurses into an object and keeps **only** fields whose nearest ancestor carries `meta.volatile`; when nothing survives it returns `undefined` and the row is dropped from the described set before any value projection. `write()` (~line 501) applies the same rule and throws `Config field "<path>" is not volatile` otherwise. 0.4.0 marked no field volatile, so the row loaded, the card appeared, and the page rendered no controls at all.

Fix: every field of the row `Config` is now `Schema.…volatile()` (`strategy` on the union node, `waitForJobs`, `waitForSubagents`, `maxHoldMs`), with the bilingual descriptions kept. The union *branches* deliberately stay plain: cordis rejects a config whose volatile node has a volatile ancestor (`volatile fields require a fixed object path without an enclosing volatile field`), which the plugin's own mount path hits at load. Because volatile fields reach `apply` as live accessors, the row now resolves every field through `liveValue()` (accepts plain values too, so tests, the boot API and the previous `resolveRowConfig` callers are unchanged) and re-reads them: `applyStrategy` returns a `StrategyHandle` whose `sync()` is called from the three checkpoints the plugin already owns — `agent/turn-stopping`, `agent/status` idle and `goal/changed` — so a saved `strategy` disposes the mounted driver and mounts the new one in place, idempotently, while `GoalWaitGate` takes a policy provider and re-reads `waitForJobs`/`waitForSubagents`/`maxHoldMs` at each evaluation. No polling timer is installed, the row itself is never remounted, the foreign-driver guard and the activation fallback are unchanged, and a bad saved value is logged while the last good policy stays in force.

Verification: strict typecheck exit 0; the six suites are 103/103, including new assertions that every row-config field carries `meta.volatile`, that a faithful copy of the host's own `volatileForm` over `Config` yields a non-empty object schema with the four fields and the four strategy choices, that a changed live `strategy` swaps exactly one driver in place (old child disposed, row still mounted, sync idempotent), and that a live `waitForJobs` change releases at the next evaluation without a remount. `scripts/check-settings-form.mjs` (new) mounts the plugin as a real fiber on a real cordis `Context` and calls the **installed** `@deepseek-ai/dsh-settings` `SettingsForms.describe()`: it returns `ns: "goal-wait-gate"`, `applies: "live"`, the four described fields, the four choices with default `activation`, and the resolved live value `{strategy: activation, waitForJobs: true, waitForSubagents: true, maxHoldMs: 0}`; the same service's write path accepts a saved strategy without a volatility error. Only the profile plumbing that `SettingsForms` injects (loader, configEditor, profileContext) is stubbed — the predicate and the projection are host code.

Honest gap: the browser's own rendering of the control is still unproven in isolation. The generic form renders a `union` of `const` branches as a choice list (the same shape `dsh-client-ui-settings-models` reads for its selector), and the page's namespace source is exactly the `describe()` call this check exercises, so the remaining risk is presentation only; a live GUI is still needed to confirm it visually. The npm registry remains unpublished, and no live profile was touched by this change.
