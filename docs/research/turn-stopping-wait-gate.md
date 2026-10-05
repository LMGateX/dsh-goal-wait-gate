# `agent/turn-stopping` 等待闸门：源码与隔离可行性研究

> **状态：已完成源码分析和 30 个隔离原生实验场景（含负对照）；正常路径有条件可行，不是生产实现或迁移决定。**
> 当前已安装插件、运行中的 profile/会话及其 goal 状态均未改动，没有重启服务。原型及脱敏证据只保存在独立研究分支；现有 [ADR-0001](<../adr/0001-retain-activation-gate.md>) 仍然有效。
> 先读第 8–10 节的实验结论与候选方案；第 1–7 节保留源码分析及其提出的验证问题。

## 1. 基线、证据与源码结论

基线为实际安装发布包中的 `@deepseek-ai/dsh-agent-loop`、`dsh-agent`、`dsh-goal`、`dsh-goal-round-driver`、`dsh-tool-goal`、`dsh-subagent`、`dsh-tool-jobs` **`0.2.0-rc.2`**，事件总线为 `@deepseek-ai/cordis` **`4.0.4`**。结论来自直接读取这些包的 `package.json`、`lib/index.js`、相关 `lib/types` 和 Cordis `src/events.ts`，不是以最新文档替代安装版本。术语沿用 [GLOSSARY](<../../GLOSSARY.md>)。

**核心结论：能阻止父 agent 进入 idle，从而推迟官方 driver；不能同时让父 agent 在未释放的 await 内处理新输入。** 因此这是一种“占住当前 turn 的协作式等待”，不是独立的 scheduling defer。若接受 `running` 等待的产品语义，并在任何待处理输入、abort、终态与卸载时及时释放，源码没有排除做隔离原型的可能；目前不足以替换 activation 闸门。[S1][S2][S3]

### 公开来源索引

以下 GitHub 链接是各发布包 `repository.directory` 指向的公开上游模块；**`master` 会变化，不是 `0.2.0-rc.2` 的锁定 permalink**。Context7 提供了官方测试模块的定位；直接获取上游源码受网络访问限制，且未确认发布包对应的 upstream commit/tag，故不虚构版本映射。隔离实验的实际模块版本和入口 SHA-256 已另存为证据。核对方法是先固定上述发布包版本，再定位下列函数；行号是该版本发布文件中的定位，不是 GitHub master 行号。

| 索引 | 公开上游来源 | 本次实际读取的模块/函数与定位 |
|---|---|---|
| S1 | [agent-loop](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop) | `lib/index.js`：`ReactLoopInbox.claim/mutate` 103–109、180–207；`ReactLoopAgent.status/send/cancel/wakeDriver/whenIdle/kick/turn/step` 790–1155；生命周期 `dispose` 1677–1706 |
| S2 | [agent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent) | `lib/types/runtime-types.d.ts`：`Agent.whenIdle/send/followup/steer` 151–197、`agent/turn-stopping` 370–391；`lib/types/dispatch.js`：`agentEvents.emit/serial` 31–72 |
| S3 | [goal-round-driver](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver) | `lib/index.js`：`readyToDrive/drive/requestDrive` 73–198、状态/goal/session 监听 200–272、`validReservation` 273–339、卸载 341–360 |
| S4 | [goal](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal) | `lib/index.js`：`applyGoalEvent` 265–279、`edit/pause/resume/complete` 657–711、`setActivation/withPhase/transition` 790–823 |
| S5 | [tool-goal](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/tool-goal) | `lib/index.js`：`goalToolExecution/openTurnEvents/hasDirectHumanInput/isMatchingGoalRound/completionAuthority` 12–79、`update_goal` 336–373 |
| S6 | [Cordis EventsService](https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/events.ts) | `dispatch/serial/isBailed/register/unregister/on`：13–15、165–174、204–208、254–301 |
| S7 | [subagent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent) | `lib/types/continuation-activation.js`：`notifySettlement` 669–686；发布 bundle 同函数 1254–1271 |
| S8 | [tool-jobs](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/tool-jobs) | `lib/index.js`：`apply` 中 settlement subscription 263–296 |

## 2. 等待发生在哪里，何时不发生

正常路径如下：[S1]

