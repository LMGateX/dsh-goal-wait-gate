# DSH goal 升级观察与复核清单

本清单保存[ADR-0001](<adr/0001-retain-activation-gate.md>)的证据基线及后续版本复核步骤。它是升级时执行的清单，不是自动监控服务、待立即实现的功能列表，也不承诺未来版本仍保持当前行为。

## 当前基线

- 决策：保持现有 activation 闸门及官方 driver，不改运行时行为。
- 源码核对基线：DSH `0.2.0-rc.2`；插件 `0.2.0`。
- 官方 driver 在 idle、`active + armed` 时尝试预留并排队下一轮；当前未核实到独立的 scheduling defer / re-evaluate 契约。
- 现有 `PreStepDecision` 只有 `enter/reject`；pre-step 开始时父 agent 已为 running，消息已被 claim。下游 reject 可触发 `prompt-rejected` goal blocker。
- `disarm` 不修改 durable phase/revision；`resume` 是 goal mutation，会更新 revision、重新 armed 并发出 goal change。
- Goal edit 保留 activation；模型工具 edit 要求当前顶层轮次存在直接人类输入，而不是要求 goal armed。
- Goal mutation 自身不注入模型上下文；get_goal 和续轮提示暴露目标信息。
- 原设计讨论基线的自动化覆盖主要是 real Cordis + fake DSH 模块的插件测试、隔离 host 类型/peer 检查及 profile patch 组合检查。后续收尾等待研究另做了真实原生 goal 工具权限实验（见下文），但仍未验证真实模型的目标感知。

## 已完成的两条研究路线

[收尾等待闸门研究](<research/turn-stopping-wait-gate.md>)在 DSH `0.2.0-rc.2` 的真实原生模块上执行了 30 个隔离场景：通过可取消的 `agent/turn-stopping` 等待，可以保持正常等待期间的 activation，并让原生 driver 继续管理后续轮次。不过父 agent 会保持 running/open turn，存在 Stop listener 延后、权限持续时间和 hook 绕过路径等语义取舍；它不满足下文“独立 idle 调度 seam”的全部条件，也尚未替换当前实现。升级时应同时复核该报告的边界，不能把它误读为“已有独立调度接口”。

[Driver 替换与多策略配置研究](<research/goal-driver-replacement.md>)另执行了 32 个隔离原生场景：版本锁定的 native-derived scheduler 可以不占住父 turn 而正常保留 armed；但静态 descendant 检查不足以证明通知已送达，pending-notice 原型仍缺 announcement/epoch/scope 和失败策略，最后 pre-step 到 request/admission 也有实测窗口。升级时还须复核 native prompt invariant、Settings/custom Plugins page、Loader teardown 是否 awaited、driver 所有权/重启/人工授权；enum 和文件锁本身不是安全切换合同。现行默认及已安装运行时没有变化。

## 每次升级重点看哪里

以下链接指向上游当前分支，**会变化，不是版本锁定证据**。核对新版本时，应记录实际发布版本、源码 commit/permalink 或发布包中的模块和函数；不能用 master 文档替代安装版本的行为核对。

