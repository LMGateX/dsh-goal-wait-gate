# Implementation verification — bounded result

## Delivered in the feature worktree

TypeScript startup owner, native-derived driver ported against two pinned published hosts and work policy; legacy root/default retained. [Support contract](<startup-driver.md>) and [ADR 0002](<adr/0002-opt-in-pinned-driver.md>) define opt-in selection, direct-root/fixed-topology prerequisites, original-native unverified cleanup and admission/holder limits. No GUI, launcher adapter, hot switching, npm release or plugin deployment is included.

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

0.3.0 is packaging: the shipped bundle layer, the localized card text and the replaced isolated check described above, on the same runtime code as 0.2.1. It is committed on the feature branch and verified only in disposable homes; the tag, GitHub release, registry publication and any installation into a live profile are separate maintainer steps and have not been performed here. The default linked plugin checkout, the running server and every live profile were left untouched.
