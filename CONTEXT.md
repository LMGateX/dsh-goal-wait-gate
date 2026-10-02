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
