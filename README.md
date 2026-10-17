# st-cache-optimizer

**SillyTavern 服务端插件** —— 在请求发出前重新规划提示词缓存断点，让 `{{random}}`、实时世界书、记忆/向量注入这类动态内容不再把整段上下文一起拖下水。

SillyTavern 自带的缓存实现只在 system 段的**最后一个块**打断点。一旦那个块含动态内容，它前面的静态部分（角色卡、固定世界书、系统提示词）会**一起失效**，命中率直接归零。本插件通过跨请求比对，自己算出真正稳定的前缀边界，把断点打在那里。

| 场景 | ST 默认 | ST 自带全开 | 本插件 | +hoist | **+hoist+保活** |
|---|---|---|---|---|---|
| ① 全静态提示词 | 0% | 97.5% | 97.5% | 97.5% | 97.5% |
| ② system 含 `{{random}}` | 0% | **0%** | 8.4% | 91.2% | 91.2% |
| ③ 深度注入（memory/向量） | 0% | 11.5% | 90.7% | 90.7% | 90.7% |
| ④ 动态 system + 深度注入 | 0% | **0%** | 8.3% | 87.6% | 87.6% |
| ⑤ **挂机超 TTL（真实常态）** | 0% | 0% | **0%** | **0%** | **97.5%** |
| ⑥ 动态 system + 超 TTL | 0% | 0% | 0% | 0% | **91.2%** |

> 稳态命中率，40 轮对话，按 Anthropic 前缀精确匹配语义模拟。跑 `node test/benchmark.mjs` 可自行复现。
>
> 长对话会继续向 100% 收敛：**第 50 轮 98.2% / 第 100 轮 99.1% / 第 400 轮 99.8%**，
> 未命中量恒定在「上一轮回复 + 本轮输入」——这就是理论下界。

### ⑤⑥ 才是真实使用的主战场

连续对话时前缀优化已经够用。但人回完消息会去想、去查、去改，间隔经常超过 **5 分钟 TTL**，
下一轮整段历史冷启动 —— 前面做得再好也白搭。**保活**就是补这个洞：
在缓存到期前发一个 `max_tokens=1` 的续期请求，一次约 0.1× 上下文，
挡下一次冷启动就回本（省 0.9×）。

---

## 安装

本仓库**同时**是一个 UI 扩展和一个服务端插件，所以两个入口都能装：

```
manifest.json   → UI 扩展入口（js 指向 ui/index.js）
plugin/         → 服务端插件入口（package.json 的 main 指向 plugin/index.js）
```

### 方式一：酒馆 UI 一键安装

> ⚠️ **酒馆的安装器只认 `github.com` / `gitlab.com` / `gitee.com` 三个域名**
> （提示语：`Only github.com / gitlab.com / gitee.com repositories are supported`）。
> 自建服务器、私有 Git 服务、内网地址都会被拒。所以仓库必须落在其中一家。

1. 「扩展」面板 → **Install extension**
2. 粘贴仓库地址，例如：
   - `https://gitee.com/<你>/st-cache-optimizer`（国内最省事）
   - `https://github.com/<你>/st-cache-optimizer`
3. 重启 SillyTavern

装完后设置面板里就有开关，会直接告诉你服务端插件是否就绪。

### 方式一·备选：域名被卡住时，直接克隆

安装器拒收你的托管地址，但 git 本身不挑域名。直接克隆进扩展目录即可，
完全绕过那道校验：

```bash
cd /path/to/SillyTavern
git clone --depth 1 <任意可达的仓库地址> data/default-user/extensions/st-cache-optimizer
```

重启 SillyTavern 就能在「扩展」里看到。这条路径不需要注册任何账号。

### 只需要这一步就够了

**装完 UI 扩展就可用**，不需要服务端插件、不需要改 `config.yaml`、不需要重启。

前端会拦截发往 `/api/backends/chat-completions/generate` 的请求，在发出前把
`cache_control` 断点打好。对 **OpenRouter / NanoGPT / 自定义 OAI 兼容端点** 完整生效
（服务端对这些源是原样透传 `messages` 的）。

