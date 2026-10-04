# Goal driver 替换与多策略配置研究：DSH 0.2.0-rc.2

> **状态：源码研究 + 32 个隔离原生模块场景已完成；未达到生产验收、未迁移、未作新 ADR 决策。** 本报告只评估方案，不修改已安装包、profile、运行中会话或插件实现。已有 [ADR-0001](<../adr/0001-retain-activation-gate.md>) 仍有效；术语沿用 [CONTEXT](<../../CONTEXT.md>)。既有 running-wait 实验见[收尾等待研究](<turn-stopping-wait-gate.md>)，不能当作 replacement 实验结果。

## 1. 结论：哪一种“更便宜”？

**用户的判断在“新增交互面”上得到实验支持：若要求父 agent 真正 idle、正常等待保留 active + armed，应优先打磨版本锁定的原生 driver 改编，而不是 running-wait 或 greenfield。它的改动更集中，但不能据此断言总体工时低很多，或认为几十行增量已经完成生产替代。**

替代范围仅是自动续轮 scheduler（goal-round-driver），不是重写官方 goal 状态、权限工具或 agent loop。本次原型保留这些原生模块；driver 的源码改编仍是自维护责任，不能继续称它只是“不接管 driver 的桥接插件”。

- 相比 running-wait，replacement 不需要长期挂住 `agent/turn-stopping`，避免 open turn、whenIdle、headless/ACP 完成、idle maintenance 和下游 Stop listener 被延后，以及 reason 不在 hook payload 中的问题。这是减少 loop 交互面，不是只减少代码行数。[L]
- 相比从零重写，原生改编可以保留 reservation/admission、精确身份、flush、取消和 teardown 的实现；改动集中在一个深模块的内部 seam。**364 行是已发布 bundle 的长度，不是功能复杂度或重写报价。**[D]
- 成本从“管理可取消 waiter”变成“拥有自动续轮 driver 的兼容、通知时序和生命周期正确性”。即使只改几十行，也接管整套协议；notification handoff 和 live registry cutoff 尚有源码可见竞态，不能以静态 predicate 宣称全部解决。[D][J][S]
- “省 token”应分开：正常 held 状态下两者都可不调用模型；replacement 能覆盖 idle 时 create/resume/goal change 等 stopping hook 未经过的入口，因此有望减少这些入口的无效轮次。本次已测有限场景的模型调用/准入数；未测真实模型 token、耗时、工时或百分比，暂无 SLA。[D][L]

**建议排序：保留现行 activation gate 默认；pinned native adaptation 是下一步优先候选；running-wait 保留为有明确语义代价的高级研究选项；greenfield 不推荐作为轻量替代。尚未实施新的可选模式。** 多策略可配置不等于同一 agent 上同时运行多个续轮所有者。

## 2. 证据基线与定位

实际读取发布包的 package metadata、入口 bundle 和相关类型：下列 DSH 包均为 **0.2.0-rc.2**。公开链接来自 package 的 repository.directory；GitHub master 可变化，**不是本次版本的 commit permalink**。官方 Context7 文档也交叉确认 reservation/admission、checkpoint 与 fail-closed teardown，但行为以版本固定的发布源码为准。未核实发布包对应的上游 tag/commit；没有虚构版本映射，以实际 bundle 和入口 fingerprint 固定证据。行号均指该版本发布文件，不是 master 行号。

