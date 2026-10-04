---
status: accepted
---

# 保留 activation 闸门，等待上游提供独立的调度扩展点

保持当前通过 `disarm/resume` 暂缓自动 goal 续轮的实现，不 fork、修改或替换官方 goal driver。它是一个已知的兼容性折中：DSH `0.2.0-rc.2` 尚未提供已核实的、能在保留 activation 的同时暂缓下一轮并请求重新评估的专用调度接口；后续升级依据[观察清单](<../upstream-goal-watch.md>)重新评估，而不是现在引入更脆弱的拦截技巧。

## 讨论背景与范围

后台 job 或 subagent 尚在工作时，父 agent 的 idle 不代表整项任务停工。自动 goal 续轮可能反复唤醒模型，却没有新结果可处理。另一方面，执行中现实可能变化，模型需要理解当前目标，用户也可能修改目标；不能把“等待已有工作”解释为“目标不再有效”。

本记录的行为基线是实际安装的 DSH `0.2.0-rc.2` 的 goal、goal tools、goal-round-driver 和 agent loop 实现。它不是所有历史版本或未来版本的保证，也不是仅凭设计哲学推导出的结论。术语见[词汇表](<../../CONTEXT.md>)。

## 已核实的区别

1. **Goal phase、continuation activation、调度时机是不同概念。** 当前插件只把 `active + armed` 临时变成 `active + disarmed`，不调用 `pause`，不删除目标，不停止已有后台工作。
2. **Disarmed 本身不禁止读取或编辑。** 官方 `get_goal` 不要求 armed；goal 模块的 `edit` 保留 phase 与 activation，并更新 revision。插件释放时读取最新 revision，不恢复旧目标快照。
3. **模型编辑权限是另一层限制。** 官方 goal 工具要求 `create/edit/pause/resume` 的当前顶层轮次包含宿主确认的人类直接输入。纯自主 goal 轮次或仅由后台回报唤醒的轮次不能据此自主编辑 goal，即使 activation 是 armed。改变执行计划与改变用户的完成目标也不能混为一谈。
4. **目标存在不等于最新目标始终可见。** Goal mutation 不自动注入模型上下文；`get_goal` 结果和已进入历史的 `<goal_round>` 才是模型看到目标的途径。Disarm 不会主动删除这些历史内容，但上下文压缩和后续目标编辑可能使模型持有的目标信息不完整或过时。
5. **Activation 不携带等待原因。** 插件等待、会话恢复后未获重新授权、异常撤销续轮，都可能表现为 `disarmed`。插件内部持有 owned hold，但官方工具结果并不能仅凭 activation 区分这些原因。

## 为什么不改用现有通用拦截

| 选项 | 取舍 |
|---|---|
| 保留 activation 闸门 | 保留官方 driver 对续轮预留、计数、持久化检查、取消与竞态的所有权；代价是用续轮权限表达暂时等待。采用此项。 |
| 直接在 `agent/pre-step` 拒绝 goal 提示 | 它是已经排队之后的准入接口，不是调度前闸门。官方 driver 的下游拒绝分支可将有效目标置为 `blocked / prompt-rejected`；其他监听顺序也可能落入不同竞态路径，不能当成稳定的等待协议。 |
| 在 `pre-step` 中长期 await | 此时 agent 已为 running，提示已被 claim；会占住父 agent 的执行流程，不等价于保持空闲并让其他输入正常唤醒。并发输入、取消和结果处理仍需额外验证。 |
| 删除或改写队列中的 goal 提示 | 可能干扰官方 reservation、取消与 stale 处理，缺少明确的延期及恢复契约。没有采用。 |
| 替换官方 goal driver | 可以自行实现等待策略，但必须承担官方 driver 当前处理的竞态与生命周期逻辑，超出轻量桥接范围。没有采用。 |

结论不是“DSH 完全没有拦截接口”或“原则上不可能实现”，而是：**当前没有已核实的、与官方 driver 正确协作的独立暂缓调度契约。**

## 本次决定的后果与非目标

- 继续沿用现有 owned hold、显式 re-arm 让步、最新 revision 释放、终态不恢复和超时策略；不修改运行时代码、配置或包版本。
- 等待期间的合法编辑不应被插件阻止；模型自主编辑的权限问题不通过伪造人类输入或绕过官方工具解决。
- 暂不增加目标快照注入、自动读取提示或新的等待原因字段；这些只是可能的后续改进，不是现有功能或本次承诺。
- 现有编辑后释放测试使用 fake goal 模块，验证 revision 衔接；它不是官方工具编辑权限、真实模型感知或实际运行会话行为的集成证明。
- 保持当前实现不意味着所有交互已经被覆盖。Owned hold 按 agent 和 goal id 跟踪，不能仅凭同一目标的 disarmed 区分后来另一个生命周期所有者再次撤销授权；升级检查必须覆盖这种重叠情况。

## 重新评估条件

优先观察上游是否增加**调度前暂缓 + 条件变化后重新评估**的公开 seam，或让官方 driver 原生识别待返回的后台工作。只有确认不会修改目标授权、占住父 agent、消耗 round、阻挡人类输入或后台回报，并通过隔离集成验证后，才考虑迁移或停用当前闸门。

目标可见性、编辑权限和 lifecycle 改动也应触发复核，但单独放开 edit 并不能解决频繁续轮；单独增加 reject 或回调也不足以证明有安全的延期协议。

后续[收尾等待研究](<../research/turn-stopping-wait-gate.md>)已验证另一条有条件可行的路线：保持父 running/open turn 来延后 idle，而不改变正常等待期间的 activation。它有意占住父执行流程，不满足本 ADR 对独立调度 seam 的条件；若选择该取舍，需另立决策。当前保留 activation 闸门的决定未变。

后续[Driver 替换与多策略配置研究](<../research/goal-driver-replacement.md>)另有 32 个隔离原生场景，支持 version-pinned native adaptation 在 idle/armed 语义上的 locality；但接管了 scheduler 的兼容/通知/所有权责任，pending-notice 与最终 admission 仍有边界。它是需要新决策的替代路线，不把本 ADR 的轻量桥接默认悄悄改成 forked driver，也尚未发布模式选择或热切换功能。
