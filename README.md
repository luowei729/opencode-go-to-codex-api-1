# OpenCode Go API to Codex API Proxy

将 OpenCode Go API 转换为 Codex (OpenAI 兼容) API 格式的代理服务。支持 **Cloudflare Workers** 和 **Docker** 双部署。

## 功能特性

- 将 Codex CLI / OpenAI SDK 的请求转发到 OpenCode Go API
- 支持 Responses API (`/v1/responses`) 和 Chat Completions API (`/v1/chat/completions`)
- 支持流式响应 (SSE)
- 自动识别 Anthropic / OpenAI 兼容模型并转换协议
- Web UI 模型管理面板
- Cloudflare Workers 无服务器部署 / Docker 容器化部署

## 支持的模型

| 模型 | 模型 ID |
|------|---------|
| GLM-5.1 | glm-5.1 |
| GLM-5 | glm-5 |
| Kimi K2.5 | kimi-k2.5 |
| Kimi K2.6 | kimi-k2.6 |
| DeepSeek V4 Pro | deepseek-v4-pro |
| DeepSeek V4 Flash | deepseek-v4-flash |
| MiMo-V2.5 | mimo-v2.5 |
| MiMo-V2.5-Pro | mimo-v2.5-pro |
| MiniMax M3 | minimax-m3 |
| MiniMax M2.7 | minimax-m2.7 |
| MiniMax M2.5 | minimax-m2.5 |
| Qwen3.7 Max | qwen3.7-max |
| Qwen3.7 Plus | qwen3.7-plus |
| Qwen3.6 Plus | qwen3.6-plus |

## 部署

### 获取 OpenCode Go Token

访问 https://opencode.ai/auth 登录并获取你的 API Token。

---

### 方式一：Cloudflare Workers（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/luowei729/opencode-go-api-to-codex-api)

> 点击按钮一键部署到你的 Cloudflare 账号，自动 Fork 仓库并配置 GitHub Actions 持续部署。

#### 手动部署

1. **Fork 本仓库**到你的 GitHub 账号
2. **在 Cloudflare Dashboard 创建 Worker**：
   - 进入 Workers & Pages > Create > Workers
   - 记下你的 Account ID
3. **配置 GitHub Secrets**（仓库 Settings > Secrets and variables > Actions）：

   | Secret 名称 | 说明 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | CF API Token（需要 Workers Scripts:Edit 权限） |
   | `CLOUDFLARE_ACCOUNT_ID` | 你的 CF Account ID |

4. **Push 到 main 分支**，GitHub Actions 自动部署

#### 设置环境变量

部署后在 CF Dashboard 的 Worker Settings > Variables 中配置：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `UPSTREAM_BASE_URL` | 否 | 上游地址，默认 `https://opencode.ai/zen/go` |
| `DEFAULT_MODEL` | 否 | 强制所有请求使用的模型 |
| `MODEL_MAP` | 否 | 模型映射，格式 `from1:to1,from2:to2` |

> **安全说明**：CF Workers 部署**不在服务端存储用户 Token**。每个用户调用 API 时必须通过 `Authorization: Bearer <your_token>` 传递自己的 OpenCode Go Token。

#### 本地开发 (CF Workers)

```bash
npm install
cp .dev.vars.example .dev.vars   # 编辑填入配置
npm run cf:dev                    # 启动本地开发服务器
```

---

### 方式二：Docker Compose

```bash
# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 OPENCODE_TOKEN 等

# 构建并启动
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```

**环境变量说明**（`.env`）：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 `30001` |
| `UPSTREAM_BASE_URL` | 否 | 上游地址，默认 `https://opencode.ai/zen/go` |
| `OPENCODE_TOKEN` | 否 | 服务端 Token（设置后客户端无需传 Token） |
| `DEFAULT_MODEL` | 否 | 强制所有请求使用的模型 |
| `MODEL_MAP` | 否 | 模型映射，格式 `from1:to1,from2:to2` |

---

### 方式三：直接运行

```bash
npm install
cp .env.example .env   # 编辑配置
npm start               # 启动
npm run dev             # 开发模式（自动重载）
```

## 使用方法

### 配置 Codex CLI

```bash
# CF Workers 部署
export OPENAI_BASE_URL=https://your-worker.workers.dev/v1
export OPENAI_API_KEY=your_opencode_token   # 必须填写自己的 Token

# Docker 部署（若服务端已配置 OPENCODE_TOKEN，API_KEY 可填任意值）
export OPENAI_BASE_URL=http://localhost:30001/v1
export OPENAI_API_KEY=your_opencode_token

# 启动 codex
codex
```

### 使用 OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",  # 或 Docker: http://localhost:30001/v1
    api_key="your_opencode_token"                    # CF Workers 必须填写自己的 Token
)

response = client.chat.completions.create(
    model="kimi-k2.6",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### 使用 curl

```bash
# CF Workers 部署
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_opencode_token" \
  -d '{
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'

# Responses API
curl https://your-worker.workers.dev/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_opencode_token" \
  -d '{
    "model": "gpt-4o",
    "input": "Hello!",
    "stream": false
  }'
```

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | Web UI 模型管理面板 |
| `GET /health` | 健康检查 |
| `GET /v1/models` | 获取可用模型列表 |
| `POST /v1/responses` | Responses API（转换为 Chat Completions / Anthropic） |
| `POST /v1/chat/completions` | Chat Completions API |
| `GET /api/default-model` | 获取当前强制模型 |
| `POST /api/default-model` | 设置强制模型 |

## 认证方式

| | CF Workers 部署 | Docker 部署 |
|---|---|---|
| **服务端 Token** | ✘ 不支持 | ✔ `.env` 中设置 `OPENCODE_TOKEN` |
| **客户端 Token** | ✔ 必须通过 `Authorization` 头传递 | ✔ 服务端未配置时使用客户端 Token |

- **CF Workers**：安全优先，不在服务端存储任何用户密钥，每个用户必须传自己的 Token
- **Docker**：支持服务端统一配置 Token（适合团队内部使用），也支持客户端透传

## 项目结构

```
├── worker/                  # Cloudflare Workers
│   ├── index.js            # Workers 入口 (fetch handler)
│   └── proxy-logic.js      # 代理核心逻辑 (ESM)
├── src/                     # Node.js / Docker
│   ├── server.js           # Express 服务入口
│   ├── proxy.js            # 代理核心逻辑 (CJS)
│   └── index.html          # Web UI
├── pages/
│   └── index.html          # Web UI (CF Workers 版本，含 Token 输入)
├── wrangler.toml           # CF Workers 配置
├── Dockerfile              # Docker 镜像
├── docker-compose.yml      # Docker Compose 编排
└── .github/workflows/      # GitHub Actions 自动部署
```

## 架构

```
Codex CLI / OpenAI SDK
        |
        v
┌─────────────────┐
│  Proxy Server   │  :3000
│  (this service) │
└────────┬────────┘
         |
         v
┌─────────────────────────┐
│  OpenCode Go API        │
│  opencode.ai/zen/go/v1  │
└─────────────────────────┘
```

## License

MIT