| 能力 | 只要 UI 扩展 | 需要服务端插件 |
|---|---|---|
| 断点重排（核心收益） | ✅ | ✅ |
| 真实命中率读数 | ✅ 从响应 usage 读 | ✅ 从响应 usage 读 |
| 动态内容搬到末尾（hoist） | ❌ | ✅ |
| 缓存保活 | ❌ | ✅ |
| **Claude 直连** | ❌ | ✅ |

Claude 直连为什么不行：ST 服务端的 `convertClaudeMessages()` 会把
`content` 从字符串重建成 `{ type: 'text', text }`，**顺带丢掉 `cache_control`**。
这是服务端行为，前端改不掉。

### 方式二：装服务端插件（想要完整功能时）

仅在你需要 hoist / 保活 / Claude 直连时才有必要。

**前置条件：开启服务端插件**

```yaml
# config.yaml
enableServerPlugins: true
```

```bash
cd /path/to/SillyTavern
node plugins.js install https://github.com/<you>/st-cache-optimizer
```

重启 SillyTavern，日志里出现这两行就是装好了：

```
[cache-optimizer] 已接管出站请求缓存断点（enabled=true, maxBreakpoints=4, ttl=5m）
[cache-optimizer] 已安装 UI 扩展 → data/default-user/extensions
```

### 两个都装？

可以，不会重复。插件侦测到自己是从 `extensions/` 目录加载的，会自动跳过 UI 部署。

### 自己发布

```bash
# GitHub（需要 gh auth login）
node publish.mjs

# Gitee —— 国内最省事，先在建好空仓库
node publish.mjs --gitee <你的gitee用户名>

# GitLab
node publish.mjs --gitlab <你的gitlab用户名>
```

脚本会建仓库/推代码，并打印上面几种安装方式的确切命令。

## 界面

刷新页面后，在「扩展」面板里有 **Cache Optimizer** 一栏：

```
┌─ Cache Optimizer ──────────────────────┐
│ ☑ 启用缓存优化         [已开启]         │
│                                        │
│ 动态内容处置  [ 搬到末尾（最高命中） ▾ ] │
│                                        │
│   99.2%      30.1k       0              │
│  缓存命中率   命中tokens  写入tokens     │
│                                        │
│ [ 刷新 ]              [ 清零 ]          │
└────────────────────────────────────────┘
```

- **开关**：即时生效，不用重启、不用刷新。关掉后连内容都不碰，请求原样发出。
- **下拉框**：对应 `relocateVolatile`，三档的取舍见下节。
- **读数**：每 10 秒自动刷新；面板折叠时停止轮询。
- 魔法棒菜单里也有一个 ⚡ 图标，点一下直接开关。

服务端插件没装或没启用时，面板会直接告诉你，而不是静默失效。

## 配置

首次启动会在插件目录生成 `config.json`：

```json
{
  "enabled": true,
  "maxBreakpoints": 4,
  "ttl": "5m",
  "respectStBuiltin": false,
  "relocateVolatile": false,
  "debug": false,
  "targets": ["api.anthropic.com", "openrouter.ai", "..."]
}
```

| 字段 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `maxBreakpoints` | 断点上限，Anthropic 硬上限是 4 |
| `ttl` | `"5m"`（写入 1.25× 价）或 `"1h"`（写入 2× 价） |
| `respectStBuiltin` | `false` = 清掉 ST 打的断点重新布局（推荐） |
| `relocateVolatile` | `false` / `"reorder"` / `"hoist"`，见下 |
| `autoInstallUI` | 启动时自动铺 UI 扩展（默认开；关掉就只保留手动安装） |
| `keepalive` | 缓存保活，见下节。**默认关闭**（会产生真实 API 调用） |
| `targets` | 只处理这些域名的请求 |

也可以在运行时改：

```bash
curl -X POST http://127.0.0.1:8000/api/plugins/st-cache-optimizer/config \
  -H 'Content-Type: application/json' -H "x-csrf-token: $TOKEN" \
  -d '{"relocateVolatile":"hoist"}'
```

---

## `relocateVolatile`：决定动态内容怎么处置

