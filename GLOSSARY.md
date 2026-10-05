# Goal continuation gating

This context distinguishes a session’s completion objective from permission to continue automatically and the decision to schedule work now.

## Language

**Goal**: The session’s current long-running completion objective, distinct from an execution plan or an individual background task.
_Avoid_: Plan, next step

**Goal phase**: The durable lifecycle of a goal: active, paused, blocked, or complete. An active goal remains valid even when automatic continuation is not armed.
_Avoid_: Activation

**Continuation activation**: Process-local permission for automatic goal continuation, expressed as armed or disarmed. It does not define whether the goal exists or is readable.
_Avoid_: Goal enabled, goal disabled, goal working state

**Scheduling gate**: A decision about whether to schedule the next automatic goal round now, separate from the goal’s validity and continuation permission.
_Avoid_: Goal pause

**Live work**: Session-owned background work that has not reached the gate’s release point, including live subagent descendants. It is distinct from the parent agent’s running or idle status.
_Avoid_: Parent running

**Owned hold**: A temporary withholding of automatic continuation that this gate initiated and is responsible for releasing. It is distinct from a disarm initiated by another lifecycle owner.
_Avoid_: User pause

**Goal visibility**: The current goal information actually available in model input or obtained through a read. A stored goal and a model-visible goal snapshot are not the same thing.
_Avoid_: Goal activation

**Residency epoch**: One continuous period in which a delegated agent is resident. Resuming the same durable conversation starts a new epoch.
_Avoid_: Child conversation identity

**Settlement handoff**: The interval between work finishing and the owner’s normal completion input being offered. Finishing a result, releasing ownership, and delivering or consuming that input are distinct events.
_Avoid_: Result settled means fully disposed

**Runtime ownership**: The current live parent–child relationship, distinct from a conversation’s durable ancestry.
_Avoid_: Parent history

**Startup ownership**: Exclusive responsibility for automatic continuation during one root lifetime; selecting a strategy is distinct from switching a live scheduler.
_Avoid_: Hot handoff

**Cleanup integrity**: What the lifecycle owner can establish about shutdown, distinct from a disposal call merely returning.
_Avoid_: Verified clean shutdown

**Host profile**: The exact published DSH artifact identity a managed component is ported and pinned against — distribution package versions together with the native driver bundle fingerprint. Support is per profile, not a version range, and an unpinned distribution is refused rather than approximated.
_Avoid_: Supported version, minimum version

**Ported behavior**: The native semantics the pinned bundle of a host profile actually has, selected from that artifact identity. It is never inferred from a version string or supplied by configuration.
_Avoid_: Version feature flag

**Bundle layer**: The mount declaration a plugin package ships — `package.json.dsh.bundle.patch` plus that patch file — which a profile switches on by naming the package in `dsh.profile.bundles`. It is what makes a plugin appear on the Plugins page; it is distinct from a hand-written patch row and from a plugin's runtime mount.
_Avoid_: Plugin install, patch snippet
