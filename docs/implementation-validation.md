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

Honest gap: the browser's own rendering of the control is still unproven in isolation. The generic form renders a `union` of `const` branches as a choice list (the same shape `dsh-client-ui-settings-models` reads for its selector), and the page's namespace source is exactly the `describe()` call this check exercises, so the remaining risk is presentation only. 0.4.2 showed that risk was real: the namespace existed, but the page still rendered nothing because the Plugins page has no generic renderer (see below). The npm registry remains unpublished, and no live profile was touched by this change.

## 0.4.2 change status

0.4.2 closes the second half of the same user-visible defect. 0.4.1 made the host serve a live settings namespace for row `goal-wait-gate`, and the page still showed no controls, because the Plugins page has **no generic configuration renderer**: a row detail page only renders the public `plugins.row.config` slot, and each plugin's own browser half has to fill it.

Evidence from the installed host packages (DSH 0.2.1-alpha.1):

- `dsh-client-ui-plugin-manager/lib/client.js` renders the row's configuration section as `renderSlot("plugins.row.config", { view: "page", form })`, where `form = formFor(rowId)` wraps `configForms.get(id)` and returns `undefined` unless the host's described namespaces contain that row id — which 0.4.1 made true for this row;
- `grep -rln 'plugins.row.config'` over the installed host packages matches exactly two files: `dsh-client-ui-plugin-manager/lib/client.js` (the slot definition/use, and `rowConfigKey(bundle, rowId)` = `${bundle}#${rowId}`) and `dsh-cordis-client-runner/lib/client.js` (the dynamic runner). Nothing in the host fills the slot for a plugin;
- the third-party precedent on this machine is `dsh-stream-retry`: its `client/client.js` header says its browser half registers into the public `plugins.row.config` slot and uses only the public settings service, and its `package.json` declares `exports["./client"]` plus `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-plugin-manager"] }`.

Shipped: `client/client.js` (classic script, no ESM syntax, every declaration inside the single `window.__ModuleLoader__.load` factory so the shell can concatenate it into a combo response), `client/public.d.ts` + `client/public.js` for the `./client-types` subpath, `exports["./client"]`, `client` added to `files`, the `dsh.client` declaration, and `scripts/check-client.mjs` wired as `check:client`.

The bundle registers `plugins.row.config` under key `dsh-goal-wait-gate#goal-wait-gate`, gated by `ctx.configForms.whileServed(["goal-wait-gate"], …)` so a deployment without the namespace registers nothing. It injects the row's own `configForm` and renders: a `select` with the four strategies under the Chinese labels `locale/zh.json` uses, one checkbox per boolean policy field, a non-negative number input for `maxHoldMs`, and Save that submits one revision-fenced `mutate` carrying only the changed paths (`unset` restores the inherited/default value), keeping the draft and showing a readable error on conflict or failure.

Verification: `node scripts/check-client.mjs` (exit 0) stubs `window.__ModuleLoader__`, a minimal React surface and a fake client context, runs the factory, and asserts the slot target/key/injection, a control for each of the four fields with the four choices and their labels, that a staged change plus Save submits exactly `[{set strategy native}, {set waitForJobs false}, {set maxHoldMs 45000}]` fenced by the current revision, that an invalid duration is refused locally without a write, and that the file carries no ESM syntax; `package.json` ships `client/`, confirmed by `npm pack`. The six suites stay 103/103 and `check:settings`/`check:bundle` exit 0.

Honest gap: the check proves the registered element tree and the mutation it issues, not the browser's own pixel rendering; the row page still needs one live restart to be seen. No live profile was touched by this change and nothing was pushed, tagged or installed.
## 性能核对（0.4.17，alpha.3/alpha.4 支持分支）

事件驱动热路径按「先测量、再决定」核对，全部在同一台机器上用 20 万次迭代的微基准与真实 0.2.1-alpha.4 安装树测量：

| 路径 | 实测 | 处置 |
|---|---|---|
| `gate.evaluate`（无活工作 / 有存活后代） | 119 ns / 272 ns | 不动：决策层已是百纳秒级 |
| 驱动策略 `allows`（有 job＋后代 / 无工作） | 35 ns / 27 ns | 不动 |
| `resolveRowConfig`（4 个 live accessor） | 161 ns | 不动：它承担「保存即生效」的语义，缓存会改变契约 |
| `Promise.resolve().then(noop)`（对照） | 408 ns | 据此修掉 checkpoint 的稳态空转（见下） |
| 一次 host 身份识别（冷启动 / 预热） | 15.5–16.4 ms / 6.5 ms | 不动：见下面被否决的探测快路径 |

