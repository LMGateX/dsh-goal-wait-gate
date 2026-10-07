---
status: accepted
---

# 一行独占续行位：四种策略由配置页选择，三条回退路径都不改 profile

## 背景

ADR 0002 把 activation / replacement / native / off 放进了 `dsh-goal-wait-gate/startup` 这个 boot-only 导出：它必须挂在 fresh、unscoped 的 Cordis root 上，不是 Loader 行，也没有 GUI 集成，因此用户无法在插件页面选择实现方式，也无法一键回到官方行为。

DSH 的 Plugins 页面只为"带配置的行"渲染通用表单（`dsh-client-ui-plugin-manager` 注入 `configForms`，行的 `Config` 导出必须是原生 schemastery 节点才被 `generateConfigSchema`/schema collection 接受）。官方 `goal-round-driver` 行本身只是一个普通的、纯事件驱动的 cordis plugin，可以被禁用以外的行挂载为子 fiber。

## 决策

1. **一行独占**：bundle 层（`cordis.patch.yml`）在插入本插件行的同一层里禁用宿主自带的 `goal-round-driver` 行：
   ```yaml
   - insert:
       - id: goal-wait-gate
         name: dsh-goal-wait-gate
   - id: goal-round-driver
     disabled: true
   ```
   两行同生共死：卸载插件即恢复官方行，组合层零残留。
2. **插件自己挂载 driver**，四种策略都是本行的子 fiber（无 root-parent 要求、无 lifetime tombstone）：`activation`（默认）= 官方原生 driver＋既有 disarm/resume 闸门；`replacement` = 按宿主发布指纹校验的 TS 移植 driver＋后台资格等待；`native` = 官方原生 driver、完全不干预；`off` = 不挂载 driver。
3. **配置即选择**：行的 `Config` 是 schemastery schema（`strategy` 为四值 union，默认 `activation`，每个字段与每个分支都带中文/英文 description）。保存后 cordis 重挂该行，driver 随配置热切换；不使用 volatile 字段，因此不存在"改了不生效"的中间态。
4. **三条回退路径**（都不写任何 profile 文件）：配置页选 `native`；卸载插件（bundle 层与禁用行一并消失）；关闭插件行（不挂载 driver，因此不再自动续行）。卸载/关闭时沿用既有契约：闸门 re-arm 自己持有的 hold。
5. **绝不双驱动**：挂载前扫描 realm，若发现非本行子 fiber 的 `goal-round-driver`，只记录一条错误并保持惰性（不挂 driver、不装闸门），让官方行为继续负责。`replacement` 的宿主指纹不匹配时，退回 activation 形态（官方 driver＋闸门）并记录一条错误，绝不留下无人驱动的 goal。

## 后果

- 用户终于可以在插件页面选择实现方式，并且"关掉插件"的语义变得明确：关掉即不自动续行，而不是悄悄回到官方驱动。
- 插件与宿主 driver 的耦合方向反转：以前是"桥接、绝不碰 driver 行"，现在是"本插件就是 driver 的挂载者"。因此 `goal-round-driver` 的 peer 依赖从"可选"变成运行必需（`native`/`activation`/`replacement` 都导入它，只有 `off` 不需要）。
- 宿主升级仍需重新核对：`replacement` 依赖发布指纹 pin（不变）；`activation`/`native` 导入的是宿主自己发布的模块，所以不引入额外的版本 pin。
- ADR 0002 标记为 superseded，保留为历史；`/startup` 导出继续为特殊宿主保留同一套策略语义。
