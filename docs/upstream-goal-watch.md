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
   pnpm check:patch
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
Plugin version / commit: 0.2.0 功能分支（本次 pin 提交）
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

