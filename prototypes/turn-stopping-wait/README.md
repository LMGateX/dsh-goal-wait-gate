# THROWAWAY: native turn-stopping wait research

Question: can a cancellable wait at a natural turn-stopping point keep continuation activation armed while leaving native goal reservation, admission, accounting and tools unchanged? This is research, not production or an installed plugin.

## Run

```bash
node prototypes/turn-stopping-wait/native-experiment.mjs /path/to/installed/@deepseek-ai
```

No DSH profile or server is booted. The script resolves the supplied host packages and mounts isolated Cordis contexts with real session/agent-loop/goal/driver/tools/jobs modules. Only model responses and background producer completion are controlled. Child experiments also mount real spawn/continuation modules and JSONL persistence rooted in freshly allocated temporary directories, never the live session store.

- [Native experiment](<native-experiment.mjs>): scenario runner with bounded observation/cleanup deadlines, not a shipped plugin or a unit-test suite.
- [Observations](<observations.json>): 30 executed scenarios, including deliberate unsafe negative controls; three runs produced identical sanitized observations. Do not interpret allScenariosFinished as all behaviors being safe.
- [Host fingerprints](<host-manifest.json>): package versions and SHA-256 of the published entry modules actually loaded; upstream master links are not pinned-version evidence.
- [State model](<state-model.html>): open locally in a browser; pure explanatory simulation, not a runtime integration test.

The native maxGoalRounds=1 fixture intentionally ends ordinary non-completing cases in a native round-limit blocker to bound execution. That final disarm is native behavior, not an activation change by the waiting gate. Cleanup uses test-host goal completion and agent disposal; these are not actions performed by the candidate gate.

Coverage limitations: one installed DSH version, deterministic adapter, direct descendants and selected native compositions only. No shared GUI/ACP/headless acceptance, restart/fork replay, long-duration stress, arbitrary adapter/Stop-hook ordering, nested/interrupted parked children or exhaustive cancellation race coverage. Native abnormal exits and some idle starts bypass the stopping wait.

Production scope remains unchanged. Findings and recommended next steps are recorded on research issue #8 and the main-branch research report.