| 引用 | 公开来源 | 0.2.0-rc.2 发布文件、函数与位置 |
|---|---|---|
| D | [goal-round-driver 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver)、[版本包](https://www.npmjs.com/package/@deepseek-ai/dsh-goal-round-driver/v/0.2.0-rc.2) | `lib/index.js` 共 364 行；renderGoalRoundPrompt 11–18；stateFor/currentGoal/readyToDrive 58–84；drive 103–164；requestDrive 166–198；监听 200–272；validReservation/pre-step 274–340；mount/teardown 341–360。`lib/types/index.d.ts` 6–10 公开 name/inject/apply/renderGoalRoundPrompt，没有 shouldSchedule/re-evaluate 配置。 |
| I | [driver invariant](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver) | `lib/invariant.js`：goalView/validateEvent/install 36–68，按 durable prefix 重建并验证完整原生 prompt。 |
| G | [goal 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal)、[版本包](https://www.npmjs.com/package/@deepseek-ai/dsh-goal/v/0.2.0-rc.2) | `lib/index.js`：applyGoalEvent 265–279；constructor/get/disarm 591–626；edit/pause/resume 657–698；runtimeState/setActivation 778–805。 |
| T | [tool-goal 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/tool-goal)、[版本包](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-goal/v/0.2.0-rc.2) | `lib/index.js`：openTurnEvents/goalToolExecution/hasDirectHumanInput/isMatchingGoalRound/completionAuthority 12–79；update_goal execute 336–373。 |
| L | [agent-loop 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop)、[版本包](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.0-rc.2) | `lib/index.js`：claim 103–110；status/send/cancel/wakeDriver/whenIdle/kick 790–900；preStep/turn 902–1037；step 的 user/message commit 1041–1066；factory dispose 1677–1706。 |
| A | [agent 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent) | `lib/types/runtime-types.d.ts`：followup/steer/inject 182–207；pre-step waterfall 299–310。 |
| J | [jobs 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/jobs)、[jobs-local 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/jobs-local) | `dsh-jobs/lib/types/index.d.ts` 27–57、77–94；`lib/types/types.d.ts` 180–236（JobEvent、subscribe）；`dsh-jobs-local/lib/index.js`：JobEventHub.subscribe/emit/deliver 52–88；emit 590–592；readJob 598–602；settle 736–755。 |
| N | [tool-jobs 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/tool-jobs) | `lib/index.js`：completionDelivery 默认 wakeup 91、226；settlement subscriber 263–296。 |
| S | [subagent 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent) | `lib/index.js`：childSessionMeta 455–478；watchSettlement/settlementState/finishDisposal/notifySettlement 1155–1271；runningDescendants 2268–2289。 |
| P | [subagent-in-process-driver 上游](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-in-process-driver) | `lib/index.js`：startInProcessRun/drivePublishedRun/readResult 161–253；one-shot 的发布、result、取消与 disposal 是独立协议。 |

Repo 基线：[AGENTS](<../../AGENTS.md>)、[CONTEXT](<../../CONTEXT.md>)、最新 [ADR](<../adr/0001-retain-activation-gate.md>) 与既有[研究](<turn-stopping-wait-gate.md>)。当前配置只有 waitForJobs/waitForSubagents/maxHoldMs；以下 strategy 字段是建议，不是功能，见 [config](<../../src/config.ts>)、[activation 实现](<../../src/gate.ts>) 与 [selector](<../../src/live-work.ts>)。

## 3. replacement 必须保留的最小责任集

以下 10 组是最低检查面，不要求重写 goal projection、agent loop 或权限工具。

| # | 必须保留 | 源码依据及遗漏后果 |
|---|---|---|
| 1 | 精确 live Agent、单一串行 driver | registry 中同一实例；states 以 Agent 对象为 key；requestDrive coalesce requested/run，运行于 withoutInitiator。不能只按 session id 或重入触发多轮，也不能将宿主调度误作模型主动操作。[D] |
| 2 | 原生 prompt/source 与完整 reservation | goalId/revision/正 round，attempt 的 messageId/content/phase/cancelled/stale；sameQueued 比完整 source/content。保留 renderer、startsRequestSeries、invariant。字符串 followup 不等价。[D][I] |
| 3 | admission 才计数 | loop 第一次 request 准备后才 append user/message；applyGoalEvent 严格验证 active identity/revision/next round/cap 才更新 roundsStarted。reservation/claim/stale/human 不提前耗 cap；adapter 不直接写 counter。[L][G] |
| 4 | exact authority 与 human authority 分离 | exact live running Agent/currentInitiator/open turn；create/edit/pause/resume 要求 root turn 中 host-attested user 输入；complete/blocked 可用 exact admitted goal round，blocked threshold 仍归 tool-goal。纯 notice turn 无自动编辑/完成权限；非人类 producer 必须带原有 source，不用默认 user 冒充授权。[T] |
| 5 | queue races、competing/human input 让步 | competing nextTurn 使 queued attempt stale；pre-step await next 前后双 fence；stale 恢复其他 claimed 消息，排除自己的 goal 和 round-0 context。不能清整队列；正常延期不能交给 downstream reject（会 block prompt-rejected）。[D][L] |
| 6 | durability checkpoint | changed 标 needsCheckpoint；flush 后复核 readiness/新 revision/input；attempt 退役也有 checkpoint。flush failure disarm；不得持旧 snapshot 继续发轮。[D] |
| 7 | 原生错误分类与 fail-closed | queue-failed/prompt-rejected blocker；agent/error、driver failure、max-tokens 的 disarm 保留。wait 不抛错、不 pause/block；selector error 不视为“无工作”。[D] |
| 8 | cancel 与外部 pause | discarded 标 cancelled；aborted 的 claimed/admitted/无 attempt 分支不同；idle 有效 queued/claimed/cancelled attempt 会 pause。外部 pause cancel running + keepInbox。延期须清自己 stale attempt，不能误触 cancel→pause。[D] |
| 9 | unload/reload/restart | mount 对已有 live goals disarm；teardown stopping→disarm/stale→parent cancel→await whenIdle/run，fence 在收口期间仍安装。activation process-local，created/恢复默认 disarmed。不能持久恢复 armed 或把旧 Agent state 移给同 id 新实例。[D][G][L] |
| 10 | cap、terminal/clear/edit/ref | cap block round-limit，用最新 ref CAS；edit 不重置计数且保留 activation。暂停/终态/clear 不等于 gate hold；不得 auto-resume 外部 disarmed 或终止目标。[D][G] |

简单 `if idle && goal active then followup(...)` 只覆盖极小部分。即使写显式 goal source，也不等于实现 reservation、双 fence、flush 与 teardown。[D][G][T]

权限工具应原样保留：tool-goal 的 paused-goal model resume 禁令（352）、自主 complete/blocked 后 deferContext 的 closing-message 协议（365–372）也不能由 replacement 放宽。等待通知处理 turn 与 exact goal round 不是同一授权语境。[T]

### cap 顺序的取舍

gate 放原生 cap 检查之后，则最后一个 admitted round 启动的工作仍 live 时，父 idle 可先记录 round-limit，随后才收到结果。这是保留原生顺序，不是新 gate 行为；未证明符合所有等待期望。若改成等回报完成再判 cap，则新增 lifecycle/policy 改动，必须独立决策和测试，不能混进“只加 predicate”。[D]

## 4. 推荐实验：version-pinned native adaptation

### 4.1 内部 seam

rc.2 apply(ctx) 无 config，也无公开 shouldSchedule/requestDrive。建议保留对应版本 driver 的完整实现作受控改编；不是 monkeypatch 已安装包，不是卸载后随手发 prompt，也不是两套 driver 并行。[D]

~~~text
native drive
  → exact idle / competing fence
  → flush/checkpoint / attempt retirement
  → latest active + armed goal
  → original round cap
  → shouldSchedule(agent, latest goal, work snapshot)
      false: return；不 requested=true 忙循环，不挂 work Promise
      true: native reservation + followup
native pre-step
  → validReservation + 同步 work 复核
  → await downstream decision
  → validReservation + 同步 work 复核
  → native history admission / startsRequestSeries
work-change / native notice insertion
  → coalesced deferred requestDrive
  → 重读 exact agent、goal、work、inbox
~~~

不要把 gate 塞进 readyToDrive 的总条件、因此跳过 housekeeping。先保留 checkpoint、attempt retirement、cap，再阻止新 reservation。准入处纳入 validReservation：newly appearing work 经原生 stale 分支退回并恢复其他消息，不把 wait 转成 downstream reject，不遗留 attempt 到 idle pause 分支。[D]

shouldSchedule 宜立即同步读取，而非 await 工作完成。异步查询必须 await 后复核 identity/revision/phase/activation/work/inbox，改动面会扩大。更新事件仅请求复评，不授予调度权限；原生 requestDrive 串行化仍是唯一入口。[D]

**最后一个 fence 仍不是最终 commit 的原子门。** post-pre-step 返回后，loop.step 还会 await prepareRequest（1050），随后才 append user/message（1061）。若外部 work 在这段出现，三个判定时点不能保证“所有 work 出现时刻都零 admission”；本次 request 扩展点反例已观测到新 work 出现后仍有 1 次 admission（见 §7）；更广 prepareCall 组合仍需测试。若不引入更晚的 admission seam，保证必须限定为 reservation/pre-step 决策时点；若扩大 seam，则计入新的 loop/request 交互面。[L][D]

### 4.2 work selector 与 cutoff

- Jobs：严格 owner session + running/stopping；list(caller) 还含 unowned，不能“看见就阻塞”。terminal record 保留，不能等 remove 或要求 job_output 才放行；gate 不消费输出 cursor、不替模型收集结果。[J]
- Subagent：live registry 的 parentSession + origin=subagent，任意深度、去环；不只看直系 running，resident idle 可能等 inbox/ownedChildren；durable catalog 和独立 fork 不算 hold。官方 archive selector 虽走同 lineage，却只收 running，不等价于整个 activation 尚未收口。[S][P]
- registered descendants 消失不证明 notice 已送达。支持哪些 provider、handoff 何时完成必须另列契约；不能外推所有第三方 provider。[S]

### 4.3 醒来路径和源码竞态

1. **真实事件接口**：jobs 是 `ctx.jobs.events.subscribe` 的 registered/progress/stopping/settled/output/removed，不是假定 job/updated。subscribe 同步、contained、非 awaited，返回 disposer，filter 有 owner/all/scope。output/progress 可 coalesce，避免高输出空扫描。[J]
2. **settled 不可同步抢跑**：JobEventHub 先 unscoped 再 scope callbacks；tool-jobs reporter 属 scope。全局 gate 若立即 requestDrive，会先于 notice reserve。至少在同步 dispatch 后 deferred 复评，保留 competing/stale fence，同步 hub 的 microtask 复评已在 wakeup/quiet 场景执行；异步交付仍未泛化。[J][N][D]
3. **quiet/non-waking notice**：默认 completionDelivery=wakeup；quiet、wake budget 耗尽或 owner running 则 inject(nextStep)。idle inject 不 wake loop；原生 driver inbox listener 又只为 nextTurn 记 competing、不 requestDrive。replacement 须从原生 notice 入队请求复评，不能等消费之后才唤醒。[N][L][D]
4. **unregister 早于 notice**：finishDisposal 先 await handle.dispose，后 resident.delete/releaseSlot，再 notifySettlement/releaseOwnership/observer.settle；factory dispose 包含 detach。父 idle→queue、running→steer、closing→inject。在 agent/disposed 直接放行会提前；一次 microtask 不保证跨过异步收口。[S][L]
5. **notification-led 仍非完整证明**：不以 registry-empty 直接释放可避开直接抢跑；但 detach→notice gap 内其他 job settled、goal edit 或已安排 drive 仍可看到 descendant-empty，静态 admission guard 也看不到已 detach Activation。须延迟 disposal + 并发 trigger 负对照，再决定新增 handoff 状态或限定保证。尚不能称“任意顺序零空轮”。[S][D]
6. **没有 notice**：jobs 对 awaited/model-killed/teardown settlement 抑制通知；subagent 投递失败只 warn、父不可用/未 announced 也无正常 wake。jobs settled 本身可复评；子 agent 只依赖 notice 时必须定义丢通知 fallback、受控 reconciliation/timeout，不能 silent stranded，更不能自动 rearm。[N][S][G]
7. **订阅/teardown**：subscribe→snapshot→复核避免检查—订阅丢通知；已有 work 时新 agent/goal 也要判定。deferred callbacks、timers、branch subscriptions 归 exact lifecycle 清理，先停止复评再 await teardown，不能晚到 callback 重新开 driver。snapshot 失败要明确且可观察。[D][J]

## 5. 量化改动面而非行数

以下分开记录源码正确性面、实测原型 diff 和尚未测量的生产维护/工时成本。**改动行数不是接管协议的报价。**

### 原生 correctness surface

364 行入口具有：**7 个 driver-state 字段**（agent/attempt/competingQueued/needsCheckpoint/requested/run/stopping），**8 个 attempt 字段**（goalId/revision/round/messageId/content/phase/cancelled/stale），**10 个事件订阅**（error/disposed/created/status/goal changed/inbox inserted/claimed/discarded/session event/pre-step），pre-step 双 fence；至少 **5 类失败/停止输出**（queue-failed/prompt-rejected/round-limit/cancelled→pause/error或截断或teardown→disarm）；至少 **4 个外部正确性契约**（agent/inbox、goal projection、tool authority、session durability），另含 invariant/request-series。[D][G][T][L][I]

adaptation 中少改但仍维护全部；greenfield 则需重证或可靠抽取。

| 7 个变更面 | running-wait | pinned adaptation | greenfield |
|---|---|---|---|
| 调度/准入 | stopping waiter；原生 driver 不变；漏掉未经过 hook 的入口 | 2 个原生函数编辑面：drive reserve guard、validReservation guard（前后调用），共 3 判定时点 | reservation/准入/stale/串行全部构建 |
| work-change/notice | 释放 waiter，检查两 inbox | job subscription + notice 复评，quiet/no-notice/handoff | 相同新面，并整合自行 competing input |
| lifecycle/failure | waiter signal/dispose/goal changes；截断识别额外耦合 | 保留 teardown，新增订阅/deferred 生命周期 | 10 组责任全部重建/委托 |
| human/queue | 先释放 waiter；后序 Stop listener 被延后 | idle 自然 wake，保留 fence；选定迟到 notice 已测，epoch 等未测 | claimed 恢复/priority 全自证 |
| config/composition | native + 一种 running gate | 排除 native；adapter 唯一所有者 | 排除 native，更大实现兼容面 |
| 版本维护 | hook/loop reason/notice | 钉死 driver + goal/tool/loop/notice，少 patch 广 ownership | 同外部契约，另有自主差异 |
| 验证 | 既有另一份 30 场景研究，集成缺口仍在 | 本次 32 场景（含负对照）；barrier 仅 2 场景，完整 parity/集成仍缺 | 全 regression + 与原生差异验证 |

adaptation 比 greenfield 更有 locality；对 running-wait 则是减少 loop/Stop 新交互、增加 driver 兼容和通知所有权。要求 idle/armed/入口覆盖时可能总成本更低；接受 running/open-turn 且只需正常收尾防空转时 running-wait 仍小侵入。没有工时测量，不作绝对低价结论。

### 本次实测增量

固定原生入口共 364 行；参考文件另加两行版权/研究说明，移除说明后 SHA-256 与实际发布包一致。以参考文件为基线的 git numstat：

| 原型 | driver 文件增量 | 独立策略资源面 |
|---|---|---|
| static background candidate | +20 / -3 行 | reserve guard、validReservation 中重查（前后两次）、jobs/notice microtask 复评、fiber 生命周期检查；静态 selector 另计。 |
| pending-notice candidate | +22 / -3 行 | 并不只有多两行：另有整个 42 行 work-policy，包含静态 selector 以及 known/pending 两个 Map、4 个事件监听、初始扫描与 cleanup。 |

保留完整原生 renderer/source、reservation、串行 drive、checkpoint、admission-only 计数、cancel/pause、cap 和 fail-closed teardown。新增策略没有长期 awaiting work Promise，也不安装收尾 waiter。**Scope、announcement/epoch、lost-notice reconciliation、真正的配置页面/组成协调器都尚未实现。** 测得的局部增量支持 locality 判断，不支持“总成本只要 20 行”或“完整替代已通过”。

## 6. 多策略配置与组成

### 6.1 可供用户选择的互斥策略

策略与 work selector 分离；选择是单选，不是几个独立开关同时叠加。下表是产品建议，**不是当前已支持的配置字段或安装功能**。

| 选择 | 正常等待时父 / goal | 唯一自动 scheduler 与定位 |
|---|---|---|
| activation（默认） | idle / active + disarmed | native + 现行 gate；保持当前兼容行为及 ADR 的 owned-hold 限制。 |
| driver-replacement（实验优先） | idle / active + armed | replacement only，原独立 native 不挂载；需要完善通知、scope、失败/取消及升级维护。 |
| running-wait（高级研究） | running + open turn / active + armed | native + 收尾等待；不能叠加 activation；未发布时界面应隐藏/禁选并明确提示，不静默映射别的策略。 |
| native（原生行为/排障） | native policy | native alone；表示受控启动后的原生行为，不是无缝热切回原生。 |
| off（无自动 goal 续轮） | 没有自动 owner | intentionally zero schedulers；人工输入、goal 工具及后台回报仍可工作，不是停用整个 agent。 |

### 6.2 当前配置页面的真实条件

当前 [entry](<../../src/index.ts>)只有 TypeScript Config 与手动验证；[包声明](<../../package.json>)尚无这个策略编辑器。添加运行时 Config enum 只解决验证，不自动禁用另一个插件，也不自动产生下拉框。

- rc.2 Settings forms 只暴露 active、唯一可寻址 entry 的 Schemastery volatile 字段；ordinary config 仍是配置文件编辑。文档明确：autoGenerate 默认 true，**no shipped client does so yet**。[K]
- 当前 Plugins UI 需要 companion/browser 页面注册到 plugins.item、plugins.row.config 或 plugins.bundle.config；自定义页面拥有 draft/validation，收到 form.state 与 form.mutate(ops, expectedRevision)。因此将来需实际 select 页面和包/client 注册，不是仅导出 enum。[U]
- Plugins 页面是 **global、没有所属 Session**。初始策略应是进程/上下文级；不能让当前聊天的切换按钮悄悄影响其他工作中的会话。共享 profile 的持久修改还可能由其他进程应用；文件锁不是分布式调度 lease。[U][M]

### 6.3 建议的第一版控制边界

先采用 **启动时选择、明确人工恢复**，不做 ordinary Config remount 式的在线 owner 交换。可用一个稳定的 strategy-owner/wrapper 统一组合：原 base 的独立 native row 在所有 wrapper 模式中均关闭；wrapper 为 activation/running-wait/native 挂一个 native child，为 replacement 挂替代 child，off 不挂 scheduler。最多一个等待策略。

**这是拟议边界，不是 Cordis 已提供的全局互斥保证。** Boot 需核对重复 owner、相关 context、preset 与 higher-priority overlay 重新启用 native；不满足时拒绝启动替代组件并报告真实组成，不偷偷并存。旧 reservation 不移交。运行中其他入口重新启用独立 driver 也需要检测/失败策略；当前没有这种全局 enforcement 服务。

将来的自定义页面至少显示：

~~~text
当前生效策略 / 当前 scheduler owner
下次启动选择 / 是否待应用
影响范围：本进程全部相关会话，及共享 profile 警告
后台等待原因（work、pending notice、外部 disarm、cap/error 分开）
应用条件：受控停止/启动后，人类逐会话恢复目标
~~~

**requested 与 effective 必须真的分离。** 普通 profile patch 保存可能立即 HMR；不能写 disabled rows 后仅贴“重启生效”标签，也不能把 volatile enum 订阅变成隐式 owner 交换。需要专门 staged-storage/bootstrap 合同，当前没有实现或 GUI 实测。更小的首批交付可先提供互斥的启动组合说明/独立 bundle，待 staged 状态实现后再上选择页面；不能假称现在已可选择。

### 6.4 为什么先拒绝热切换

原生 pluginManager.setPluginEnabled 可以持久修改 disabled 并 reconcile，但不是 scheduler ownership 协议。[M] Loader disabled 分支调用 fiber.dispose **未 await**；多 row 编辑/HMR/file lock 不保证另一个 driver 等旧 owner 收口。[C]

- Native mount disarm existing goals；unload 停止 admission、disarm/stale、cancel 自己的 running attempt，await whenIdle/run；cancel 可把 goal pause。不能自动恢复 armed，也不能直接把旧 attempt 放进新 driver。[D]
- **当前 gate 卸载会 resume 它的 owned hold。** 本次负对照实测：native 仍在时只卸载 gate，仍活着的 job 不再挡住新 round。这是旧的“卸载回到官方行为”合同，不是安全 handoff；off/换 owner/停止过程必须抑制它的 rearm。[本次实验](https://github.com/LMGateX/dsh-goal-wait-gate/blob/9b05cc7e312a8b9f50cfd6d07f0df4cb77e28164/prototypes/goal-driver-strategies/observations.json)
- 后续若真做热切换，需要独立 coordinator：冻结所有受影响 admission、disarm、抑制 old gate resume、使旧 queued/claimed attempts 失效但保留其他输入、await old driver/等待钩子/Fiber disposal + quiescence、验证一个新 owner 后提交 effective 状态，并仍等待人类授权；rollback 同样 fail closed。

### 6.5 不要混淆的新策略语义

保持 armed 不放宽原生工具权限。本次 pure job-notice complete 仍报 GOAL_TOOL_AUTHORITY_REQUIRED，随后 exact 新 goal round 才成功。Goal edit 可以保存；本次 busy-work edit 没有立即唤醒重规划，而是等 work 结算后用最新 revision。若要“目标一变就立即重规划”，需单独规定例外和旧 work 处置，不能把可编辑/armed/可调度视为同义词。

Replacement 的 human resume 也不自然等于绕过后台 gate；若需“强制解除本次等待”，要显式 policy/action。maxHoldMs 不能无脑沿用 activation 的 resume：持续 work 会立即重 gate，需要 episode-level override 或 fail-closed/reconciliation。Cap-before-gate 的原生语义已保留并实测，若要等回报才 cap，另做决策。

[K]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/settings/settings
[U]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-plugin-manager
[M]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/boot/plugin-manager
[C]: https://www.npmjs.com/package/@deepseek-ai/cordis-plugin-loader

## 7. 推荐范围与剩余测试

只推进独立隔离 composition：exact rc.2 原生拷贝，保留 prompt/invariant/goal/tool/loop；改动集中 reserve guard、admission guard、deferred work-change/notice re-evaluation。先 parity 再 gate，记录实际改动面，默认与 ADR 不变。未来上游正式 scheduling defer + request-re-evaluation seam 应优先取代自维护拷贝。[D]

### 7.1 本次隔离实验：32 场景已执行

证据固定在独立研究提交：[可运行原型与说明](https://github.com/LMGateX/dsh-goal-wait-gate/tree/9b05cc7e312a8b9f50cfd6d07f0df4cb77e28164/prototypes/goal-driver-strategies)、[32 场景观察](https://github.com/LMGateX/dsh-goal-wait-gate/blob/9b05cc7e312a8b9f50cfd6d07f0df4cb77e28164/prototypes/goal-driver-strategies/observations.json)、[版本/入口 SHA-256](https://github.com/LMGateX/dsh-goal-wait-gate/blob/9b05cc7e312a8b9f50cfd6d07f0df4cb77e28164/prototypes/goal-driver-strategies/host-manifest.json)、[离线控制模型](https://github.com/LMGateX/dsh-goal-wait-gate/blob/9b05cc7e312a8b9f50cfd6d07f0df4cb77e28164/prototypes/goal-driver-strategies/strategy-model.html)。跟踪 [#9](https://github.com/LMGateX/dsh-goal-wait-gate/issues/9)。这不是之前 running-wait 的 30 场景重命名。

使用真实 rc.2 loop、goal/projection/tools、jobs controller、in-process children，native goal-round-driver invariant companion 已启用。LLM adapter 和 producer 完成受控；每场景新 Cordis context，child 场景新临时 JSONL store，未加载共享 profile 或重启 GUI。**32 场景完成并记录结果，不等于 32 个完整断言测试全通过；含故意暴露问题的负对照。** Barrier variant 只跑其中两个场景；其余不是 barrier regression。

| 场景与观测 | 已得到的有限结论 |
|---|---|
| idle + live job 对照 | native 启动 1 次调用/准入 1 round；candidate 0 调用/0 round，父 idle、goal active/armed。 |
| 普通停止、jobs wakeup/quiet、多 job、人工输入 | turn 正常 closed，later Stop listener 已执行、whenIdle 返回；部分 job 回报可先处理、不续空 goal。quiet notice 可与新 goal 在同 turn 入轮。 |
| goal edit 与 native tools | busy 时 revision 更新但 0 新轮；结算后新 prompt 用 revision 2。pure notice complete 被原生拒绝；新 exact goal round complete 成功。不是模型实际收集/验收全部结果的证明。 |
| queue/pre-step/flush 中新 work | queue 后或 downstream pre-step 内新 job 使 reservation stale：0 admission、goal 仍 active/armed、没有误 pause/block；工作完成后重试。flush 中新 work 也不 reserve。 |
| cap、截断/error、flush failure、downstream reject、cancel | 保留 native cap-before-gate、max-tokens/error/flush disarm、prompt-rejected blocker 与 active-goal cancellation→pause。 |
| 真正的 continuable、one-shot、child 请求父决定 | 父 idle，回报/relay 正常 wake/处理；正常 settlement notice 先于后续 goal。不是任意深度/所有 provider 验收。 |
| 延迟真实 child notice + 另一个 job 结算 | static candidate 在 child 回报前已准入 1 round；barrier case 在回报前维持 active/armed、0 round，回报送达后才续。延迟注入点是 parent.followup 接收真实 native message，不是 exact 内部 handle.dispose await。 |
| 最后 pre-step 后 request-preparation 中新 work | 仍准入 1 round，work 保持 live；三处判定不是 commit 的全时点原子保证。 |
| 两 driver、当前 gate 卸载 | 双 owner 导致拒绝/blocked、0 admission；旧 gate 单独 unload 导致 resume 和 live-work 中 1 round。 |
| idle handoff、disarm/complete/unload | handoff 后 active/disarmed；实际 human-input get_goal/update_goal resume 才恢复。外部 disarm/terminal 不 auto-rearm；idle unload 有界返回、live job 本身未因 driver unload 而取消。 |
| 暂停送达 barrier notice | 仅编辑目标不能消除 pending；直到真实回报插入前都保持 idle/armed、0 round。证明需要 lost-notice policy，不是证明不会卡住。 |

### 7.2 实验未解决的边界

1. **Barrier 可能制造 phantom pending。** 源码审计发现 unannounced continuable child 建立/cold-resume 准入失败也 dispose，却不承诺通知；notifySettlement 对 !announced return。当前 heuristic 仅凭 descriptor mode 即计“欠通知”不够。此失败路径尚未执行，必须在生产前修正/验证。[S]
2. **没有 activation epoch。** senderSessionId Set 不能区分同一 child 的旧 notice/新 activation；cold resume、晚到 notice、fork 不在本次验收内。raw findLast descriptor 也不等于原生 first-own/version-validated fold。[S]
3. **Scope 未证明。** owners:all + global registry 在本次 root context 可运行，未来 preset/agent-scoped 安装可能驱动别的 owner。多 root/context/preset、unowned/other-owner jobs、nested/resident descendant 与未知 provider 仍需矩阵；不能承诺通用支持。
4. **最终 admission、交付/收集与异常政策。** request-preparation window 已反证全时点 gate；notice 丢失/无承诺/第三方 asynchronous delivery 仍需 reconciliation。模型真正读取 job_output/child transcript、完成质量和阻塞阈值等未验证。
5. **清理与宿主集成。** 每个场景 finally 的 handle/context dispose 有界返回；未做 post-cleanup registry/subscription/pending 清零断言。临时 scratch stores 保留用于调查。没有真实 GUI、headless、ACP、网络模型、压力/性能或完整原生 parity 证据。idle 有利于 GUI/维护，却不会替 headless caller 自动实现“保持父 handle 存活直到后台/goal 收口”的合同。

### 7.3 剩余验收矩阵（每组仍有未覆盖组合）

| 测试组 | 最少场景/观察量 |
|---|---|
| parity | create/resume/edit/terminal、request series、完整 prompt/source、admission-only counter、blocked threshold。 |
| gate 入口 | idle 已有 work 的 create/resume/edit；普通停止/pre-step reject/异常跳过 stopping；held 0 新 admission、armed、父真 idle。 |
| reservation races | work 在 reserve前后/claim后/downstream await中、post-fence→prepareRequest→commit窗口出现；revision/disarm；stale 不计数、不误 pause/block、不丢其他消息。 |
| human priority | flush前后/queued/claimed时 nextTurn人类；steer/inject混批；人工wake不阻塞；不承诺尚未到达输入的绝对优先。 |
| jobs delivery | wakeup/quiet/budget；awaited/model-killed/teardown；unowned/其他owner；订阅排序、settled先于notice负对照。 |
| child handoff | continuable/one-shot、多层、resident idle、owned grandchildren；延迟 dispose→notice + job settled/goal edit；丢notice/异常fallback。 |
| flush | 延迟/失败、连续goal变化/input；checkpoint不被gate跳过；错误 disarm、0 后续admission。 |
| cancel/error | queued/claimed/admitted 的 user/parent/disposed、keepInbox；downstream throw/reject、max-tokens；wait不误pause。 |
| cap | cap=1且末轮work活着；round-limit顺序；增加cap后人工授权。 |
| unload/restart | held/queued/claimed/flush中 unload，无callback/订阅泄漏/no rearm，fence收口；同id新Agent不继承；resume/fork回放disarmed。 |
| config/组成 | native+copy 双加载阻止；不迁移reservation；scope/preset隔离；缺jobs/provider策略。 |
| 成本/集成 | 三策略 admitted数/空调用数/input处理路径/open turn/whenIdle/ACP/headless/GUI；长期并发、timeout episode、升级差异。 |

**门槛：** 原生 parity、无丢输入、无误权限、checkpoint/teardown 和通知 handoff 有证据后，才讨论可选实验策略。任何绿色 demo 不足以证明简单 followup 可替代。故意改变的 cap/timeout 等行为须与“原生不变”结果分开列出。

[D]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver
[I]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal-round-driver
[G]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/goal
[T]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/goal/tool-goal
[L]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop
[A]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent
[J]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/jobs-local
[N]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/jobs/tool-jobs
[S]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent
[P]: https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-in-process-driver
