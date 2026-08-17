# 界面逐屏说明

[English](ui.md) | **简体中文**

仪表盘的每一个界面，以及各自提供的控件。数字的含义见
[data-model.zh-CN.md](data-model.zh-CN.md)；MCP 服务器与内置技能见
[mcp.zh-CN.md](mcp.zh-CN.md) 与 [skills.zh-CN.md](skills.zh-CN.md)。

*下方截图取自真实使用记录，其中所有项目名、路径、会话内容和配置名称都被替换成了一致的
替身数据 —— 详见 [screenshots/](screenshots/)。*

## Dashboard（仪表盘）

- **KPI 卡片** —— 今日 / 7 天 / 保留窗口总量，含 API 等价成本、缓存命中率、活跃运行数
- **token 趋势图** —— 按输入、输出、缓存写入、缓存读取拆分
- **再往下** —— 按模型的用量、Top 项目、**MCP token 用量**（按服务器，带按工具的 tooltip）、**skill token 用量**、带 50% 参考线的**缓存命中率**、**模型占比**、**Top 10 运行**（点击柱状条直接跳进该运行）

![Dashboard charts](screenshots/02-dashboard-charts.png)

所有排名类柱状图都从大到小、由上往下排列；运行详情的环形图也从最大的一块开始。

每个图表都有独立的时间范围切换（`1h` / `24h` / `7d` / `30d`），并记住你的选择。梯度跟随
[保留窗口](storage.zh-CN.md#数据保留) —— 14 天窗口给出 `1h` / `24h` / `7d` / `14d`。
成本是基于可编辑价格表算出的 API 等价参考值，不是账单；
[详见此处](data-model.zh-CN.md#成本估算)。

## Runs（运行列表）

列出每一次记录到的会话：标题、项目、智能体数量（派生了子智能体时显示 `× N`）、回合数、
token 总量、最后活跃时间。支持搜索，也可按项目过滤。

每一行还带有该运行的 **ID** —— 点击即可复制。把它交给 `ai-change-impact` 技能就能对比
两次会话 —— 见 [skills.zh-CN.md](skills.zh-CN.md)。

![Runs](screenshots/03-runs.png)

## 运行详情 —— 会话树

在任意运行上点 **View**，用三栏视图回放整个会话：左侧智能体列表，中间是树，右侧是节点
完整详情。

![Run detail — session tree](screenshots/04-run-detail-tree.png)

每个智能体各有一棵树，堆叠在同一个可滚动视图中。主干是按时间顺序的流程 —— 提示词、
LLM 调用、hook 触发、上下文压缩、错误 —— 每次 LLM 调用可展开为它的思考过程、文本输出，
以及按顺序排列的每一次工具调用：

| | 节点 | | 节点 |
|---|---|---|---|
| ⚙ | 普通工具 | ⚡ | hook，含命令与耗时 |
| ⇄ | MCP 调用 | ✕ | API 错误 / 限流重试 |
| ◈ | 子智能体派生，附 `tree ↓` 跳转链接 | ▣ | 上下文压缩，含压缩前后 token 数 |
| ❖ | skill 调用，注入的正文嵌套在下方 | ⤷ | 模型拒绝回退 |
| ⎇ | 废弃分支（提示词编辑、重试），已折叠 | ✚ | 注入的上下文 |

顶栏汇总整场会话：提示词、LLM 调用、工具、MCP、子智能体、hook、错误、压缩、分支。
窄屏时两侧面板会收进顶栏的切换按钮。

## 运行详情 —— 用量

中间栏的第二个标签页是该次运行的成本拆解，使用与仪表盘相同的去重数据。

![Run detail — usage](screenshots/05-run-detail-usage.png)

- KPI 卡片、累计花费曲线、按模型的表格
- **按分类的成本环形图** —— 基础 / MCP / skill / 子智能体，每次 API 调用在解析时就依据其工具调用完成分类
- **调优建议**，基于本次运行的真实数字 —— *"改用更便宜的模型重新计价可省 $X（Y%）"*、缓存命中率偏低告警、子智能体占比过高提示

## Harness（配置面）

**Harness** 分组用于查看 —— 在安全的前提下也可编辑 —— 当前工具的配置。每个标签页只在
当前 provider 支持该能力时出现，因此未来接入其他工具的适配器只会少显示几个标签页。
多数标签页共用同一种布局：左侧列表列、右侧详情列，各自独立滚动。

### CLAUDE.md

列出该工具注入的每一个指令文件：全局的 `~/.claude/CLAUDE.md`，以及你的转录记录涉及过
的每个项目的 `CLAUDE.md` / `.claude/CLAUDE.md`（缺失的标为可创建）。提供每个文件的
token 与词数统计、带 **Save** 的内嵌编辑器，以及按天的注入 token 时间线。

![CLAUDE.md](screenshots/06-claudemd.png)

### Commands（命令）

汇总三个来源的斜杠命令 —— 用户、项目、已启用插件 —— 支持 `:` 命名空间、参数提示、
`$ARGUMENTS` 检测、token 成本、搜索，以及**同名覆盖检测**，让你看清最终生效的是哪个
定义。用户/项目命令可编辑、创建和删除；插件命令为只读。

![Commands](screenshots/07-commands.png)

### Skills（技能）

覆盖检测、SKILL.md 的 token 成本、`references/` 与 `scripts/` 清单、保留窗口内**实际
记录**的调用次数与注入 token，以及展示哪些提示词关键词会触发该 skill 的**触发分析器**。

最后是**关联组件**：与该 skill 相连的 hook、MCP 服务器和命令，以图 + 列表两种形式呈现
—— 按组件类型分列，箭头由「引用方」指向「被引用方」，实线表示内容中确有引用，虚线表示
较弱的名称相似信号。若该 skill 与任何组件都无关联，会明确说明。

![Skills](screenshots/08-skills.png)

### Hooks

列出所有配置层中的每个 hook，含 matcher、动作类型，以及保留窗口内的**实际触发次数**
—— 来自事件流记录，不是估算。

![Hooks](screenshots/09-hooks.png)

对于运行脚本文件（`.ps1`、`.sh`、`.py` 等）的动作，会在磁盘上解析出对应文件：点击即可
阅读、编辑并保存。删除 hook 只移除设置文件中的条目，脚本文件本身保留在磁盘上。

![Hook script editor](screenshots/10-hooks-script.png)

### MCP

左侧是服务器列表，含作用域、传输方式和工具数量；右侧是启动命令、来源文件、探测状态、
按窗口计算的注入量估算，以及可展开的工具列表（含描述与 JSON schema）。诊断信息在默认
面板中，重新探测按钮可绕过 10 分钟缓存。

![MCP](screenshots/11-mcp.png)

服务器从配置文件而非 CLI 枚举；你尚未批准的项目级服务器会被列出，但绝不会被执行 ——
[原因](architecture.zh-CN.md#mcp-为什么读配置文件而不用-cli)。每个服务器同样带有与
skill 一致的**关联组件**区域 —— 不含任何 skill 的集群（hook 或命令直连服务器）就显示在这里。

### Permissions（权限）

把 `allow` / `deny` / `ask` 规则解析为工具 + 限定符，覆盖用户层，并可通过项目选择器加入
某个项目的设置与本地设置。展示合并后的最终生效集合；被更高优先级层遮蔽的规则以删除线
标出。

![Permissions](screenshots/12-permissions.png)

### Memory（记忆）

按项目查看持久化记忆库：MEMORY.md 索引、每个主题文件及其内容、大小和最后修改时间，对
存在但未被索引引用的文件标注 **orphan**（孤儿）徽标。

![Memory](screenshots/13-memory.png)

### Configs（生效配置）

各设置层合并后的只读视图：顶部卡片显示**默认模型**及其来源层、努力级别，以及根据你真实
转录记录得出的最近 7 天最常用模型。下方列出每个键的最终生效值、它覆盖了哪些层，并对设置
在该工具根本不读取的层中的键给出告警。

![Effective Configs](screenshots/15-configs.png)

## Settings（设置）

Harness 标签页上 ok/warn/error 状态标记所用的告警阈值、
[数据保留](storage.zh-CN.md#数据保留)，以及驱动应用内全部成本数字的分模型参考价格。

![Settings](screenshots/16-settings.png)

## 主题与数据源

浅色（暖米色）与深色（石板灰）两套主题，用右上角的太阳/月亮按钮切换；选择会被保存，
图表也会原地换肤。

![Dark theme](screenshots/17-dashboard-dark.png)

顶栏的 **Source ▾** 切换器列出所有已注册的 provider，并标注哪些有数据。首次启动时应用
会自动选中第一个有数据的 provider。