```text
模型 step 完成或工具声明 concludesTurn
  → step/end 已追加
  → turnEnds 非空且 nextStep 为空
  → await dispatch.serial(agent/turn-stopping, { turn, signal })
  → signal.throwIfAborted()
  → 再读 nextStep：有则继续当前 turn 的下一 step
  → 没有则 turn/end
  → 有 pending 则继续下一 turn；完全无 pending 才经 kick 进入 idle
```

await 期间 phase 仍为 `running`；`turn/end` 尚未写入；`whenIdle()` 尚不能完成。官方 `readyToDrive()` 要求精确 live Agent、插件 active、没有 stopping/competing prompt，且 `agent.status === "idle"`。所以**正常 hook await 不调用模型、不预留下一 goal round、不更改 activation**；当前 goal round 若已 admitted，其 round 计数早已消耗，不会因等待回退。[S1][S3][S4]

它不是“每个 turn 都必定调用一次”的关闭通知：[S1]

| 分支 | 是否经过 hook | 含义 |
|---|---|---|
| 正常 assistant 结束 / `concludesTurn`，nextStep 为空 | 是 | 已输出 assistant message，并结束 step，尚未结束 turn |
| `max-tokens`，nextStep 为空 | **也是** | driver 的 max-tokens disarm 在之后的 `turn/end` 才执行；长期等待会延迟该保护 |
| 普通工具调用，`step()` 返回 null、尚欠模型回应 | 否 | 不能在工具调用循环尚未收口时依赖此 seam 等待 |
| nextStep 已有 steering / additionalContexts | 当次跳过 | 先处理输入；队列排空后才可能调用 |
| `preStep` reject | 否 | 直接 blocked turn return，随后 finally 写 turn/end |
| 首个 step 没有 admitted 消息 | 否 | completed turn 直接 return |
| `turnEnds` 已存在，随后 preStep 返回空消息而 break | 否 | 这条收口路径不再调用 hook |
| 异常或 abort 在到达 hook 之前 | 否 | 经 catch/finally 处理；turn/start 追加失败更早退出 |

hook 可因监听器 steering 而在同一 turn 后续 step 再次触发，不能按 turn 缓存一个永久 resolved/rejected promise；也不能把它当成“一次性目标完成事件”。payload 只有 Agent、turn、signal，**没有结束 reason 或 goal-round identity**。若要排除 max-tokens，需另读可靠的结束证据，不能凭 hook 名字推断。[S1][S2]

## 3. 输入：可以入队，不能在未释放的 await 内执行

`followup` → next-turn+wakeup；`steer` → next-step+wakeup；`inject` → next-step、无 wakeup。`send` 先持久化 inbox splice，随后发 `agent/inbox/inserted`。在未 abort 的 running phase，`wakeDriver()` 直接返回，不启动并行 driver，也不使 serial await 自动结束。[S1][S2]

因此：

- **新输入可被接收并持久化；模型不能处理它，直到所有在前的 await 结束。** 若闸门只等“全部 live work 结束”，人类询问、纠正、子 agent 请求父 agent 做决定都可能无限等候。工作依赖父 agent 回答时存在真实的循环等待风险，而不是仅 UI 显示问题。[S1]
- 释放后 `steer/inject` 在同一 open turn 继续 step；只有 followup 时先写当前 turn/end，再执行独立新 turn。两个过程通常都仍 running，不会在其间交给 goal driver。[S1]
- 闸门不能只等 job/subagent terminal：进入 hook 时已经存在的 **nextTurn** 也必须检查；否则会把本来已经可执行的 followup 隐藏在等待后面。应在安装释放监听前后重新检查 inbox/工作/goal，防止检查—订阅窗口丢通知。[S1]
- `agent/inbox/inserted` 是可用的释放信号，但事件本身不保证 wakeup：包括 inject、inbox 编辑；释放后的处理语义由 loop 决定，不能把每个 inserted 都解释为人类输入。[S1][S2]

### 实际后台回报路径的区别

- continuable subagent 的 `notifySettlement()`：父 idle 则 queue/followup，父 running 则 steer；closing teardown 时改用 inject。因此本方案的 running 等待会使正常子 agent terminal notice 留在当前 turn。[S7]
- `tool-jobs`：只有选用 wakeup delivery、owner idle、且 wake budget 允许时才 followup；owner running 时 **inject**。还会略过已 awaited、model-killed、teardown 等 settlement。故不能假设“每个 terminal job 都会发 waking notice”，也不能等 notice 已被模型消费后才释放——消费本身被 await 阻挡。[S8]

