# TypeScript implementation test seams

Approved implementation scope follows research #9 and implementation #10. Test through the startup plugin mount/dispose/update interface and the native public Agent, Goal, Jobs and Subagent operations. Observe actual admitted source/round/revision, Goal state, model dispatch and input retention; do not mutate private driver reservations or continuation-manager fields.

Work in vertical slices: one failing public-behavior test, minimal TypeScript implementation, then the next slice. Preserve legacy activation default and its unload behavior at the root export; the new managed startup entry is fail-closed and startup-only.

Initial supported realm: one unscoped Cordis root, shared core modules, installed before agents/delegations; exact rc.2 native interfaces. Epoch release uses public local start/end runId, not descriptor or settlement text. Registered runtime-owned descendants and strictly-owned jobs remain independent guards.

Required slices: idle/armed job waiting; quiet/wakeup dispatch; local epoch detach/end and failed acceptance; repeated epochs; nested ownership/fork exclusion; original cap/error/cancel/authority; owner composition/conflicts/managed shutdown/config-update rejection. Explicit counterexamples retain public prepublication and final request-preparation limitations, rather than silently treating them as solved.

No tests load real profiles, sessions, credentials or GUI. Public fixtures use synthetic inputs and fresh temporary stores. No installation or deployment is authorized.

Independent reviews exposed one-shot result/end versus disposal, native Cordis-hidden cleanup errors, fresh metadata ESM cache growth and additional cancellation/fault evidence needs. Fixes have public RED→GREEN regressions. See [support contract](<startup-driver.md>) for the deliberately narrower direct-root/fixed-topology and direct-holder limitations. Clean frozen-lock installation/native dependency-build acceptance is a separate unresolved release gate; linked native artifacts are not a clean-install proof.