这是「适配任何动态」的核心开关，三档：

### `false`（默认）—— 只优化断点

不碰任何内容，纯增强，零语义风险。

动态块之前的部分能保住。如果动态内容在对话历史深处（记忆/向量注入的典型形态），这一步就能把命中率从 11% 拉到 **90%**。

### `"reorder"` —— 在 system 段内重排

把检测到的易变块挪到 system 段的末尾，静态块保持相对顺序在前。

语义影响很小（内容不变，只是块顺序变了），但**只有当易变块原本夹在静态块中间时才有收益**。

### `"hoist"` —— 搬到本轮最后一条 user 消息 ⭐

把易变块从 system 段摘出来，追加到本轮最后一条 user 消息里。

**这是唯一能让动态内容不再拖垮整个历史的模式。** 原理：

```
缓存是前缀匹配。动态块卡在 system 里时，它后面的一切都吃不到缓存 ——
包括全部对话历史。历史越长，命中率越趋近 0。

搬到末尾之后，它只污染「本来就要 miss 的尾巴」，
前面所有静态内容 + 历史连成一条稳定前缀，命中率随对话增长趋近 100%。
```

⚠️ **代价**：改变了内容在 prompt 中的位置。对 `{{random}}` 风味文本、实时世界书、时间戳这类内容通常无害甚至更合理（它们本来就属于当前轮），但会改变位置敏感的提示词行为。**所以默认关闭。**

---

## 缓存保活（把命中率从"看运气"变成"稳"）

```json
"keepalive": {
  "enabled": false,     // 默认关。它有真实成本，要你点头
  "factor": 0.75,       // 在 TTL 的 75% 处触发
  "maxCycles": 2,       // 最多续期 2 次，人走了就停
  "minIntervalMs": 60000,
  "intervalMs": 0       // 0 = 自动；显式数值可覆盖间隔（测试用）
}
```

**成本算术**：一次保活 ≈ `0.1 × prompt tokens`。它挡下的那次冷启动本来要付 `1.0 × prompt`。
所以只要挡下一次，就省了 `0.9 × prompt` —— 大约等于 9 次保活的钱。
`maxCycles: 2` 意味着最坏情况下（你再也没回来）白花 `0.2 × prompt`，上限可控。

**它做什么**：发一个 `max_tokens=1`、非流式、**摘掉 tools** 的请求，body 里保留同样的
`cache_control` 断点 —— 于是整段前缀被当作缓存读取（0.1×）并刷新 TTL。
有真实请求进来时立即取消，不叠加。

UI 面板里就是一个勾选框：**保持缓存热度（定时续期）**。

## 看真实命中率

SillyTavern **本身完全不解析 `usage`**，界面上看不到任何缓存命中数据。本插件顺手把它读出来了。

```bash
curl http://127.0.0.1:8000/api/plugins/st-cache-optimizer/stats
```

```json
{
  "summary": {
    "requests": 7,
    "tokens": { "read": 30100, "creation": 0, "input": 840, "output": 1750 },
    "hitRate": 0.992
  },
  "counters": { "inspected": 3, "intercepted": 3, "optimized": 3, "errors": 0 },
  "snapshots": { "keys": 1, "snapshots": 3 }
}
```

| 接口 | 用途 |
|---|---|
| `GET /stats` | 命中率、token 明细、计数器 |
| `GET /config` | 当前配置 |
| `POST /config` | 改配置（改完立即生效） |
| `POST /reset` | 清空统计与快照 |
| `POST /install-ui` | 手动重铺 UI 扩展 |

`creation` 是写入缓存的量。写入价是 1.25×，所以合理目标不是「写入越多越好」，而是「读得多、写得少」。

---

## 工作原理

