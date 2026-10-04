# Implementation verification — bounded result

## Delivered in the feature worktree

TypeScript startup owner, pinned native-derived driver and work policy; legacy root/default retained. [Support contract](<startup-driver.md>) and [ADR 0002](<adr/0002-opt-in-pinned-driver.md>) define opt-in selection, direct-root/fixed-topology prerequisites, original-native unverified cleanup and admission/holder limits. No GUI, launcher adapter, hot switching, npm release or plugin deployment is included.

## Executed checks

| Layer | Result | Evidence scope |
|---|---|---|
| Strict TypeScript no-emit + source/declaration build + asset copy | PASS | Actual rc.2 declarations and direct compiler; build script typechecked |
| Replacement/native public boundary tests | 34/34 PASS | Actual SDK plugins, deterministic adapter, synthetic stores and ids |
| Startup ownership/lifecycle/version tests | 19/19 PASS | Actual Cordis mount/update/public effect/registry operations |
| Legacy activation tests | 25/25 PASS | Real Cordis with fake DSH services; not replacement parity proof |
| Combined suite | 78/78 PASS | No failed/skipped/cancelled tests |
| Legacy type matrix | 3 hosts PASS | Current legacy entry/gate/tests copied into isolated projects; existing per-host declarations reused read-only for 0.1.7-alpha.2, 0.1.7-rc.2, 0.2.0-rc.2 |
| Compiled root/startup package imports | PASS | Distinct exports and unchanged legacy name/default; prerelease peer range smoke |
| Package dry-run | PASS, 28 files | npm pack ignore-scripts; both declarations, source modules, upstream MIT notice/provenance and support document included |
| Privacy/whitespace scan | PASS | New source/tests/docs contain no captured private paths, addresses, sessions or credentials; no runtime dump committed |
| Clean frozen-lock installation/native dependency build policy | NOT VERIFIED | Regenerated registry lock exists, but no clean install/release acceptance claimed |
| Real launcher/profile/GUI/live sessions | NOT TESTED | Deliberately outside installation authorization |

Public regressions include genuine detach→disposal→continuable-end; standard one-shot result/end before final disposal with both Jobs-wait flag values; failed acceptance; repeated cold-resumed epochs and old notice/end; nested idle residency; runtime-owner versus durable lineage; exact/unowned/foreign-root Jobs; quiet/wakeup; goal edit/revision; completion authority; queued/downstream fences; cap/errors/checkpoint; user/parent cancellation at queued/claimed/admitted stages; external pause/keepInbox/manual retention; synchronous/async downstream faults; semantic reject with exact prompt-rejected code; surfaced asynchronous managed drain failure; positive late request-window admission counterexample.

## Independent review axes

### Standards

Two original P2 findings: original native cleanup falsely marked verified; unique-URL JSON metadata imports retained unbounded ESM cache. Public RED→GREEN corrections expose closed-unverified/unverified-native and use fresh readFile/JSON.parse. Additional explicit drain rejection visibility was corrected and tested. Follow-up source inspection reports no remaining concrete backend/standards finding within the declared contract; reviewers did not independently rerun checks.

### Spec

Original P1: one-shot end is result settlement, not disposal. Standard subagent Jobs are now independently guarded even with generic job waiting disabled; actual delayed-disposal tests prove the configuration distinction. Direct holder-owned no-Job finalization remains unsupported. Review identified direct-root bootstrap, fixed topology and artifact-not-provider-attestation boundaries; documentation now states them rather than claiming normal Loader/GUI integration or a lifetime global lease. Additional cancellation/fault/semantic-decision evidence closes reviewed cases; mixed multi-input permutations, arbitrary/late providers and final atomic admission remain unproven.

## Isolation correction and release gate

The attempted pnpm 11 build unexpectedly ran dependency synchronization, followed by an ignored native build failure. It temporarily rewrote 25 SDK leaf links through a shared parent-directory symlink. All 25 were restored to the verified original distribution; the exact original native source fingerprint is unchanged. The main linked plugin working tree and profile configuration remained untouched; no GUI/server/session restart or plugin deployment occurred. This incident is not represented as zero transient impact on other running sessions.

The implementation now owns its dependency-group directory and subsequent verification runs directly, without pnpm implicit synchronization. The generated lock contains registry integrities and no private file/link resolution; incidental build-approval placeholder was removed, not approved. Future dependency installation must use a genuinely independent directory and separately verify frozen-lock and native-build policy before release/install. The default linked plugin has not been replaced by this feature branch.