已实施：`agent/disposed` 只唤醒判定可能改变的祖先链（原为全 realm 唤醒加索引重建）、索引精确增删并对未知节点保守重 seed、activation epoch 成员判断改为引用计数、checkpoint 仅在 live 策略与已挂载策略不同时才入队（稳态每次 checkpoint 省一个 promise 与微任务，而 `replacement` 策略下 checkpoint 的全部工作就是这个空转）、祖先链记录 id 而非 Agent、job 生命周期集合提取出事件路径。两份后代索引的维护机制（插入、精确移除带子树、重 seed）抽出为 `src/descendants.ts`；查询语义仍留在各自调用方（闸门走任意深度，移植驱动按存活的直属子代理回答），因为两者的判据本就是有意不同的。

否决项：曾实现「先读 driver 版本、未 pin 就跳过该 scope」的挂载探测快路径，实测冷启动 15.5/15.6/16.4 ms（原路径）对 15.8/15.3/15.8 ms（新路径）、预热 6.5 ms 对 7.2 ms，在噪声内且预热略慢，故回滚、未提交。原因：不匹配的 scope 本来就在第一个包解析时退出，昂贵的整表读取只发生在可解析的 scope 上，而那正是候选。

验证：rc.2 开发宿主 138/138；真实 0.2.1-alpha.4 宿主 138 项（136 通过、2 跳过、0 失败）；`check-startup-host` 对 alpha.4 通过；构建与 `npm pack` 通过；真实 alpha.4 CLI 上 `replacement` 与 `activation` 两种策略的 e2e 均通过。本机 live profile 未被写入，未安装、未发版。

## 0.2.1-rc.1 支持核对（0.4.18 分支）

rc.1 只移动发行版身份，不移动 goal continuation 的实现：dsh-goal-round-driver 0.2.1-rc.1 的 lib/index.js 与 alpha.3/alpha.4 逐字节相同（SHA-256 255483fb…），goal、jobs、agent、subagent、session、llm、scope、system-prompt 与 dsh-app-boot 也是（`diff -r` 排除 package.json 无输出）。两处身份变化：distribution 版本改为 0.2.1-rc.1；Cordis 毕业为稳定 4.0.5（包内容与 4.0.4、4.0.5-alpha.2 相同，dsh 元包依赖 `~4.0.5`）。

适配因此是数据与矩阵：`src/driver/host-version.ts` 新增一行 pin（Cordis 4.0.5、同 fingerprint、同 behavior），`test/host-profile.test.ts` 锁住该身份与行为并新增一项运行期身份模拟检测，`scripts/check-host-compat.mjs` 把 rc.1 加入默认矩阵，并把 Cordis 版本改为按宿主解析——此前矩阵里所有宿主都装 4.0.4，而 rc.1 的包声明 peer `~4.0.5`，用 4.0.4 就测的不是它实际运行的声明树。

实测结果（2026-10-17，本机）：

- 0.2.0-rc.2 开发宿主：139/139。
- 真实 rc.1 宿主（/tmp 一次性隔离副本，链接 npm 装出的全部 303 个 @deepseek-ai 包；rc.1 已不发布的 dsh-subagent-in-process-driver 必须缺席，否则身份表会读到混合版本）：139 项中 137 通过、2 跳过、0 失败。两项跳过与 alpha.4 相同——宿主不再发布 one-shot 后台委派模式，fixture 按宿主能力跳过。
- `check-startup-host`：真实 rc.1 安装报 pinned 0.2.1-rc.1，303 个宿主包链接下 src/ 类型检查通过。
- `check-host-compat`：8 个宿主全过（按宿主 Cordis 版本：alpha.1/alpha.2 → 4.0.5-alpha.1，alpha.3/alpha.4 → 4.0.5-alpha.2，rc.1 → 4.0.5）。
- `check:bundle` / `check:settings` / `check:client`：通过。
- 真实 rc.1 CLI 的 e2e（/tmp 一次性 DSH home，npm pack 出的 0.4.18 tarball）：replacement 与 activation 各 12 项全绿；状态记录 `host.distribution=0.2.1-rc.1`、`cordis=4.0.5`、`driverSha256=255483fb…`、无 fallback。

未做：本机 live profile 安装、发版、GUI 与真实模型会话验证。

## 0.2.1-rc.2 支持核对（0.4.19 分支）