```
出站请求
   │
   ├─ 拦截层 lib/intercept.js
   │    ST 的模型后端全部 import node-fetch，不走全局 fetch；
   │    node-fetch 内部运行时取 http.request / https.request。
   │    所以在这个层级替换 request，能拦到所有后端调用。
   │    拦到后缓冲 body，在 end() 时改写并修正 Content-Length。
   │
   ├─ 分析层 lib/analyzer.js
   │    把请求摊平成有序「缓存单元」（tools → system → messages），
   │    与历史快照逐单元比对，算出最长稳定前缀。
   │
   ├─ 状态层 lib/snapshots.js
   │    按「凭证 + 模型」为 key 保留最近 6 次请求快照，
   │    支持多会话 / 重新生成 / 滑动互不干扰。
   │
   └─ 断点布局
        1. 稳定边界    —— 动态内容变天时的锚点
        2. 整段末尾    —— 仅在「上一轮被完整保留」（单调追加）时才打
        3. 其余断点    —— 在两者之间分摊做对冲
```

**末尾断点的风险闸门**：末尾断点命中省 90%，但若下轮失效要多付 25%（写入价 1.25×）。当检测到前缀已被动态内容污染时，插件会**主动放弃末尾断点**，把断点全部收在稳定区内 —— 避免让整段历史按写入价计费。等对话恢复到单调追加，再自动重新下注。

---

## 为什么不可能真的 100%

缓存是**前缀逐字节匹配**。每一轮至少有「上一轮的模型回复 + 本轮的新输入」是新增的，这部分在上一轮还不存在，**不可能命中**。

所以数学上的上限不是 100%，而是：

```
稳态命中率 → 1 − (本轮新增 tokens) / (总 tokens) → 趋近 100%
```

本插件已经做到「除了必须新增的部分，其余全部命中」——这已经是理论最优。上面的 91.2% / 90.7% / 87.6% 就是剩下的新增内容占比。

配合这两点还能再往上推：

1. **保持缓存热**：TTL 默认 5 分钟。挂机超过 5 分钟再发消息，缓存已过期，那轮必然冷启动。
2. **别开 `extendedTTL`**：1h TTL 写入价翻倍到 2×，除非你真的会间隔很久才发下一条，否则不划算。

---

## 兼容性

支持所有 ST 走的 chat-completion 后端。带显式断点的：

| 后端 | 说明 |
|---|---|
| Claude 直连 | `cache_control` + `prompt-caching` beta 头 |
| OpenRouter → Claude | 同上 |
| OpenRouter → Gemini | 需模型 `pricing.input_cache_write` 非空 |
| NanoGPT → Claude | body 级 `cache_control` |

其余后端（OpenAI / DeepSeek / xAI / Groq / Mistral …）依赖供应商的**自动缓存**，不需要 `cache_control` 标记，但同样只认前缀——本插件的断点布局对它们也有正作用（自动缓存看的是前缀稳定性，而插件做的正是让前缀更稳定）。

⚠️ 自动缓存的后端拿不到 `cache_read_input_tokens`，`/stats` 里不会出现命中数据。

---

## 测试

```bash
npm test                              # 算法层（65 项，无需 ST）
node test/e2e.test.mjs                # 单元 E2E：mock API + 真实 HTTP（20 项）
node test/benchmark.mjs               # 命中率基准对比

# 以下需要 ST 正在运行
node server.js --port 8124 &
node test/integration.test.mjs http://127.0.0.1:8124   # 全栈集成（11 项）
node test/toggle.test.mjs http://127.0.0.1:8124        # UI 开关真的生效（12 项）
node test/keepalive.test.mjs http://127.0.0.1:8124     # 保活真的发请求且参数正确（12 项）
```

共 122 项。`toggle.test.mjs` 验证的是「点了开关真的改变行为」，
而不是「改了个没人读的变量」：关掉后请求里不再出现 `cache_control`，
hoist 也不再搬动内容。

---

## 安全设计

拦截层是零信任的：**任何环节出错都原样放行**。

- 只处理 `content-type: application/json` 且含 `messages` 数组的请求
- 只处理 `anthropic-version` 头或域名白名单命中的请求
- body 解析失败 → 原样发送
- 改写抛错 → 原样发送
- 响应观察只包 `res.push`，不改流、不改内容，不影响 `pipe` / async 迭代
- `exit()` 完整还原 `http.request` / `https.request` / `globalThis.fetch`

---

## License

MIT