**候选释放协议只能是“有任何可处理输入时先让 loop 前进，待它再到 stopping 边界重新评估”，不是“始终 hold 到所有后台工作结束”。** terminal、notice 入队、notice 处理完，是三个不同时间点；必须通过真实官方模块验证它们的顺序。[S1][S7][S8]

## 4. Abort、goal 变化和卸载

| 情况 | 源码行为 | 对候选闸门的要求 |
|---|---|---|
| `agent.cancel` | 默认清 inbox、清 wakeRequested；只对当前 AbortController 调 abort；keepInbox 保留输入 | hook promise 必须响应 signal；loop 只在 serial await **返回后**检查 abort，不会自动 race 任意 promise [S1] |
| agent disposal | `cancel({kind: disposed})` → `await whenIdle()` → scope dispose → detach | 不能只等 `agent/disposed` 或 agent scope 的最终 cleanup 来释放；这些可能发生在 whenIdle 之后 [S1] |
| 外部 goal pause | goal 变 paused/disarmed；driver 在 running 且 initiator 非该 Agent 时 cancel，keepInbox=true | 响应 abort，同时重读 goal；是否来自模型自身的 pause 不能靠状态一概推断 [S3][S4] |
| goal complete / block / clear | phase/activation 终止；driver 的 changed listener 不因这些操作自动 cancel | 监听 goal 变化并主动解除等待；不能等后台结束或假定终态自动 abort [S3][S4] |
| goal edit / resume / replacement | revision/identity 可能变化，driver 收到 changed 但 running 时不能续轮 | 使用最新 goal；不得恢复旧目标、旧授权；active+armed 的 resume 本身会被拒绝 [S3][S4] |
| activation 单独 disarm | goal 模块发 activation-changed；driver 没有该事件的调度监听 | 闸门要另读/观察 activation；不能把外部撤权解释为 owned hold 或自行 rearm [S3][S4] |
| gate 插件 unload | Cordis 移除 listener；不会取消已返回的未 settled promise | gate 自己持有的所有 pending wait 必须在卸载时 resolve/清理订阅，不能仅 unregister [S6] |
| native driver unload | 标记 stopping、disarm；存在 attempt 且 running 时 cancel+await whenIdle | hook 忽略 abort 可卡住官方 driver 卸载；卸载时 disarm 属于原生 lifecycle，不能由 gate 阻止 [S3] |
| hook reject/throw | turn 记 error，发 agent/error；native driver disarm | 正常延期不得靠抛错结束；失败策略要明确区分“释放后续走”与“原生失败撤权” [S1][S3] |

任何 listener 内等待**同一父 Agent 的 `whenIdle()`**都是自等待：whenIdle 等当前 driver，当前 driver 等 listener。agent scope disposal 同样不是可靠的第一释放点。取消后的 waking send 会重定向 next-turn，并等待 aborted activity 收口；disposed cause 的输入不会自动重放。[S1][S2]

## 5. Serial 监听顺序不是延期协议

`agentEvents.serial()` 转发 Cordis `serial`：按 dispatch 时已筛选的 callback 快照逐个 await；默认注册顺序 push，prepend 是 unshift；`isBailed` 对非 null/false/undefined 值提前停止。stop hook 类型要求 void/Promise<void>，应保持这个契约，不返回布尔“拒绝”。异常直接传播，和 contained 的 `agentEvents.emit()` 不同。[S2][S6]

公开 stop hook 说明的“Data decides, listener order cannot change the outcome”描述的是：监听器写 steering，loop 最后重读 inbox，决定继续或结束。**它不意味着无限 await 不影响后面的 listener。** 一个前置等待监听器会阻止后置补充 steering 的监听器执行；在前 listener 已注入输入后，后置 gate 必须重读 inbox而不能继续睡。callback 已进入 dispatch 快照后，卸载 unregister 也不撤回该调用或其 promise。[S1][S2][S6]

因此不能承诺跨插件加载顺序独立，也不应要求 gate 必须压在所有 listener 前/后作为稳定保障。隔离实验要覆盖其他 stopping listener 注入输入、等待与失败的组合。[S6]

## 6. Goal round 收口、身份与完成权限