rc.2 的改动只在 Web 搜索与模型标签：dsh-goal-round-driver 0.2.1-rc.2 与 rc.1 逐字节相同（SHA-256 255483fb…），goal、tool-goal、command-goal、agent、agent-loop、jobs、jobs-local、tool-jobs、subagent、tool-subagent、session、llm、scope、system-prompt、tools 与 app-boot 同样（`diff -r` 排除 package.json 无输出）；Cordis 仍是 `~4.0.5`。适配只有一行 pin 与矩阵一行（`check-host-compat` 补 rc.2 → Cordis 4.0.5）。

实测结果（2026-10-17，本机）：

- 0.2.0-rc.2 开发宿主：139/139。
- 真实 rc.2 continuation 包集合（npm 装出的 29 个 @deepseek-ai 包，与 repo 的开发包组合成隔离 realm；rc.2 不发布的 dsh-subagent-in-process-driver 必须缺席）：139 项中 137 通过、2 跳过、0 失败，跳过项与 alpha.4/rc.1 相同。
- `check-startup-host`：该 realm 报 pinned 0.2.1-rc.2，类型检查通过。
- `check-host-compat`：0.2.1-rc.2 通过（按宿主装 Cordis 4.0.5）。
- 客户端槽位：rc.2 的 dsh-client-ui-plugin-manager 与 dsh-cordis-client-runner 仍带 `plugins.row.config`。

- 真实 rc.2 CLI 的 e2e（/tmp 一次性 DSH home，npm pack 出的 0.4.19 tarball）：replacement 与 activation 各 12 项全绿；状态记录 `host.distribution=0.2.1-rc.2`、`cordis=4.0.5`、`driverSha256=255483fb…`、无 fallback。核对期间 npm 上的 rc.2 曾缺 `dsh-tool-pwsh-persistent` 与 `dsh-client-ui-settings-account` 两个包（pnpm 解析失败，而 dist-tag next 已指向 rc.2），约半小时后补齐，复测通过。
- 同一 tarball 在本机 0.2.1-alpha.4 CLI 上跑同样两种策略，也各 12 项全绿。

未做：GUI 与真实模型会话验证；核对阶段未写入本机 live profile。

## 性能/事件驱动复核（0.4.20）

针对“每次 checkpoint 的工作量随会话历史增长”做了一轮审计：先按事件订阅与索引结构清点，再在真实宿主包组成的 realm 里逐项实测，最后用原型验证。所有改动保持原有语义（作业存活判据、后代判据、持有方向均未变）。

### 1. 闸门的作业检查不再扫全部保留记录

`hasLiveJobs` 走 `ctx.jobs.list(owner)`：宿主实现遍历整个 realm 的作业，并为该 owner 的每条物化 view（实测 ~5 µs/条），且 settled 记录保留到 owner 释放。实测 `gate.evaluate`：0 条 151 µs、50 条 365 µs、200 条 1.03 ms、400 条（含外部 owner）2.03 ms。

改为按 owner 的事件计数（`registered` +1、`settled` -1；`stopping`/`removed` 不改变存活），首次查询从 registry 播种，owner 释放时删除计数：0/50/200 条分别为 118/116/108 µs，与历史无关。

### 2. 每次评估少做服务查找与 registry 查询

- 闸门在构造时缓存 goals 服务：属性访问本身就是一次服务解析（~7–9 µs/次）。
- 后代索引额外维护 `live` 集合（插入时加、disposal 时删、re-seed 时重建），walk 用它判断存活，不再对每个子节点调 `ctx.agents.get`（~13 µs/次）；无子代时零分配提前返回。真实 realm 无后代场景 746 → 100 ns/次。

### 3. 空闲作业计数不再按 owner 无界累积

`createBackgroundPolicy` 的 `liveJobs` 每 owner 计数归零后不删除（只在 driver 卸载时清理）；长寿命 realm 会随“曾经跑过作业的会话数”增长。现在归零即删，下次查询按需重新播种；`allows` 实测仍 ~300 ns。

### 已测但否决

宿主身份解析（`assertHostVersion`，8–9 ms/次）尝试按 scope 惰性读取、命中即停：8.8 → 8.9 ms，无差异（只有第一个可解析的 scope 付全量读取），未采用。

### 验证

rc.2 开发宿主 143/143（新增 4 项：作业计数播种与事件更新、他人/无主作业不计、owner 释放后重新播种、后代 walk 不查 registry）；真实 0.2.1-alpha.4 与 0.2.1-rc.2 CLI 上 replacement 策略 e2e 均通过；`check-startup-host`、`check-host-compat` 与三项资产检查通过。

## 0.4.21：native-join 宿主把 subagent 等待交还宿主