| 上游模块 | 基线核对点 | 观察的变化 |
|---|---|---|
| [goal](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal) | `get/edit/disarm/resume`、activation/change 事件 | phase/activation 的含义、revision 变更、持有原因/所有权、独立 re-arm 能力是否变化 |
| [goal-round-driver](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver) | `drive/readyToDrive/validReservation`、pre-step、取消/错误/卸载处理 | 是否新增调度 guard、defer、重新评估入口，或原生检查后台工作；拒绝和取消的副作用是否变化 |
| [tool-goal](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/tool-goal) | `requireDirectHuman/completionAuthority`、工具 schema/guidance | 编辑/恢复/完成/阻塞权限是否变化；后台回报轮次有什么权限 |
| [core 接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md) | `PreStepDecision`、inbox、turn/status 事件 | 是否有真正的暂缓而非 reject；输入是否能继续调度；监听顺序契约是否变化 |
| [goal 模型体验](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/goal/goal/README.md#model-experience) | mutation、工具结果、续轮提示、压缩/恢复 | 是否自动同步最新目标；是否能区分插件等待与其他 disarm 原因 |

同时检查 jobs 的 running/stopping 和完成通知，以及 subagent descendant/activation epoch 的生命周期。不要把“父 agent idle”“子 agent idle”“后台工作已全部消费”视为同一件事。

## 候选调度 seam 的验收条件

发现新接口不等于可以直接迁移。至少核实：

- [ ] 暂缓发生在下一轮 reservation / 入队之前，或有等价且明确的安全延期契约。
- [ ] 不修改 goal 的 phase、activation、objective、revision，也不把暂缓记录成 blocked/失败。
- [ ] 等待不调用模型、不消费 round、不占住父 agent 执行流程、不产生忙重试。
- [ ] 人类输入及 job/subagent 回报可以正常进入并处理，不被等待闸门拦截。
- [ ] 工作结算且其回报被处理后，有公开方式重新评估调度；不会因缺少触发事件永远停住。
- [ ] 重新评估时读取最新目标和工作状态；并发 edit/complete/pause/clear/replacement 及显式 resume 都不会使用旧 reservation。
- [ ] 错误、用户取消、round cap、恢复、fork 和卸载仍由官方生命周期策略处理，不恢复外部撤销的授权。
- [ ] 接口公开、语义稳定，不依赖访问 driver 私有状态、监听排序技巧或伪造 user 来源。
- [ ] 用真实官方 goal/driver/tools 的隔离集成测试验证，而非只修改 fake driver 后通过现有测试。

若上游原生处理后台等待，检查其工作范围是否与本插件一致；符合需求时优先停用重复闸门，避免两个等待策略互相干扰。

## 升级复核步骤

1. 在隔离目录/DSH home 中安装目标版本；记录版本及证据定位。不得复用或改动仍在工作的用户会话，不得重启共享 GUI 来做兼容性实验。
2. 对照上表阅读实际版本源码、类型和工具说明，区分“不兼容变化”“新扩展点”“未变化”；只有 peer range 接受新版本不是行为兼容证明。
3. 运行现有自动化检查；在确认需要并完成兼容性核对后再调整 peer range。当前命令：

   ```bash
   pnpm typecheck
   pnpm test
   pnpm check:hosts <new-version>
   pnpm check:bundle
   ```

4. 在隔离环境执行下面的场景。涉及真实模型时，要检查实际输入/工具结果，不以 UI 中存在目标或模块成功 import 代替模型可见性证据。
5. 追加复核记录，保留旧基线。保持策略时写明理由；改变策略时新增或 supersede ADR，不悄悄覆盖既有决策。

### 场景清单

- [ ] 长 job 或任意深度 subagent 存活时没有空续轮；所有工作及回报处理完才释放，读取最新 goal，不重复排队。
- [ ] 等待期间用户编辑目标：目标仍可读，activation 不因 edit 自动恢复，释放后续轮使用新 objective/revision。
- [ ] 当前轮次有直接人类输入时，模型编辑 disarmed goal 的行为符合新版本工具权限；纯 goal 轮次及仅后台回报轮次分别核实权限，不假定 armed 就有编辑权。
- [ ] 人类或后台回报唤醒时，记录模型实际能看到的目标版本；对等待期间 Web/命令编辑及上下文压缩后的情况单独检查。
- [ ] 等待中 complete/pause/block/clear/replacement 不被错误恢复；显式人类 re-arm 的优先级与既有策略一致。
- [ ] Plugin owned hold 期间又发生 driver error/用户取消等外部 disarm：确认后台结束后不会错误恢复被撤销的授权；若不能区分，记录风险而不是宣称该场景已保证。
- [ ] restart/fork 后仍须显式恢复授权；其后有后台工作则仍等待，没有后台工作则按官方策略继续。
- [ ] 多个 job/子 agent 先后结束、stopping、常驻子 agent 生命周期、超时及卸载/重载无遗留 hold、死锁或忙循环。

## 复核记录模板

每次新版本复核复制填写，不把未执行项记成通过：

```text
DSH version / upstream commit or package evidence:
Plugin version / commit:
Changes in scheduling seam:
Changes in phase / activation / revision / ownership:
Changes in edit and completion authority:
Changes in model-visible goal context:
Changes in jobs / subagent lifecycle:
Automated checks actually run and results:
Isolated integration scenarios actually run and results:
Skipped checks / limitations / unresolved risks:
Decision: retain gate / investigate migration / upstream makes gate redundant
Related evidence and ADR:
```

公开文档和 issue 只记录仓库相对定位、上游 permalink 或通用路径占位符；不复制机器绝对路径、profile/session 标识、私密日志或凭据。

## 复核记录：DSH 0.2.1-alpha.1

按上文模板填写；只使用发布包内可核对的证据，不推断 master。

```text
DSH version / upstream commit or package evidence: 0.2.1-alpha.1 发布包（dist-tag alpha）；以包内 bundle、类型目录与 README 为准
Plugin version / commit: 0.2.1（本次 pin 提交）
Changes in scheduling seam: 无。goal-round-driver/lib/index.js 相对 rc.2 只有一处 idle 结算差异；agent-loop、agent、jobs、jobs-local、tool-jobs、tool-goal、command-goal 与 goal 的执行 bundle 逐字节相同。新增包只有 dsh-tool-schedule 与 dsh-experimental-inspector*，与 goal 调度无关。
Changes in phase / activation / revision / ownership: 无（goal 执行 bundle 未变化）。
Changes in edit and completion authority: 无（tool-goal、command-goal bundle 未变化）。
Changes in model-visible goal context: 无。
Changes in jobs / subagent lifecycle: 执行代码未变化；变化是各包移除 invariant companion（lib/invariant.js），dsh-invariants 不再随发行版提供。
Queued-round refinement: agent 到达 idle 时仍在排队的 round 提示会从 inbox 移除；被取消轮次属于其他工作时续行 disarm 而非 pause（README.zh 明示）。它清理残留 reservation，不检查后台工作。
Automated checks actually run and results: 86/86（本机 rc.2）与 86/86（0.2.1-alpha.1 只读隔离安装）；src/ 通过两套声明树类型检查；未 pin 版本、错误指纹、混合版本均被拒绝；行为 flag 双向 mutation 红/绿。
Isolated integration scenarios actually run and results: 未运行真实模型场景；native fixture 覆盖 idle、queued/claimed/admitted 取消、冻结排队消息与通知顺序，不覆盖真实用户会话或模型目标感知。
Skipped checks / limitations / unresolved risks: 未验证真实 profile 安装、GUI 与真实模型可见性；driver 仍无后台工作视角，最后 pre-step→request 窗口仍在。
Decision: retain gate（上游未原生处理后台等待，必要性未消除）
Related evidence and ADR: ADR-0001、ADR-0002、docs/startup-driver.md
```

结论：0.2.1-alpha.1 的 goal 侧改动是队列结算修正与 invariant 体系迁移，**不是**原生后台工作感知或调度 defer 契约；因此 activation 闸门与 opt-in startup 的必要性都不变。若上游开始原生检查 session 自有 job/subagent 存活，再按"候选调度 seam 的验收条件"复核并考虑停用重复闸门。

## 复核记录：DSH 0.2.1-alpha.3

按上文模板填写；只使用发布包内可核对的证据，不推断 master。

```text
DSH version / upstream commit or package evidence: 0.2.1-alpha.3 npm 发布包；driver 身份以 dsh-goal-round-driver 0.2.1-alpha.3 的 lib/index.js 为准（SHA-256 255483fb…953ec7f1ff92，Cordis 4.0.5-alpha.2），并与 alpha.2 发布物逐包对比
Plugin version / commit: 0.4.16 分支 feat/background-aware-driver，本次 pin 变更尚未提交
Changes in scheduling seam: 有。driver 在 idle、active+armed 且 checkpoint 完成后、round cap 之前，新增 await Promise.race([subagents.waitForChildren(agent), unloading.promise])（可选服务；未加载 subagent 时行为同 alpha.2），随后 readyAfterCheckpoint 复检；插件卸载时 resolve unloading。waitForChildren 本体在 alpha.2 已存在且函数体未变，变的只是调用方。
Changes in phase / activation / revision / ownership: 无。activation 仍只由 create/resume/pause/complete/block/disarm 决定。
Changes in edit and completion authority: 无（tool-goal 发布包未变）。
Changes in model-visible goal context: 无（轮次提示未变）。
Changes in jobs / subagent lifecycle: driver 仍不读取 jobs；jobs 三包仅改 job id 格式（<kind>-N → <kind>-<16 位 uuid>）、job 会话生命周期记录与通知截断文案。subagent 新增独立 preset 选择与恢复。
Automated checks actually run and results: typecheck 通过；129/129 测试通过；check-startup-host 对真实 0.2.1-alpha.3 安装报 pinned 并类型检查通过；check-host-compat 0.2.1-alpha.3 通过；bundle/client/settings 检查通过。
Isolated integration scenarios actually run and results: native fixture 上同一场景分别以 alpha.3 与 alpha.2 身份运行：alpha.3 在有 running 后代时 0 轮、0 新请求；alpha.2 同场景立即准入 1 轮。未运行真实模型会话。
Skipped checks / limitations / unresolved risks: 未验证真实 profile 安装与 GUI；停靠（parked）后代不阻塞宿主是上游刻意行为，本插件 policy 则按"活着的后代 Agent"计入——该差异已在 alpha.4 复核中实测（见下一节）：停靠只剩 activation residency，没有 live Agent，因此不计入，语义差异仅限"停止跑动到 Agent 被回收/结算通知被消费"这段窗口。
Decision: 新增 0.2.1-alpha.3 pin 并复现其 descendant join；activation 与 replacement 两种策略在该 pin 上均可用
Related evidence and ADR: ADR-0001、ADR-0002、docs/startup-driver.md、src/driver/provenance.json
```

结论：0.2.1-alpha.3 首次让官方 driver 原生等待"进行中的后代"，因此 `replacement` 策略的移植增量只剩后台 Job；`waitForSubagents` 与该 pin 上游语义的重叠部分仅为下述窄窗口，默认值最终保持不变（见 alpha.4 复核与 ADR-0001 补充）。

## 复核记录：DSH 0.2.1-alpha.4

按上文模板填写；只使用发布包内可核对的证据，不推断 master。

```text
DSH version / upstream commit or package evidence: 0.2.1-alpha.4 npm 发布包；driver 身份以 dsh-goal-round-driver 0.2.1-alpha.4 的 lib/index.js 为准（SHA-256 255483fb…953ec7f1ff92，Cordis 4.0.5-alpha.2，与 alpha.3 发布物逐字节相同），并与 alpha.3 逐包对比 goal、goal-round-driver、tool-goal、agent、agent-loop、jobs、jobs-local、tool-jobs、subagent、tool-subagent
Plugin version / commit: 0.4.17 分支 feat/dsh-0.2.1-alpha-support（本次提交；0.4.16 为未提交的基线）
Changes in scheduling seam: 无。上述 continuation 相关发布包的 lib/ 内容除包自身版本号与发布时重写的兄弟包精确版本外逐字节相同（diff -r 只命中 package.json 的 version/devDependencies/peerDependencies）；alpha.4 的实质变更是插件市场与插件兼容性判定，未触及 continuation 路径。
Changes in phase / activation / revision / ownership: 无。
Changes in edit and completion authority: 无。
Changes in model-visible goal context: 无。
Changes in jobs / subagent lifecycle: alpha.3→alpha.4 无（jobs 三包与 subagent 执行 bundle 相同；driver 仍只等待"进行中的后代"，不读 jobs）。本轮顺带首次在真实 alpha.3+ 语义下实测出这条版本线的 subagent 面变更（rc.2 之后、alpha.3 起）：`ctx.subagents.startContinuable` 被 `startActivation(spec, delivery)` 取代；委派工具不再发布 `run_in_background`/`backgroundMode`，每次委派都是独立管理的 activation，工具也不再创建 `kind: 'subagent'` 的 Job；subagent 运行时要先有 `workingDirectory`，它依赖 `fs`（由 `dsh-fs-sandbox` 提供），后者依赖 `sandboxPolicy`，再依赖 `sandbox`。本插件 src/ 不使用这些 API，其 `job.kind === 'subagent'` 分支在 alpha.3+ 上因此永不命中（后代仍由 agents 注册表计入，等待语义不受影响）。
New in this release（与 goal 无关但影响插件交付）: 插件兼容性判定改为 engines.dsh 优先，peers 字段更名 requirements（packages/boot/app-boot/src/plugin-compatibility.ts）。本插件未声明 engines.dsh，仍走 peer 规则；两个 @deepseek-ai/dsh-* peer 范围都接受 0.2.1-alpha.4，已在真实 profile 安装中验证。官方 dsh-base 自身也未声明 engines.dsh。本轮决定采用它：0.4.17 起声明 engines.dsh = >=0.1.7-alpha.2 <0.3（覆盖矩阵全部宿主），并让 check-host-compat 同时断言该范围——声明后该范围单独决定兼容性，不再叠加 peer 规则。
Automated checks actually run and results: typecheck 通过；rc.2 开发宿主 136/136 通过（含 byte-identical republish 身份测试、事件路径 index upkeep 与并发 epoch 测试）；真实 0.2.1-alpha.4 宿主（隔离副本 + npm 装出的 @deepseek-ai/* 包）同一套 136 项中 134 通过、2 跳过、0 失败；check-startup-host 对真实 0.2.1-alpha.4 安装（npm 装出的 34 个包）报 pinned 0.2.1-alpha.4 且 src/ 类型检查通过；check-host-compat 0.2.1-alpha.4 通过（隔离副本内安装该版本、legacy 入口与测试类型检查通过、全部 peer range 接受预发布版本）；check:bundle/check:settings/check:client 通过；tsc -p tsconfig.build.json + copy-driver-assets 构建通过。
Isolated integration scenarios actually run and results: 在 /tmp 的一次性 DSH home 内用真实 @deepseek-ai/dsh@0.2.1-alpha.4 CLI 跑 scripts/e2e-isolated.mjs，replacement 与 activation 两种策略各 12 项检查全绿：profile 安装成功、真实服务器启动、bundle 层接管 goal-round-driver 行、状态记录写明 host.distribution=0.2.1-alpha.4、cordis=4.0.5-alpha.2、driverSha256=255483fb…、无 fallback、状态路由可读。未运行真实模型会话。另在真实 alpha.4 realm 上实测了“子代理停靠”的实际语义：子代理回合结束后 live Agent 在 ≤250ms 内消失（subagents.list 仍为 1），停靠保留的是可寻址的 activation residency 而不是 Agent，因此本插件“活着的后代 Agent”判定不会被停靠无限按住，多守的只是“停止跑动→Agent 被回收/结算通知被消费”这段窗口。该结论已固化为 fixture 场景（parked activation 不 hold）。
Skipped checks / limitations / unresolved risks: 未验证 GUI，也未在真实模型会话中验证目标可见性。native fixture 现在可以装配真实 alpha.3+ realm：按安装物挂载 sandbox-local → sandbox-policy → fs-sandbox → working-directory 这条 provider 链（缺任一环 subagent 插件都会停在 pending、ctx.subagents 为 undefined），并用 startActivation/startContinuable 二选一启动后台子代理，故同一份 suite 在 rc.2 与 alpha.4 上都能跑。仍有两项在 alpha.3+ 上跳过：该宿主不再发布 one-shot 后台工具模式，也没有对应的 disposal-backed subagent Job，那两个场景要驱动的模式本身不存在（fixture 现按宿主能力跳过，rc.2 上仍执行）。dsh-session-persistence-jsonl 自 alpha.3 起从默认导出改为 name/apply 功能插件，fixture 已能兼容两种形态。
Decision: 新增 0.2.1-alpha.4 pin（与 alpha.3 同 fingerprint、同 behavior，仅新增身份行）；必要性结论与 alpha.3 相同——保留闸门，且 waitForSubagents 保持默认 true（实测不支持“停靠即卡死”的担忧）
Related evidence and ADR: ADR-0001、ADR-0002、docs/startup-driver.md、src/driver/provenance.json
```

结论：0.2.1-alpha.4 对 goal continuation 面零改动，alpha.3 的结论原样成立——原生 driver 已覆盖"进行中的后代"，但仍完全不读后台 Job，闸门的必要性未消除；`waitForSubagents` 与该 pin 上游语义的重叠已实测为窄窗口，默认值保持不变，决策记入 ADR-0001 补充。真实 alpha.4 宿主上的 e2e 证明交付路径（安装/装载/host 身份/两种策略）成立，同一份 native suite 也在真实 alpha.4 realm 上全绿（含以真实 waitForChildren、alpha.3 与 alpha.2 两种身份各跑一次的 descendant join 场景）；但这些都不能替代"工作范围是否一致"的判断。

## 复核记录：DSH 0.2.1-rc.1

按上文模板填写；只使用发布包内可核对的证据，不推断 master。

```text
DSH version / upstream commit or package evidence: 0.2.1-rc.1 npm 发布包（dist-tag next，发布于 2026-10-17T05:22:10Z，GitHub release dsh-v0.2.1-rc.1）；driver 身份以 dsh-goal-round-driver 0.2.1-rc.1 的 lib/index.js 为准（SHA-256 255483fb…953ec7f1ff92，与 alpha.3/alpha.4 逐字节相同），并与 alpha.4 逐包对比 goal、goal-round-driver、jobs、agent、subagent、session、llm、scope、system-prompt 以及 dsh-app-boot
Plugin version / commit: 0.4.18 分支 feat/dsh-0.2.1-alpha-support（本次 pin 提交）
Changes in scheduling seam: 无。上述发布包的 lib/ 除 package.json 里的自身版本号与兄弟包精确版本外逐字节相同（diff -r 排除 package.json 无输出）；driver 仍只等待“进行中的后代”，仍完全不读后台 Job。
Changes in phase / activation / revision / ownership: 无（goal 执行 bundle 未变化）。
Changes in edit and completion authority: 无（tool-goal 未变化）。
Changes in model-visible goal context: 无。
Changes in jobs / subagent lifecycle: 无执行代码变化。发行版层面两处：Cordis 从 4.0.5-alpha.2 毕业为稳定 4.0.5（该包 lib 与 4.0.4、4.0.5-alpha.2 逐字节相同，只有版本号不同），dsh 元包对 Cordis 的依赖改为 ~4.0.5，因此 pin 的 Cordis 字段必须写 4.0.5；dsh-invariants 与 dsh-subagent-in-process-driver 继续不随发行版提供（alpha.1 起的既有状态）。
New in this release（与 goal 无关但影响插件交付）: 插件兼容性判定仍按 engines.dsh 优先（dsh-app-boot 与 alpha.4 逐字节相同）；发布说明里的“等待运行中的子任务再开始下一轮目标”与“后台工作流不再被误标为已中断”都在 0.2.1 系列、alpha.4 之前生效，rc.1 没有新增 continuation 面变更。
Automated checks actually run and results: typecheck 通过；rc.2 开发宿主 139/139 通过（新增 rc.1 身份选择与运行期身份模拟各一项）；真实 0.2.1-rc.1 宿主（隔离副本 + npm 装出的 303 个 @deepseek-ai 包）同一套 139 项中 137 通过、2 跳过、0 失败；check-startup-host 对真实 0.2.1-rc.1 安装报 pinned 0.2.1-rc.1、303 个宿主包链接下 src/ 类型检查通过；check-host-compat 全矩阵（8 个宿主，按各自真实 Cordis 版本）通过；check:bundle/check:settings/check:client 通过；npm pack + prepack 构建通过。
Isolated integration scenarios actually run and results: 在 /tmp 的一次性 DSH home 内用真实 @deepseek-ai/dsh@0.2.1-rc.1 CLI 跑 scripts/e2e-isolated.mjs，replacement 与 activation 两种策略各 12 项检查全绿；状态记录写明 host.distribution=0.2.1-rc.1、cordis=4.0.5、driverSha256=255483fb…、无 fallback。未运行真实模型会话。
Skipped checks / limitations / unresolved risks: 未验证 GUI，也未在真实模型会话中验证目标可见性；与 alpha.4 相同，两项 one-shot 后台工具场景在 rc.1 上因宿主不再发布该模式而跳过（fixture 按宿主能力跳过）。未写入本机 live profile，未安装、未发版。
Decision: 新增 0.2.1-rc.1 pin——与 alpha.4 同 fingerprint、同 behavior，仅 Cordis 身份改为稳定 4.0.5；必要性结论与 alpha.3/alpha.4 相同，保留闸门。
Related evidence and ADR: ADR-0001、ADR-0002、docs/startup-driver.md、src/driver/provenance.json
```

结论：0.2.1-rc.1 对 goal continuation 面零改动，alpha.3/alpha.4 的结论原样成立——原生 driver 已覆盖“进行中的后代”但仍完全不读后台 Job，闸门的必要性未消除。rc.1 的适配差异只有两处身份数据（distribution 版本、Cordis 4.0.5）与矩阵里的一行；真实 rc.1 宿主上的 e2e 与 native suite 证明交付路径与行为在发行候选版上仍然成立。

## 复核记录：DSH 0.2.1-rc.2

按上文模板填写；只使用发布包内可核对的证据，不推断 master。

```text
DSH version / upstream commit or package evidence: 0.2.1-rc.2（GitHub release 发布于 2026-10-17T08:16:33Z；npm dist-tag next 于发布后指向 rc.2）；driver 身份以 dsh-goal-round-driver 0.2.1-rc.2 的 lib/index.js 为准（SHA-256 255483fb…953ec7f1ff92，与 rc.1 逐字节相同），并与 rc.1 逐包对比 goal-round-driver、goal、tool-goal、command-goal、agent、agent-loop、jobs、jobs-local、tool-jobs、subagent、tool-subagent、session、llm、scope、system-prompt、tools、app-boot
Plugin version / commit: 0.4.19 分支 feat/dsh-0.2.1-alpha-support（本次 pin 提交）
Changes in scheduling seam: 无。上述发布包的 lib/ 除 package.json 里的自身版本号与兄弟包精确版本外逐字节相同（diff -r 排除 package.json 无输出）；driver 仍只等待“进行中的后代”，仍完全不读后台 Job。
Changes in phase / activation / revision / ownership: 无（goal 执行 bundle 未变化）。
Changes in edit and completion authority: 无（tool-goal 未变化）。
Changes in model-visible goal context: 无。
Changes in jobs / subagent lifecycle: 无执行代码变化；Cordis 仍为 ~4.0.5（解析为 4.0.5），dsh-invariants 与 dsh-subagent-in-process-driver 仍不随发行版提供。
New in this release（与 goal 无关但影响插件交付）: 发布内容集中在 Web 搜索新 API 与模型标签：base bundle 新增 web-deepseek-api 行、web-app bundle 新增 ui-deepseek-model-label-1017 行，客户端 slot catalog 把 conversation.input.model.label 的占用者标为新增插件；插件页所用的 plugins.row.config 槽在 rc.2 的两个宿主包里仍然存在（命中 dsh-client-ui-plugin-manager 与 dsh-cordis-client-runner）。
Automated checks actually run and results: typecheck 通过；rc.2 开发宿主 139/139 通过（rc.2 身份与 republish 行为并入既有断言）；真实 0.2.1-rc.2 continuation 包集合（29 个 @deepseek-ai 包，用 npm 装出、与 repo 的开发包组合成隔离 realm）同一套 139 项中 137 通过、2 跳过、0 失败；check-startup-host 对该 realm 报 pinned 0.2.1-rc.2 且 src/ 类型检查通过；check-host-compat 0.2.1-rc.2 通过（按宿主装 Cordis 4.0.5）。
Isolated integration scenarios actually run and results: 未能运行完整 CLI e2e——发布当时 npm 上的 rc.2 发行不完整：dsh 元包依赖的 @deepseek-ai/dsh-tool-pwsh-persistent@0.2.1-rc.2 与 dsh-web-app 依赖的 @deepseek-ai/dsh-client-ui-settings-account@0.2.1-rc.2 均未发布（其余 81 个 scoped 直接依赖齐全），故 pnpm add @deepseek-ai/dsh@0.2.1-rc.2 在解析阶段即失败。此缺口属上游发布问题，与本插件无关；补齐后可原样重跑 scripts/e2e-isolated.mjs。
Skipped checks / limitations / unresolved risks: 未验证 GUI、真实模型会话与完整 CLI 启动（原因见上）；两项 one-shot 后台工具场景在 rc.2 上仍因宿主不发布该模式而跳过。未写入本机 live profile，未安装、未发版。
Decision: 新增 0.2.1-rc.2 pin——与 rc.1 同 fingerprint、同 behavior、同 Cordis，仅新增身份行；必要性结论与 alpha.3/alpha.4/rc.1 相同，保留闸门。
Related evidence and ADR: ADR-0001、ADR-0002、docs/startup-driver.md、src/driver/provenance.json
```

结论：rc.2 是本系列里最窄的一次变更——对 goal continuation 面零改动（driver 与全部 continuation 包逐字节相同），改动只在 Web 搜索与模型标签；插件适配只剩一行身份。发布当时 npm 上的 rc.2 发行不完整（两个包缺失），因此完整 CLI e2e 留待上游补齐后重跑，其余检查均在真实 rc.2 continuation 包上完成。

## 观察记录：插件页只渲染 bundle，不属于 bundle 的 Loader 行没有入口

2026-10-05 于 DSH 0.2.1-alpha.1 复核：`dsh-client-ui-plugin-manager` 的 Plugins 面板以 `packages = listBundles().map(bundle => packageView(bundle, plugins))` 组卡，行只挂在自己 bundle 的卡片内；`dsh-plugin-manager` 的 `listBundles()` 对**非 bundle 依赖**只在它同时被选入 `dsh.profile.bundles` 时才列出（且以 `not-bundle` 错误呈现），而 `bundleManifest()` 只认声明了 `package.json.dsh.bundle.patch` 的包。因此"普通依赖 + 手写 `insert` 行"这种交付方式虽然能正常挂载，却在插件页完全不可见，也没有启停入口；设置里的只读「插件列表」虽然直接读 Loader 因而能看到该行，但那是诊断视图而非管理入口。

本仓库据此把交付形态改为标准 bundle 层（见 [ADR 0003](<adr/0003-ship-as-profile-bundle.md>)），不再等待上游改变这一缺口；上游是否给"无主 Loader 行"提供视图不影响本插件的安装与可见性。此观察只记录事实与影响范围，不作为阻塞项，也不推断 master 行为。