需要区分三个“完成”：assistant step 结束、driver 在 idle 退休一次 attempt、模型用 `update_goal complete` 宣告 objective 完成。[S1][S3][S5]

- native driver 的 reservation 使用 `goalId + revision + round`，queued 对比还检查 prompt content；admitted 由具体 `user/message.id` 标记。计数由 `applyGoalEvent(user/message)` 在下一精确 round 被 admitted 时增加，**不是 hook 或 turn/end 增加**。[S3][S4]
- driver 没有监听 turn-stopping 来退休 attempt；running 时 attempt 保留。释放后若 inbox 空，`turn/end` → idle，driver 按现有 checkpoint/attempt retirement、最新 goal/cap 决定下一轮；因此**正常干净释放可不调用 resume、不自行发 goal prompt，交还原生 driver**。[S1][S3]
- `whenIdle()` 是全 agent activity 的 quiescence，不标识某个消息的完成。若 hook 后还有多条 followup，activity 可继续经过多个 turn 才 idle；不能把一次 hook release 或 whenIdle 当作具体 goal prompt 的完成证明。[S1][S2]
- `goalToolExecution` 要求精确 live Agent、running、当前 initiator 是它并有 open turn；`completionAuthority` 要么当前 root turn 已 admitted 直接 human source，要么当前 open turn 已 admitted **与最新 goal id/revision/roundsStarted 精确匹配**的 goal source。它不以 activation armed 代替这些条件。[S5]
- 原 goal turn 内释放后处理 steer/inject 回报，若 goal 未改变，可保留该 turn 的 exact-goal-round completion authority；输入未 admitted 前仅在 inbox 里，不会新增权限。followup 到独立回报 turn 则不能继承旧 round authority；之后仍可由原生 driver 进入新的合法 goal round。[S1][S5]
- await 期间 edit/resume 改 revision、或 complete 后替换 goal，会使旧 admitted source 不匹配最新 goal。单纯重新 get_goal 不补出当前 turn 的 round authority；不能伪造 source=user 或 source=goal 解决它。[S4][S5]
- autonomous complete/block 工具 defer 一个 wrapup context，再让模型写最后消息，并非直接硬 cancel；terminal 后仍可能有 next-step context。闸门不得以“phase complete”把已提交的 closing step 丢掉。[S1][S5]

## 7. 源码分析提出的实验清单与具体阻碍

### 需验证或显式接受的约束

1. **输入活性**：长期 serial await 不会自动处理 followup/steer/inject；只按 live-work terminal 释放会阻塞人类和父子协作。
2. **生命周期活性**：AbortSignal 是协作通知，非 promise 抢占；忽略它会阻塞 whenIdle、agent dispose、driver unload。goal complete 本身又不触发 abort。
3. **覆盖不全**：hook 会被跳过，也涵盖 max-tokens；不能覆盖所有 idle 前场景，不能延迟原生异常/限额保护后再称语义等价。
4. **监听顺序**：serial await 阻塞下游 listener；本次没有证明任意插件组合安全。
5. **身份/权限**：保持 running 可以保留当前 round 上下文，但 revision 变更与切新 turn 都改变完成权限；保持 armed 不等于获得 completion authority。
6. **产品语义变化**：父仍 running、turn 未闭合、whenIdle 未完成；这与现有“父 idle、仅 goal scheduling 被 withheld”的桥接不是同一契约。

### 仅供隔离验证的最小候选

不改 activation，不删改 goal prompt，不替换 driver；仅在 active+armed、有 live work、无任何 pending 输入且非终态时，暂留当前 stopping boundary。等待必须是 abortable，并在 inbox 插入、相关工作变化、goal/activation 变化、gate unload 时重新评估或释放。等待结束只返回 void，由 loop 自己处理队列/turn/end/idle，由官方 driver 决定后续轮次。超时若选择释放，将允许仍有后台工作时续轮；这属于显式失败策略，不是无损延期保证。[S1][S3][S6]

父 agent 应使用真实官方 goal/driver/tools 的隔离集成环境，至少记录：