2026-10-23 的 LMGateX 会话（`session-a367562c-9071-4f62-b261-5854938f16e4`）暴露了旧 replacement policy 的一个边界：`interrupt` 在存在未领取 inbox 工作时会保留 live child Agent（parked FIFO），而旧 policy 的“任何已注册后代”判定会把它当作 live work。该会话的 goal 创建后 14h56m 没有拿到一轮，四个相关 session.lock 一直打开；宿主 `waitForChildren` 则会跳过这个停靠子。

修复：`createBackgroundPolicy` 增加 `BackgroundPolicyOptions.nativeSubagentJoin`，`mode.ts` / `startup.ts` 从 pinned profile 的 `profile.driver.joinsProgressingDescendants` 传入。该值为 true 时，replacement 不安装 descendant/epoch guard，由宿主 `waitForChildren` 负责 running 后代和 parked 子；Job guard 保留。`activation` 策略不变；native-join 宿主上如遇同类停靠，可显式 `waitForSubagents=false`。

验证：typecheck 与 build 通过；0.2.0-rc.2 开发宿主全套 144/144 通过（新增 native-join policy 用例）；修复后的 tarball 在真实 0.2.1-rc.2 CLI 的一次性 DSH home 内跑 `replacement` e2e，12/12 通过，无 fallback。未重跑 alpha.3+ 真实宿主的完整 suite；宿主身份表与 provenance 未改。

## 0.2.2-alpha.2 支持核对（0.4.22 分支）

2026-10-29 在 `/tmp` 的一次性 DSH home 与独立 npm prefix 中完成。未写入本机 live profile，未在本机安装插件，未发版。

宿主差异：

- `dsh-goal-round-driver/lib/index.js` 与 0.2.1-rc.2 逐字节相同（SHA-256 `255483fb…953ec7f1ff92`）；`dsh-jobs/lib/index.js` 也相同，subagent 的 `waitForChildren` 实现逐行相同。continuation 的调度 seam 没有变化。
- 0.2.2 改的是宿主运行面：Node 下限提高到 24.9，Cordis 到 4.0.6-alpha.1；goal 与 subagent 改为异步 session projection 注册；agent 在 pre-step 增加 `modelSelection` 并引入 `agent.model`；subagent settlement 省略重复的 closing text；普通会话分支不再被识别为子代理；native 与 PTC 工具执行拆成独立插件。
- 插件实际使用的公开 seam（`goals` 的 activation、`agents`/`jobs`、`subagent/start`/`end`、`waitForChildren`、`webServer`、`internal/plugin`）在 0.2.2 上保持兼容；`src/` 对 0.2.2 声明类型检查通过。

适配改动：

- `supportedHosts` 增加 `0.2.2-alpha.2`：与 rc.2 相同的 driver SHA 与 behavior，Cordis 改为 `4.0.6-alpha.1`。
- `check-host-compat` 矩阵增加该宿主及其真实 Cordis 版本。
- e2e 安装本地 tarball 时先把它复制到 profile：0.2.2 的 installer 会把 `file:` 依赖改写为 profile 相对路径，但不再负责把 tarball 复制进去；旧 installer 也接受该布局。
- native fixture 在宿主发布 `@deepseek-ai/dsh-tool-executor-native` 时挂载它。0.2.2 把工具执行从 `dsh-tools` 拆出；不挂载时 fixture 在 pre-step 报 `TOOL_EXECUTOR_UNAVAILABLE`，这不是插件行为失败。旧 pin 没有该包，条件挂载保持原行为。

实测结果（本机）：

- 0.2.0-rc.2 开发宿主：全套 145/145（新增 0.2.2 身份选择与 queued-round 行为断言）。
- 真实 0.2.2-alpha.2 包组成的隔离 realm：145 项中 143 通过、2 跳过、0 失败；跳过项仍是宿主不再发布 one-shot 后台工具模式的两项既有场景。
- `check-startup-host`：0.2.2 安装报 pinned，331 个宿主包链接下 `src/` 类型检查通过。
- `check-host-compat 0.2.2-alpha.2`：通过（按宿主装 Cordis 4.0.6-alpha.1，peer ranges 接受预发布版本）。
- 真实 0.2.2 CLI 的 e2e（/tmp 一次性 DSH home）：`replacement`、`replacement --stale-peers`、`activation`、`native`、`off` 各 12 项全绿；`replacement` 状态记录 `distribution=0.2.2-alpha.2`、`cordis=4.0.6-alpha.1`、`driverSha256=255483fb…`、无 fallback。
- `check:bundle`、`check:settings`、`check:client`：通过；bundle 行仍只出现一次，host `goal-round-driver` 行仍被同一层禁用。

未做：本机 live profile 安装、GitHub 发布、GUI 与真实模型会话验证。


