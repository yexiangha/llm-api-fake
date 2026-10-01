<div align="center">

# 假 LLM API 服务商 · llm-api-fake

**一个"看起来是 OpenAI，其实是你自己"的大模型 API。**

所有接口都正常响应，但**没有一个字来自真实模型**——每一条回复都是你在网页后台里预先写好的自定义内容。
部署在 Cloudflare Workers 边缘节点上，一张 KV 表 + 一个 Worker 就是全部。

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/deploy-wrangler-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/wrangler/)
[![Runtime](https://img.shields.io/badge/runtime-Workers%20%2B%20KV-7c5cff)](https://developers.cloudflare.com/kv/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
![No LLM](https://img.shields.io/badge/real%20LLM%20calls-0-red)

线上示例：**https://llm.yexiangha.top** · 后台：**https://llm.yexiangha.top/admin**

</div>

---

## 这是什么

把 `base_url` 指向本站的**任何 OpenAI 客户端 / SDK**，都能"正常"跑起来：

- `GET /v1/models` 返回模型列表
- `POST /v1/chat/completions` 返回标准 `chat.completion` 结构，支持 `"stream": true` 的 SSE 逐字吐字
- 其它任何路径也会按你的规则响应（设计如此：**一切请求都响应**）

区别只有一个：**内容是假的**。回复文本 100% 来自后台里配置的「规则」，服务不会向任何模型推理服务发请求，延迟只有几毫秒，成本为零。

典型用途：

| 场景 | 说明 |
|---|---|
| 🧪 客户端/网关联调 | 不烧 token 就能测通流式解析、重试、超时、错误处理逻辑 |
| 🎭 演示与整蛊 | 演示时让"模型"说出你写好的话，效果逼真（有 SSE 有 usage 有 finish_reason） |
| 🧩 Agent 开发 | 固定返回内容，做确定性回归测试，避免模型输出漂移 |
| 📚 教学 | 讲清一个"LLM API 服务商"到底由哪些部分组成 |

> ⚠️ 请仅用于测试、演示与教学。不要用它冒充真实模型服务去误导他人，也不要用它伪造 API 计费凭证。

---

## 快速开始

### 1. 本地跑起来

```bash
git clone https://github.com/yexiangha/llm-api-fake.git
cd llm-api-fake
pnpm install

# 建一个 KV 命名空间，把 id 填进 wrangler.toml
npx wrangler kv namespace create llm-api-fake

# 本地后台密码（可选，不设则自动生成令牌）
echo "ADMIN_PASSWORD=dev-local-password" > .dev.vars

pnpm dev        # http://127.0.0.1:8787
```

### 2. 立刻调用一次

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-anything" \
  -d '{"model":"fake-gpt-4o","messages":[{"role":"user","content":"你好"}]}'
```

```json
{
  "id": "chatcmpl-9f2c…",
  "object": "chat.completion",
  "created": 1790000000,
  "model": "fake-gpt-4o",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "你好，我是运行在 Cloudflare Workers 上的「假 LLM」…" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 7, "completion_tokens": 61, "total_tokens": 68 },
  "_fake": true
}
```

### 3. 部署到自己的域名

```bash
# Custom Domain 方式（推荐）：wrangler 自动建 DNS 记录
# wrangler.toml 里：
#   routes = [{ pattern = "llm.example.com", custom_domain = true }]

npx wrangler secret put ADMIN_PASSWORD   # 后台密码
npx wrangler deploy
```

部署完成后打开 `https://你的域名/admin`，写第一条规则即可。

---

## 管理后台

访问 `/admin`，用密码（`ADMIN_PASSWORD`）或自动生成的令牌登录。后台可以：

- **增删改规则**：一条规则 = 「匹配条件」+「响应内容」
- **三种匹配方式**（可组合，全部满足才命中）：

| 匹配方式 | 写法 | 优先级 |
|---|---|---|
| 正则 | `^帮我.*代码` | 最高（50 分） |
| 关键词 | `天气`（包含即命中） | 中（30 分） |
| 模型名 | `gpt-4*` 通配、`/^claude-/` 正则、`gpt-4o` 精确 | 低（20 分） |
| 兜底规则 | 勾选「作为兜底规则」，无命中时使用 | 最低 |

- **全局设置**：服务名、默认模型名、默认延迟、是否强制校验 `sk-` 开头的 key
- **试跑**：输入一句话，直接看会命中哪条规则、返回什么

### 两道门：人机认证 + 后台密码

```
浏览器 / 脚本  →  ① Cloudflare Turnstile 人机认证  →  ② 后台密码(ADMIN_PASSWORD)  →  规则 CRUD
                  （挡自动化脚本、爬虫）              （挡知道地址的人）
```

两者是**叠加**关系，不是替代：

| 层 | 作用范围 | 未通过时 |
|---|---|---|
| Turnstile 人机认证 | `/admin` 页面与 `/admin/api/*` | 页面只显示验证挂件（不吐任何规则数据）；API 返回 `403 {"code":"human_verification_required"}` |
| 后台密码 | 同上 | API 返回 `401` |

通过人机认证后会下发一个 **HttpOnly + Secure + SameSite=Lax 的签名 Cookie**（HMAC-SHA256，绑定后台密码，默认 12 小时）。
伪造、篡改过期时间、改签名都会被拒；改后台密码则所有旧 Cookie 立即失效。

**开启方式**（不配置就是关闭状态，只留后台密码那一层）：

```bash
# 1. 在 Cloudflare 后台创建 Turnstile widget
#    Dashboard → Turnstile → Add widget → 域名填你的域名（如 llm.yexiangha.top）→ 选 Managed
# 2. 把 sitekey 写进 wrangler.toml 的 [vars]，secret key 存成 secret
#    TURNSTILE_SITE_KEY = "0x4AAAAAAA..."        # 公开值，写在 [vars] 里
npx wrangler secret put TURNSTILE_SECRET_KEY    # 私密值，必须走 secret
npx wrangler deploy
```

> 用 Cloudflare 官方测试 key（sitekey `1x00000000000000000000AA` + 对应的测试 secret）可以在不建 widget 的情况下先跑通流程。

**本地怎么测人机认证**：仓库里带了可控的假验证端，能在本地完整覆盖"通过 / 重放 / 失败"三条路径——

```bash
node scripts/mock-turnstile.mjs 8798 &            # 假 siteverify：PASS* 通过、DUP* 重放失败、其它拒绝
# .dev.vars 里指向它：
#   TURNSTILE_SITE_KEY=1x00000000000000000000AA
#   TURNSTILE_SECRET_KEY=dev-local-turnstile-secret
#   TURNSTILE_VERIFY_URL=http://127.0.0.1:8798/siteverify
node scripts/test-turnstile.mjs http://127.0.0.1:8799 dev-local-password   # 28 项检查
```

### 响应内容里的占位符

把真实请求信息编进假回复，让它更像真的：

| 占位符 | 含义 | 占位符 | 含义 |
|---|---|---|---|
| `{{user}}` | 用户最后一句 | `{{messages}}` | 全部对话文本 |
| `{{model}}` | 请求的模型名 | `{{id}}` | 本次 `chatcmpl-xxx` |
| `{{time}}` | 请求时间 ISO | `{{hash}}` | 用户消息指纹（8 位） |
| `{{rand}}` | 4 位随机串 | `{{len}}` / `{{words}}` | 字数 / 词数 |
| `{{path}}` / `{{method}}` | 请求路径与方法 | `{{key}}` | 客户端带来的 key |

例：内容写 `收到「{{user}}」，本条回复由规则库生成（{{hash}} · {{time}}）`。

> 小提醒：`{{time}}` / `{{rand}}` / `{{id}}` 这类占位符每次请求都会变，
> 所以同一条规则、同一条消息，两次调用的返回文本不会逐字节相同——这正是"像真的"的地方。
> 想让输出完全可复现（做回归测试时有用），把它们从规则内容里去掉即可。

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/v1/models` | 模型列表（包含你配置的模型名） |
| `POST` | `/v1/chat/completions` | OpenAI 兼容补全，`stream:true` 时返回 SSE |
| `ANY` | `/v1/echo` | 原样回显请求头/体（`authorization` 已脱敏），调试客户端必备 |
| `GET` | `/health` | 健康检查，返回规则条数与版本 |
| `GET` | `/admin` | 管理后台 |
| `POST` | `/admin/api/rules` | 规则 CRUD（需令牌） |
| `GET/POST` | `/admin/api/settings` | 全局设置（需令牌） |
| `POST` | `/admin/api/test` | 用当前规则试跑一条消息（需令牌） |
| `ANY` | `/*` | 兜底：任何其它路径也返回规则内容 |

### 用官方 SDK 调用

```python
from openai import OpenAI

client = OpenAI(base_url="https://llm.yexiangha.top/v1", api_key="sk-anything")
print(client.chat.completions.create(
    model="fake-gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
).choices[0].message.content)
```

```python
# 流式
for chunk in client.chat.completions.create(
    model="fake-gpt-4o", stream=True,
    messages=[{"role": "user", "content": "讲个故事"}],
):
    print(chunk.choices[0].delta.content or "", end="")
```

```js
// Node / 浏览器
const r = await fetch("https://llm.yexiangha.top/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer sk-anything" },
  body: JSON.stringify({ model: "fake-gpt-4o", messages: [{ role: "user", content: "你好" }] }),
});
console.log((await r.json()).choices[0].message.content);
```

---

## 结构

```
src/
  worker.ts            路由、鉴权、OpenAI 兼容层、后台 API
  lib/match.ts         规则匹配与打分（正则 > 关键词 > 模型名 > 兜底）
  lib/template.ts      {{占位符}} 模板引擎与文本工具
  lib/openai.ts        chat.completion / SSE 流 / models 响应构造
  lib/store.ts         KV 存取、内存缓存（10s）、设置与示例数据
public/
  home.html            首页（纯服务端拼字符串，无前端构建）
  admin.html           管理后台（原生 JS，单文件）
test/                  node:test 单元测试
scripts/smoke.mjs      端到端冒烟（真实 HTTP + 真流式解析）
```

### 为什么这样设计

- **规则一条一个 KV key**（`rule:<id>`）：后台改一条不会覆盖其它规则，避开 KV 无事务的坑
- **Worker 内 10 秒内存缓存**：把 KV 读取量压到极低（免费额度 10 万次/天足够用）
- **响应内容存 KV 而不是代码里**：改剧本不用重新部署
- **零前端构建**：两个 HTML 文件直接用 Wrangler 的文本导入，`pnpm deploy` 一步上线
- **一切请求都响应**：连没实现的路径也会命中规则，方便观察客户端到底发了什么

### 一个必须知道的一致性事实

Cloudflare KV 是**最终一致**的：写入后**最多 60 秒**才会在全球所有边缘节点可见。
所以后台改完规则后，你本机可能 1 秒就看到新内容，而另一个地区的客户端可能还要等一会儿。
这是 KV 的产品语义（换来读取极快、免费额度大），不是 bug；冒烟脚本也因此把
"新规则生效"设计成**反复探测**而不是固定等待（`PROPAGATION_WAIT_MS` 可调）。

> 真要求"写完立刻全球一致"，把 `src/lib/store.ts` 的存储换成 D1 或 Durable Object 即可，
> 接口层与后台都不用改。

### 某些网络下推不上 GitHub？

如果你的网络能通 `api.github.com` 但连不上 `github.com:443`（`git push` 会卡住报
`Failed to connect to github.com`），可以用仓库里这个脚本——它走 **GitHub 官方 Git Data API**
把本地文件同步成一次提交，效果等价于 push：

```bash
node scripts/gh-sync.mjs                    # 同步到 yexiangha/llm-api-fake 的 main
node scripts/gh-sync.mjs owner/repo branch   # 或指定仓库/分支
# 令牌取环境变量 GH_TOKEN，或本机 gh auth token
```


---

## 常用命令

```bash
pnpm dev            # 本地开发服务器
pnpm check          # 类型检查 + 单元测试
pnpm test           # 单元测试（node:test）
pnpm deploy         # 部署到 Cloudflare
node scripts/smoke.mjs https://llm.yexiangha.top 你的后台密码   # 线上冒烟（37+ 项）
node scripts/seed-live.mjs https://llm.yexiangha.top 后台密码    # 给线上灌示例规则
node scripts/gh-sync.mjs                                          # 网络受限时用 API 推 GitHub
node scripts/test-turnstile.mjs http://127.0.0.1:8799 后台密码     # 人机认证端到端（28 项）
node scripts/mock-turnstile.mjs 8798                              # 本地假 siteverify 服务

# 忘了后台令牌（未设置 ADMIN_PASSWORD 时）
pnpm kv:token
```

## 配置项

| 位置 | 名称 | 说明 |
|---|---|---|
| secret | `ADMIN_PASSWORD` | 后台密码；不设置则自动生成令牌存 KV |
| secret | `TURNSTILE_SECRET_KEY` | Turnstile 私密 key；与 sitekey 同时配置才开启人机认证 |
| vars | `TURNSTILE_SITE_KEY` | Turnstile 公开 sitekey（可写进 wrangler.toml） |
| vars | `TURNSTILE_VERIFY_URL` | 仅本地测试：把 siteverify 指到假端，线上不要设 |
| vars | `SERVICE_NAME` | 服务展示名 |
| vars | `SERVICE_VERSION` | 版本号（`/health` 与首页展示） |
| KV | `LLM_FAKE_KV` | 规则与设置存储 |

## License

[MIT](./LICENSE) · 仅供测试、演示与教学使用。