- 正常 hold 的 status、open turn、模型调用数、roundsStarted、goal phase/activation/revision；释放后只新增一轮且 prompt 使用最新 goal。
- hold 前已有 nextTurn，以及 hold 后 followup/steer/inject：均能及时解除等待并处理，不需等待后台全部结束。
- job running/stopping/terminal notice、suppressed notice、多个子 agent 分批结束和父子相互请求；验证“terminal ≠ notice 已处理”。
- 同 turn 两次 stopping；普通工具循环、首步空输入、reject/error/abort/max-tokens；不得把未调用 hook 误当通过。
- 用户 cancel（两种 keepInbox）、disposed、external/model pause、complete/block/clear、edit、goal replacement、activation 单独 disarm。
- gate unload、driver unload、agent/factory dispose 的所有 pending wait 均可有界结束；不要以最终 disposed 通知作为唯一释放源。
- stopping listener 放在 gate 前后分别 steering/throw/await；不得有下游 listener 饥饿或重复订阅。
- 当前 goal turn 内处理回报 versus 独立 followup 回报 turn 的 complete 权限；并发 revision 变化后的拒绝行为和合法下一轮恢复。

**源码阶段建议：进行隔离可证伪实验，不凭源码就修改 ADR 或上线迁移。** 以下实验已验证其中的正常路径与若干失效条件，仍未证明任意插件组合安全，也不构成独立 idle scheduling gate。


## 8. 已执行的隔离实验

### 方法与可复核证据

原型没有启动 DSH Web/CLI profile，没有读取共享会话或访问真实模型服务。每个场景创建独立 Cordis context，使用实际发布的 SessionStore、ProjectionRegistry、AgentRegistry、AgentLoop、GoalService、goal-round-driver、ToolRuntime、goal tools、jobs-local 和 tool-jobs；仅模型输出和业务 producer 的完成时机由确定性本地适配器控制。子 agent 场景另使用真实 subagent/spawn/one-shot 模块，并将真实 JSONL persistence 指向新建临时目录。[E1][E2][E3]

实际执行 **30 个场景**，其中包含有意省略安全处理的负对照。为检查可复现性做了三次完整执行，脱敏观测完全一致。脚本退出码为 0 表示场景执行和清理有界完成，**不是“30 项生产安全性测试全部通过”**；负对照故意展示失效。脚本无正式测试框架，现有插件测试仍是独立的 25 项测试。[E1][E2]

