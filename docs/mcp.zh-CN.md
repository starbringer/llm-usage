# MCP 服务器

[English](mcp.md) | **简体中文**

仪表盘回答的是你想得到要问的问题。MCP 服务器让 AI 助手替你去问：它把同一份数据 ——
token、成本、会话，以及整个 harness 配置 —— 暴露为可调用的工具。消费它的正是两个内置
技能 —— 见 **[skills.zh-CN.md](skills.zh-CN.md)**。

这些都随应用一起启动。没有第二个进程要开，也不需要 Docker。

---

## 安装

```bash
bun run start
```

这就是全部安装步骤。启动时应用会：

1. 在与仪表盘相同的端口上提供 MCP 端点 **`http://127.0.0.1:5757/mcp`**
   （streamable HTTP 传输）；
2. 把 `ai-usage-review` 与 `ai-change-impact` 技能安装到检测到的每个 AI 工具的
   用户级技能目录（Claude Code 为 `~/.claude/skills/`）；
3. 通过各工具自己的 CLI 注册该端点 ——
   `claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp`。

每一步都是幂等的：首次运行打印一行日志，之后保持安静。重启一次你的 AI 工具让它加载新
服务器，然后让它复盘你的用量，或直接运行 `/ai-usage-review`。

### 验证

```bash
curl http://127.0.0.1:5757/api/mcp-server     # 人类可读：工具清单、协议版本
```

在 Claude Code 中，`/mcp` 会把 `ai-insights` 列入已连接的服务器。

### 如果自动注册被跳过

应用会打印需要执行的确切命令。当工具的 CLI 不在 `PATH` 上时，它会选择打印而不是注册。
Claude Code：

```bash
claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp
```

### 关闭自动装配

| 参数 | 效果 |
|---|---|
| `--no-provision` | 不安装技能、不注册 MCP 服务器。`/mcp` 端点仍然提供服务。 |

MCP 端点本身属于 HTTP 服务器，不可单独关闭；它是只读的，并遵循与其余 API 相同的回环
绑定策略。

### 更换端口

装配以 URL 为键。换端口启动后，下次运行会自动把服务器重新注册到新地址：

```bash
bun run start --port=8080     # 重新注册到 http://127.0.0.1:8080/mcp
```

即便传入 `--host=0.0.0.0`，注册的 URL 也始终使用 `127.0.0.1` —— 客户端总在同一台机器
上，而局域网地址绝不该出现在配置文件里。

---

## 连接其他客户端

### Claude Code（及任何支持 streamable HTTP 的客户端）

```bash
claude mcp add --scope user --transport http ai-insights http://127.0.0.1:5757/mcp
```

自动装配已经替你做了；这里列出命令是为了手动配置。

### 只支持 stdio 的客户端

有些客户端只能以子进程方式启动 MCP 服务器。为它们提供了 stdio 入口：

```bash
bun run mcp        # = bun run mcp-stdio.ts
```

将其配置为 stdio 服务器，命令为 `bun`，参数为
`["run", "/绝对路径/ai-insights/mcp-stdio.ts"]`。

它完全独立 —— 打开同一个 SQLite 缓存，并在启动时从转录记录刷新，因此无论仪表盘是否在
运行都能工作。传入 `--no-scan` 可跳过刷新、直接读取现有缓存（启动更快，但可能过期）。
两个进程通过 SQLite 的 WAL 模式共存。

`bun run build:mcp` 会把它编译为独立二进制 `dist/ai-insights-mcp`，供更愿意直接启动可
执行文件的客户端使用。

---

## 工具

每个工具都接受一个可选的 **`provider`** 参数来指定数据源。默认为 `claude-code`；传
`all` 可跨所有已注册数据源汇总。未知 id 会返回一条列出合法取值的错误。答案不随数据源
变化的应用级工具（`list_providers`、`get_pricing`、`get_thresholds`、
`get_data_retention`）不带该参数。

