---
status: accepted
---

# 增加独立、opt-in、版本固定的启动 owner，不改变 legacy 默认

## 决策

沿用 [ADR 0001](<0001-retain-activation-gate.md>) 的 legacy root 导出和 activation 默认。另增 dsh-goal-wait-gate/startup TypeScript entry：仅在满足直接 root、固定共享 service topology、空 agent registry 的新启动组合中，显式选择 activation / replacement / native / off。

用户批准了先实现互斥启动组成和 version-pinned native adaptation、后做配置页面的路线。running-wait 继续研究，不进入此实现；不提供在线策略切换、真实 profile 安装或发布授权。

## 取舍

原轻量桥接继续负责 owned disarm/resume；replacement 自己承担 scheduler 兼容责任，使用公开 local residency epoch、实际 runtime ownership、严格 owner Jobs 和同步 settlement dispatch fence。两者不是同一承诺，不能静默替换默认。

Native-derived driver 以已发布的 DSH 0.2.0-rc.2 为基线，而不是 master；保留 prompt/source/reservation、串行驱动、持久化、admission 计数、cap、输入恢复及 goal tool authority。只在原 housekeeping/cap 之后、reservation 之前以及两次 pre-step 校验加入 policy；停止逻辑另增加同步撤销、幂等 drain 与 surfaced error 保留。

每个 root 生命周期只可领取一个 owner。公开 registry/known callback/label guard 会拒绝已知竞争者，不卸载他人 owner；root tombstone、更新 veto 和清理 Promise 保留，避免 registry 消失被误当成可热切换。它不是安全、分布式或任意第三方 scheduler 的全局租约。

## 必须保留的边界

- 仅直接 root API bootstrap；ordinary Loader/profile/bundle row 不满足父 Fiber 限制。尚未提供宿主 launcher adapter 或 GUI。
- 版本检查证明插件位置可解析的 published artifacts；不证明活跃 service 来自同一 module copy。Topology 必须固定；首次 snapshot 不等于持续隔离监测。
- Continuable local end 在 disposal 和原生 notice attempt 之后；one-shot end 仅代表 result。标准 tool-subagent one-shot 必须有 disposal-backed Job，且该 Job 不受通用 waitForJobs=false 放行。
- 无 disposal-backed Job 的直接 holder-owned one-shot、不可见 prepublication、任意异步自定义 notice 和非 Jobs holder 收尾不在交接保证内。
- 最后 pre-step 检查之后的 request/config/prepareCall 仍有窗口；已有 passing counterexample 会 admission 一轮。不能宣称每个瞬间都零 admission。
- native 选择原模块；Cordis 吞掉的内部清理失败不可证明，完成状态是 closed-unverified。Managed-stop 只覆盖自身显式 stop/disarm/drain boundary，不覆盖任意插件隐藏 disposer。

## 交付状态

实现、isolated native assertions 和 legacy compatibility 检查与 dependency reproducibility 分开报告。开发依赖锁图已生成，但干净 frozen-lock 安装和 native dependency-build policy 尚未验收；在独立验证通过前，不把此分支称为可发布包，不部署或切换本机。

详见 [startup 支持契约](<../startup-driver.md>)。
