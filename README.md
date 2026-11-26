# dsh-spec-gate

规格驱动任务的硬闸门。给 DSH 加一个「规格闸门」标签页：任务必须在用户点按钮确认之后，才能进入下一阶段；写完代码还要再确认，才允许验收。

![示意图：浏览器顶部多出「规格闸门」标签](docs/tab.png)

## 它挡什么

- agent 在 SPEC/PLAN 阶段写代码 → 拒绝，并给出「当前阶段未确认」的原文。
- agent 想自己把阶段标成已确认 → 没有这样的工具，只有「请求确认」；确认只能在标签页里点。
- 越级写产物（PLAN 阶段写 VERIFY.md）→ 拒绝。

它**不挡**什么，见文末「已知缺口」。别把它当成沙箱。

## 安装

```powershell
# 1. 插件源码放到任意目录，然后链接进 profile
#    C:\Users\jisi\.dsh\profiles\desktop\package.json
#    dependencies 加：  "@local/dsh-spec-gate": "link:D:/path/to/spec-gate-plugin"
#    dsh.profile.bundles 加一条 "@local/dsh-spec-gate"

# 2. cordis.patch.yml 追加
#    - id: spec-gate
#      name: "@local/dsh-spec-gate"

# 3. 装依赖（软链）
pnpm install --offline

# 4. 重启 DSH
```

装好后 `plugin_manager list_plugins` 里应能看到 `include:spec-gate`，`fiberPhase: active`。

## 用起来

1. 你对 agent 说「**开工GO**」并说明要做什么。
2. agent 调 `spec_start` 建任务，顶部出现「规格闸门」标签。
3. agent 写 SPEC.md 后，标签页出现确认卡片 → **你点「确认」** → 进入 PLAN。
4. 一直走到 EXECUTE 阶段确认，agent 才被允许改代码。
5. 随时可点「取消」。

不启用时插件完全静默，不影响任何普通任务。

## 工具（给 agent 的）

| 工具 | 作用 |
| --- | --- |
| `spec_start` | 建任务，进 SPEC 阶段 |
| `spec_write` | 写当前阶段的产物（只能写当前那一个文件） |
| `spec_ask_confirm` | 把当前阶段抛给用户确认（只置等待，不能确认） |
| `spec_state` | 读阶段、确认记录、被拒记录、事件 |
| `spec_abort` | 取消任务 |

五个阶段：SPEC → PLAN → EXECUTE → VERIFY → ACCEPT。

## 文件在哪

| 内容 | 位置 |
| --- | --- |
| 任务状态（唯一真相） | `C:\Users\jisi\.dsh\spec-gate\tasks.json` |
| 审计流水 | `~/.dsh/spec-gate/history.jsonl` |
| POST 诊断 | `~/.dsh/spec-gate/debug.jsonl` |
| 激活日志 | `~/.dsh/spec-gate/boot.log` |
| 任务产物镜像 | `<工作区>/.specs/<slug>/` |

## 已知缺口

1. **确认通道认 UA。** 桌面 webview 的 POST 不带 `sec-fetch-site`/`origin`/`referer`（实测全是 null），所以只能按 UA 认客户端。默认 PowerShell/curl 会被 403，但改 UA 就能过。挡顺手，不挡铁了心。
2. **`pwsh` 按命令文本猜。** 拦得住 `Set-Content`、`Remove-Item`、`> 文件`、`sed -i`；拦不住 `[IO.File]::WriteAllText`、`python -c` 之类。要真挡就得全禁 shell。
3. **只管工具层。** 拦 agent 调 `write`/`edit`/`pwsh`，管不了其他插件和宿主进程。
4. **`.specs/**` 永远放行**，否则第一阶段就没法开始。

## 卸载

从 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`）和 `cordis.patch.yml` 里删掉对应条目，`pnpm install --offline`，重启。

任务数据不会被删，需要的话手动清 `~/.dsh/spec-gate/`。