所有带范围的工具都接受 **`range`**：`1h`、`24h` 或 N 天（`7d`、`30d` 等）。它默认取
[数据保留窗口](storage.zh-CN.md#数据保留)，并被其截断 —— 应用会删除更早的记录（默认
保留 30 天），因此任何工具都无法看得更远。`get_usage_summary` 会以 `retentionDays` 返回
该窗口，`get_data_retention` 则单独返回它。

### 用量

| 工具 | 返回 |
|---|---|
| `list_providers` | 已注册数据源及实时 `hasData` 标志 |
| `get_usage_summary` | `retentionDays`、今日 / 7 天（窗口 ≤ 7 天时为 `null`）/ 整个窗口的总量与成本、缓存命中率、活跃运行数 |
| `get_usage_timeseries` | 某时间范围内的 token 趋势，分桶粒度自适应 |
| `get_daily_usage` | 逐日总量，默认取保留窗口并以其为上限 |
| `get_model_usage` | 按模型的总量 |
| `get_project_usage` | 按项目目录的总量、运行数与智能体数 |
| `list_runs` | 分页会话列表（`limit`、`offset`、`project`、`search`），每行带有 `run_key` |
| `get_run` | 单次运行及其全部智能体 |
| `get_run_usage` | 单次运行按分类桶与模型的成本拆解，含套餐权重与上下文占用，**外加已渲染成文字的调优建议** |
| `get_top_runs` | 按 token 排序的会话 |
| `get_top_turns` | 开销最大的单次 API 调用 |
| `get_mcp_usage` | 每个 MCP 服务器活跃期间记录到的 token 与成本，含按工具的载荷拆分 |
| `get_skill_usage` | 每个技能运行期间记录到的 token 与成本，以及它的调用次数 |
| `list_agents` | 智能体及其模型、回合数与 token 总量 |

### 改进效果

| 工具 | 返回 |
|---|---|
| `compare_runs` | 两次会话并排对比：成本差额、三因子归因、各自调用过的技能 / MCP 服务器 / 工具、两者之间的 harness 差异，以及注意事项 |
| `compare_periods` | 两个时间窗并排对比：总量、按模型与按分类桶拆解、归一化速率（每次运行、每次 API 调用的成本，每次调用的 token）、同样的归因、harness 差异、注意事项 |
| `get_harness_changes` | harness 配置何时发生变化、变了什么，并给出 token 增减 |

运行通过 `run_key` 寻址 —— 这是一个由 `(provider, 原生 run id)` **推导**而非分配得到的
短 ID（`r-9f3a1c2b7e04`），因此缓存重建后依然有效，且对所有数据源形态一致。任意四位
及以上的唯一前缀均可解析，原生 run id 也可以。`get_run` 与 `get_run_usage` 同样接受它。

两个对比工具都把成本差额拆成三项**精确相加**的因子 —— `volume`（发起的 API 调用次数）、
`tokens-per-turn`（每次调用携带的上下文）与 `price-per-token`（模型与缓存的组合）。
其中没有任何建模成分，因此任一项都可作为真实数字引用。第三项背后的模型占比与缓存命中率
放在 `priceEvidence` 中；不再进一步拆分，因为模型选择与缓存行为相互纠缠。

时间窗为左闭右开 `[from, until)`，因此相邻时间段可以无缝衔接而不会重复计数。每个边界
接受 ISO 时间戳、日期（`2026-07-15`，覆盖当地一整天）或表示「之前」的相对偏移
（`7d`、`24h`）。结束时间早于保留截止点的窗口会**报错，而不是返回空结果** —— 那部分
数据已被删除，返回 0 会被读成「你那时候没花钱」。

### Harness 配置

| 工具 | 返回 |
|---|---|
| `get_harness_capabilities` | 当前 provider 的适配器支持哪些配置能力 |
| `list_instruction_files` | 指令文件及其 token 数与保留窗口内的注入序列 |
| `read_instruction_file` | 某个已枚举指令文件的完整内容 |
| `list_commands` | 所有来源的斜杠命令，带覆盖标记 |
| `list_skills` | 技能及其触发词、token 成本与保留窗口内的**实际**使用记录（`calls` / `estTokens`） |
| `list_hooks` | 跨配置层的 hook 条目及保留窗口内的**实际**触发次数（`fires`、`windowDays`） |
| `read_hook_script` | 某个 hook 脚本文件的源码 |
| `get_permissions` | 合并后的 allow / deny / ask 规则，并标出被遮蔽的规则 |
| `list_mcp_servers` | 已配置的 MCP 服务器、探测状态、工具、schema token 成本 |
| `list_memory_stores` | 按项目的记忆库，含孤儿文件检测 |
| `get_effective_config` | 合并后的设置层、覆盖关系、以及“该层不会被读取”的告警 |
| `get_dependency_graph` | 技能、hook、MCP 服务器与命令之间的相互引用 |
| `list_config_projects` | 从转录记录中发现的项目目录 |

### 应用设置

| 工具 | 返回 |
|---|---|
| `get_pricing` | 驱动全部成本数字的分模型参考价格表 |
| `get_thresholds` | 已配置的告警/错误阈值 |
| `get_data_retention` | 本机保留多少天的记录 —— 所有时间范围与实际计数的硬上限 |

### 载荷克制

可能返回整份文件的工具默认只返回元数据：

| 工具 | 开关 | 默认 |
|---|---|---|
| `list_skills`、`list_commands` | `includeContent` | `false` —— 省略正文 |
| `list_mcp_servers` | `includeSchemas` | `false` —— 省略 JSON schema |
| `get_run_usage` | `includeSeries` | `false` —— 逐次调用序列替换为其长度 |
| `get_run_usage` | `includeComponents` | `false` —— 省略调用过的技能 / MCP 服务器 / 工具 |
| `compare_runs` | `includeComponents` | `true` —— 设为 `false` 可得到精简结果 |

文件内容在 20,000 字符处截断并显式标注。一个用来诊断上下文膨胀的工具，不该自己制造膨胀。

---

## 刻意**未**暴露的部分

MCP 面是**只读**的。以下 HTTP 路由没有对应工具：

| 未暴露 | 原因 |
|---|---|
| `PUT /api/config/instructions/file` | 让一次分析悄悄改写 CLAUDE.md 是自伤 |
| `PUT/POST/DELETE /api/config/commands` | 同理 —— 命令是用户撰写的配置 |
| `PUT /api/config/skills/file` | 同理，且能改技能的技能可以改自己 |
| `PUT/DELETE /api/config/hooks*` | hook 会执行 shell 命令，写入必须有人参与 |
| `PUT /api/settings/thresholds` | 允许修改阈值等于让复盘自己挪动评判标准 |
| `GET /api/agent/:id`、`GET /api/agent/:id/tree` | 完整转录与面向 UI 渲染的会话树，每个动辄数万 token。同一会话的成本请用 `get_run_usage` |

建议以文本返回，由用户自己的助手用其常规、受权限管控的编辑工具落地 —— 在那里它们会以
diff 呈现，也可以被拒绝。这正是重点：复盘负责建议，人负责拍板。

---

## 安全

- 与其余 API 一样绑定回环地址。
- 每个 MCP 请求都做 **Origin 校验**：携带非回环 `Origin` 头的请求以 403 拒绝，从而阻断
  来自网页的 DNS 重绑定攻击。原生客户端不发 `Origin`，可正常通过。
- `GET /mcp` 与 `DELETE /mcp` 返回 `405` —— 服务器不提供主动推送的 SSE 流，也不持有会话。
- 不受支持的 `MCP-Protocol-Version` 头以 400 拒绝。

服务器无状态：不签发 `Mcp-Session-Id`，每个 POST 独立成立，每条 JSON-RPC 请求以单个
`application/json` 响应体作答。协议版本 `2025-06-18`（默认）、`2025-03-26` 与
`2024-11-05` 在 `initialize` 阶段协商。

---

## 内置技能

有两个技能消费这个服务器：**`ai-usage-review`** 找出花钱的地方，
**`ai-change-impact`** 验证修复是否奏效。两者都在启动时安装，且都不写入。
如何调用、示例，以及「复盘 → 落地 → 验证」闭环：**[skills.zh-CN.md](skills.zh-CN.md)**。