- [可重复运行的原生实验脚本][E1]（研究 commit 固定链接）。
- [完整脱敏观测 JSON][E2]（不含本机路径或生成的 session/goal id）。
- [实际加载模块的版本与入口 SHA-256][E3]（不虚构上游 commit 对应关系）。
- [离线状态演示][E4]（纯状态模拟，不连接 DSH，不作为集成证明）。
- [运行说明][E5]及 [研究 issue #8](https://github.com/LMGateX/dsh-goal-wait-gate/issues/8)。

普通 non-completing 场景配置原生 maxGoalRounds=1 以限制执行；释放后最终 blocked/disarmed 是原生 round-limit 策略，不是候选 gate 调用了 disarm。场景清理时由实验宿主完成 goal 并销毁 handle，不应把这些清理动作归因于 gate。[E1]

### 主要观测

| 场景（完整名称见 JSON） | 实际结果 | 判定 |
|---|---|---|
| 无 gate、存在真实后台 job | job 仍 running；父 idle 后原生准入 1 个 goal round | 普通后台任务不保活父 driver |
| 正常收尾 hold | 父 running、turn/end=0、模型调用固定为 1；goal active+armed、revision=1、roundsStarted=0 | 核心机制可行；等待本身不调用模型或变更 goal |
| 原生 job completion | notice 通过 inject 在原 turn 准入；随后原生下一 turn 才准入 goal round | 可以只释放等待、不手工生成 goal 提示 |
| 原生 goal round 等待 job 后完成 | 当前 turn 中 get_goal 和 update_goal complete 都成功；roundsStarted 仍为 1，完成后无下一轮 | 原生计数、exact-round 权限和 wrapup 保留 |
| 人类 followup / steer、预先排队 followup | 均被处理；followup 开新 turn，steer 保留原 turn；仍有工作则再 hold，goal rounds=0 | 必须检查两个 inbox 目的地并观察插入 |
| 原生 continuable child settlement / 子 agent 中途请求父决策 | 先处理 subagent-settled 或 agent-message；中途消息处理后父重新 hold，子仍 live；最终 notice 在下一 goal round 前准入 | 不能只等子完全结束；当前通知路径可协作 |
| 原生 one-shot subagent tool + jobs notice | delegation tool 成功；child 收口后 tool-jobs notice 先准入，再交给 native goal round | 不是手写假 child 通知的证明 |
| 用户 cancel / parent handle dispose | abort 释放；cancel 后 native disarmed；dispose 后 agent detached、owned producer cancel=1、holds=0 | 可打破 dispose → whenIdle → owner cleanup 环 |
| gate unload / native driver unload | 两者均有界结束；前者恢复原生续轮，后者保留原生 disarm，无遗留 hold | gate disposer 和 abort/activation 监听不可省略 |
| host complete / pause / clear / disarm-only | 都能收口；外部 disarm 未被 rearm；clear 不留目标 | 终态与单独撤权均需释放，不只等业务结束 |
| **负对照：不监听 abort** | cancel 后父仍 running、turn/end=0、goal 仍 armed；手工释放后才退出 | 不能以 cancel 会“自动打断 Promise”为前提 |
| **负对照：不筛 max-tokens** | 截断后仍被 hold、goal 仍 armed；释放后 native 才 disarm | 盲目 await 会延迟原生保护 |
| 带模型 finish guard 的 max-tokens / provider failure | 截断不 hold，native disarm；provider failure 不经过 stopping hook，也由 native disarm | 异常不是可无限延后的正常等待 |
| **负对照：旧自主 turn 在 host edit 后仍保留** | get_goal 成功但 complete 返回 GOAL_TOOL_AUTHORITY_REQUIRED | 最新 revision 不自动刷新旧 turn 的 goal source |
| edit-aware 释放后原生新 revision 轮次 | 新版 goal source 由官方准入；在自主场景完成成功，累计 rounds 从 1 到 2 | 可保持原生权限，但目标修改会允许一次合法重新评估轮次 |
| 原人类 turn 等待后处理后台 notice | 同 turn 的原生 edit 仍成功 | 持有 turn 会延长 direct-human authority 的机械有效期；须接受并说明，不伪造来源 |
| 独立非人类 followup turn | armed 仍不能使 complete 获权，返回 GOAL_TOOL_AUTHORITY_REQUIRED | armed 不是权限替代品 |
| **覆盖负对照：idle 时启用 goal / 普通 pre-step reject / 更早 serial listener bailout** | 均可在 live work 尚在时准入一个原生 goal round，之后才到 wait 点 | 单靠 stopping hook 无法保证所有入口零注入 |
| gate 后面的 serial Stop listener | hold 期间调用次数为 0；释放后才为 1 | 其他 Stop hooks 被延期是实测副作用 |

原型只在通知入队/适当 job settlement 后释放，不以 child registry-empty 事件盲目释放。真实 continuable 路径中 notice 先于 goal round 准入已观测到，但“child unregister 先于 settlement notice”的源码顺序仍存在；没有证明任意 provider/轮询时机都不发生竞态。[S7][E1][E2]

## 9. 可形成的候选方案：协作式收尾等待

**方案可行的范围：正常任务收尾点的 running-wait，不是完整替代 idle scheduler 的新接口。** 可以保留原生 goal 状态、工具、driver、reservation、计数与权限，只新增管理等待 Promise 的模块；正常等待不调用 disarm/resume，不修改/伪造 prompt 或 source，不注册一个永远活着的业务 job。

~~~text
正常响应已经完成，准备收尾
  → active + armed，有业务 live work，两个 inbox 都空，确认不是异常结束
  → 等待器保持原 turn 打开；不调用模型
  → 有输入 / abort / goal 变更或撤权 / 卸载 → 立即解除等待
  → 原生循环处理 inbox；回到 stopping 时再检查
  → 无未处理工作则允许自然收口至 idle
  → 原生 driver 自行决定是否及如何续轮
~~~

若进入后续实现，最低要求应是：

1. **明确选择 running-wait 产品语义。** UI 中父持续 running，turn/end、whenIdle、headless/ACP 请求完成和 idle maintenance 均可能延后；应另显示等待原因，而不是宣称它与父 idle 等价。这是对 ADR-0001“不占住父执行流程”条件的另一种取舍，需新 ADR/用户批准，不能悄悄替换。
2. **输入优先、无丢唤醒。** 按精确 live Agent 持有 waiter；检查已有 nextStep 和 nextTurn；监听包括 non-waking inject 在内的 inbox 插入，安装 waiter 后同步复核。释放先让原生前进，不在锁内再等输入已被模型处理。
3. **可取消、可拆卸。** 直接响应 hook signal 和 gate disposer，释放返回 void；不要以 agent/disposed、whenIdle 或 owned job teardown 作为第一释放条件。等待地图/订阅必须有界清理，不触碰外部授权。
4. **区分正常停止和输出截断。** 当前 hook payload 不含 reason；实验通过公开 llm/stream 观察 finish 的辅助模块，未知/异常状态 fail open 交回原生处理。必须进一步验证 retry、所有目标适配器和 tool-conclusion 路径，不能把单个确定性 adapter 的结果外推。
5. **目标版本变化是重新评估点。** Edit/replacement 时退出旧等待，让原生最新版本轮次取得权限；这允许在后台仍有工作时出现一次目标重新评估轮次，需明确为合法行为。不要继续沿用旧自主轮次 source，更不能伪造人类或 goal 来源。
6. **通知与工作生命周期单独建模。** 升级时核对 selected jobs/subagent provider 的 notice 路由和 settlement cutoff；最后一个 child 从 live registry 消失不等于其 notice 已送达。未来实现要覆盖任意深度 descendants、stopping、suppressed notices、interrupted parked children。
7. **显式选择超时/失活策略。** 原型只有实验观测/清理 deadline，没有生产 maxHold 策略。若超时放行，将恢复仍有工作时原生续轮；若选择 cancel，则由原生异常路径撤权。二者都不是透明、无限保持 armed 的无损保证，不应悄悄忙重试。
8. **限定兼容组合，先 opt-in。** 原型没有覆盖全局 Stop hooks、Web/ACP/headless 集成；不要与同一 agent 上现有 activation gate 叠加。应作为单独研究模式在确认的版本/组合中验证，而非默认升级。

## 10. 结论与剩余证据缺口

**结论：值得作为候选方案继续工程化，核心机制和关键正常路径已用原生模块验证；尚不满足直接替换现有插件的条件。** 它更符合“业务等待不撤销 goal 授权”的意图，且不必替代原生 goal 注入。但不能同时承诺“父 agent 真的 idle”“所有入口零空轮次”“任意 Stop listener 不受影响”或“所有回报 turn 都有 goal 编辑/完成权限”。

本次未执行：真实 LLM 语义/目标感知验证、共享 GUI 或 ACP/headless 验收、restart/fork 的持久回放、多个 DSH 版本、长时间/高并发压力、任意深度子树与 interrupted parked FIFO、keepInbox 全排列、timeout fallback，以及任意插件监听排序/所有模型适配器。测试输入入队到放行是在确定性本地环境中观测的，不是生产延迟 SLA。[E1][E2][E5]

保留当前已安装策略和 ADR-0001；后续若决定实现 running-wait，先写新 ADR 明确语义取舍，再按上述缺口建立真实原生集成验证。更长期仍观察上游是否提供独立调度 defer + re-evaluate seam：若有，优先避免通过长时间打开物理 turn 实现等待。

[E1]: https://github.com/LMGateX/dsh-goal-wait-gate/blob/b583fbc972c969f5d28c07202d59f08dd28a2ffc/prototypes/turn-stopping-wait/native-experiment.mjs
[E2]: https://github.com/LMGateX/dsh-goal-wait-gate/blob/b583fbc972c969f5d28c07202d59f08dd28a2ffc/prototypes/turn-stopping-wait/observations.json
[E3]: https://github.com/LMGateX/dsh-goal-wait-gate/blob/b583fbc972c969f5d28c07202d59f08dd28a2ffc/prototypes/turn-stopping-wait/host-manifest.json
[E4]: https://github.com/LMGateX/dsh-goal-wait-gate/blob/b583fbc972c969f5d28c07202d59f08dd28a2ffc/prototypes/turn-stopping-wait/state-model.html
[E5]: https://github.com/LMGateX/dsh-goal-wait-gate/blob/b583fbc972c969f5d28c07202d59f08dd28a2ffc/prototypes/turn-stopping-wait/README.md

[S1]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop
[S2]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent
[S3]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver
[S4]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal
[S5]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/tool-goal
[S6]: https://github.com/deepseek-ai/deepseek-harness/blob/master/vendor/cordis/src/events.ts
[S7]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent
[S8]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/tool-jobs
