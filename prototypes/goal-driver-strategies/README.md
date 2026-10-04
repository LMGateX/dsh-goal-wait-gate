# Goal driver strategies — throwaway research

**Not an installed plugin, release, safe mode-switcher, or settings backend.** Question: can a version-pinned background-aware goal scheduler keep the parent genuinely idle and the goal armed, with a narrower interaction surface than an awaited turn-stopping hook?

## Run

Use Node 24.17.0 or a compatible Node with synchronous module-resolution hooks. Supply the installed native package directory; the runner never loads a profile.

~~~bash
node prototypes/goal-driver-strategies/experiment.mjs /path/to/installed/@deepseek-ai
node prototypes/goal-driver-strategies/capture-host.mjs /path/to/installed/@deepseek-ai
~~~

Open [strategy-model.html](<strategy-model.html>) directly for the pure in-memory control model. It has guided cases and free play. It illustrates requested-versus-effective startup selection, idle waiting, pending notices, and invalid dual ownership. **It is not the DSH Plugins page and not native verification.**

## Evidence and files

- [experiment.mjs](<experiment.mjs>): 32 isolated scenarios using the real agent loop, goal projection/tools, native jobs controller/delivery, real in-process one-shot and continuable children, and the native goal prompt invariant companion. Only the model adapter and producer completion are controlled.
- [observations.json](<observations.json>): final sanitized native status, admitted sources/rounds/revisions, turn ends, model call counts, and tool authority results. No actual user/profile/session data. All 32 scenarios completed; this is **not** 32 assertion-based production tests passing. Negative controls deliberately expose failures/limits.
- [host-manifest.json](<host-manifest.json>) and [capture-host.mjs](<capture-host.mjs>): versions and SHA-256 of the 18 actual module entries. DSH 0.2.0-rc.2, Cordis 4.0.4, Node 24.17.0.
- [native-driver-reference.mjs](<native-driver-reference.mjs>): exact published 364-line driver plus two attribution lines. Removing those lines yields the host entry SHA-256, 3bca01a2e87de1683fa8b55ad54688eefc4e366c971c20e9afd654db3b5ab450.
- [background-driver.mjs](<background-driver.mjs>): native-derived driver, 20 added / 3 removed lines relative to the reference: reservation guard, both native reservation fences via the same predicate, microtask work/notice re-evaluation, and lifecycle check. It preserves prompt, source, admission counting, flush, cancellation, cap and native teardown.
- [background-driver-with-barrier.mjs](<background-driver-with-barrier.mjs>): 22 added / 3 removed lines relative to the reference. Additional wiring uses an experimental pending-notice policy; only **two** scenarios exercise this variant, not the complete suite.
- [work-policy.mjs](<work-policy.mjs>): 42 lines separately from the driver delta: static owned-job/descendant selector, plus two Maps, four lifecycle listeners, initial registry scan and cleanup for the notice-barrier hypothesis.
- [UPSTREAM-LICENSE.txt](<UPSTREAM-LICENSE.txt>): upstream MIT notice, Copyright (c) 2026 DeepSeek. Adaptation attribution is retained. [Original license](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE).

## What the experiment established

- With an already live job, stock native driver admitted one goal round; the background-aware candidate admitted zero and stayed idle/active/armed.
- Ordinary parent turn closes; later Stop listeners and whenIdle are not held. Wakeup and quiet job notices have different native batching paths, both covered.
- A late job at queue or downstream pre-step invalidates the candidate reservation without consuming a round or pausing/blocking the goal. Current native error, truncation, flush failure, downstream rejection, cap, cancellation, and human tool authority stay visible.
- Delaying delivery of the **real** native subagent-settled message at parent.followup lets an unrelated job completion trigger a premature round in the static selector candidate. The pending-notice variant holds the selected case until the real notice is inserted.
- Work introduced during request preparation, after the last pre-step fence, **does** permit one admission. There is no all-instants atomic zero-admission guarantee.
- Two independent drivers conflict. Actual current gate unload re-arms its held goal and triggers a round while work is live. Idle driver handoff leaves the goal disarmed until an actual human-input goal-tool resume.

## Important limitations

The transport-delay fixture is not an exact delay inside the native handle.dispose await gap. Invariant checks only prove the official prompt/durable-prefix contract, not every scheduler or ownership safety property. Model behavior, actual output collection, UI/headless/ACP integration, performance and real network LLMs are not tested.

**The pending-notice variant is incomplete, not release-ready:**

- It can create phantom pending for an unannounced continuable child whose establishment/cold-resume fails: native disposal need not promise any settlement notice.
- It keys notices only by sender session id, not activation epoch. Old notice/new activation races are not fenced.
- Raw last-descriptor scanning is not the native first-own/version-validated descriptor fold; no cold-resume/fork/provider support claim.
- Missing notice needs an explicit reconciliation/escape policy. The suppressed-notice scenario intentionally remains idle/armed without a new round until delivery resumes.
- Nested descendants, resident idle transitions, unknown providers, unowned/other-owner jobs and multi-context scope isolation remain unverified. All-owner subscriptions are suitable only for this isolated root-context experiment; future scoped composition may drive a foreign owner's agent.

Each scenario uses a fresh in-memory Cordis context. Child cases additionally create a fresh temporary JSONL store with synthetic sessions. Handles/context disposal are awaited with bounded cleanup, but there is no post-cleanup zero-registry/subscription/pending assertion. Scratch directories are retained for investigation. No shared server, installed modules, profiles or live sessions are modified.

## Configuration conclusion

A schema enum alone does not create the installed Plugins UI or disable another driver. Future implementation needs a companion/custom select page and explicit ownership/staging. Default activation bridge remains unchanged. Only one owner may schedule; off deliberately has none. Initial selection should apply on controlled startup, retain fail-closed disarming and require human per-session resume. A wrapper is a proposed control boundary, **not** existing global ownership enforcement or a hot-switch protocol.

Research tracker: [#9](https://github.com/LMGateX/dsh-goal-wait-gate/issues/9). Main findings live in the documentation branch, not this runtime prototype.
