---
status: accepted
---

# 以标准 bundle 层交付，不再要求用户手写 patch 行

## 决策

`package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，随包发布该 patch 文件；同时发布 `locale/en.json`、`locale/zh.json`，并用 `exports["./locale/*.json"]` 暴露它们。插件从此以**标准 profile bundle** 的身份安装：`dsh plugin --profile web add <spec>` 记录依赖并把它加入 `dsh.profile.bundles`，侧边栏「插件」页随之显示卡片、行、版本与启停开关。行 id 与模块名保持不变（`goal-wait-gate` / `dsh-goal-wait-gate`），既有的 profile 覆盖继续生效。

## 为什么

DSH 的「插件」页只为 bundle 生成卡片：`packages = listBundles().map(...)`（`dsh-client-ui-plugin-manager`），而每个 bundle 的行只挂在自己的卡片里，不属于任何 bundle 的 Loader 行在该页面没有任何入口。`listBundles()` 对非 bundle 依赖只在它被选入 `dsh.profile.bundles` 时才列出，并以 `not-bundle` 错误呈现。此前的交付方式是「普通依赖 + 用户手写 `insert` 行」：插件在工作，但插件页完全看不到它，也没有启停入口；`dsh plugin add` 还会警告 `declares no dsh.bundle`。这不是上游缺陷可等待的范围，而是本包应采用的交付形态。

## 取舍

- **没有配置表单。** DSH 的行配置界面由插件自己的 web 客户端注册到 `plugins.row.config` 槽位；本包没有客户端半边。策略仍由 profile patch 层覆盖，且该层在 bundle 层之后应用。
- **不支持的宿主变得可见。** 成为 bundle 后，driver 指纹未 pin 的宿主会让该行以「启动失败」出现；这是可见的失败，优于静默缺席。挂载前的身份拒绝逻辑（ADR 0002）不变。
- **迁移必须删旧块。** 若 profile patch 里仍有手写 insert，同 id 会挂载两次；README 明示删除标记块。
- **卡片文案依赖 exports。** DSH 通过包解析读取 `<name>/locale/<id>.json`；缺少该 subpath 时静默退化为技术包名。本仓库的隔离检查因此把 `exports` 也纳入断言。
- **`./startup` 不进 bundle 层。** 启动策略仍是 ADR 0002 的 opt-in 直接 root 契约，与 profile/Loader 组成无关。

## 边界

bundle 层只声明挂载一行：它不改变任何 gate 语义、不引入运行时依赖、不改动 legacy root 行为，也不构成对本机安装或发布的授权。上游「插件页不显示不属于任何 bundle 的 Loader 行」只作为观察记录，不作为本决策的前提。

## 验证

`node scripts/check-bundle-layer.mjs` 在 `.bundle-check/` 的一次性 DSH home 中把本仓库当作已安装 bundle：断言该行只组成一次、官方 `goal-round-driver` 仍在、profile 层覆盖仍然生效，并用宿主自己的 `readProfilePlugins`、`readPluginMeta` 与兼容性预检读回 bundle/enabled/中英文卡片文案。契约测试见 `test/bundle-manifest.test.ts`。