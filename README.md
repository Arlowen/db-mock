# DB Mock

DB Mock 是一个基于 Web 和 Docker Compose 的开源数据库实例管理平台。它通过 SSH
管理 Linux 与 macOS Docker 主机，让团队可以在浏览器中创建、启停、升级、监控和
删除单机数据库实例。

已确认的产品范围、架构和验收标准见 [需求规格](docs/requirements.md) 与
[技术架构](docs/architecture.md)。自定义包格式见
[自定义模板说明](docs/custom-templates.md)。

## 首版能力

- 单个 Go 服务同时提供 API 和内嵌的 React 中英文页面，无需单独部署前端或 Nginx。
- SSH 密码/私钥接入远程主机，检测资源，可选安装或升级 Linux Docker。
- 通过 Docker Compose 创建、启停、异常自动重启、升级和删除数据库实例。
- 内置常见数据库模板，也可上传 Compose 模板包和 Docker 离线镜像，并扫描、人工清理
  长期未使用的控制端镜像归档。
- 主机与容器监控、日志、告警、通用 Webhook、任务中心和永久审计记录。
- 在线与完全离线的 Docker Compose 安装方式。

首版不包含 Windows、数据库备份/恢复、多主机数据库集群、SQL 控制台和公开 API
令牌。

## 快速启动

控制平台需要 Docker Engine 24+、Docker Compose v2，以及至少 2 CPU、4 GB 内存和
20 GB 磁盘：

```bash
cp deploy/.env.example deploy/.env
# 修改 deploy/.env 中的数据库密码和访问地址
make up
```

访问 `http://localhost:8080` 创建首个账号。生产环境、内置 HTTPS 与离线安装步骤见
[中文部署文档](docs/zh/deployment.md) 或 [English deployment guide](docs/en/deployment.md)。
版本标签会发布 `ghcr.io/arlowen/db-mock` 的 `linux/amd64`、`linux/arm64` 多架构镜像，
并在 GitHub Release 中附带两种架构的离线安装包和 SHA-256 校验文件。

## 仓库结构

```text
backend/            Go 服务、数据库迁移和内嵌页面产物
frontend/           React/Vite 页面、单元测试和 Playwright 测试
deploy/             Compose、Dockerfile、环境模板和 TLS 文件
scripts/            在线安装、升级、离线打包和 CI 辅助脚本
docs/               需求、架构与中英文部署文档
Makefile            仓库级开发、构建和部署入口
```

真实部署配置位于 `deploy/.env`，不会提交到 Git；可提交的配置模板位于
`deploy/.env.example`。

## 本地开发

需要 Go 1.25.12+ 和 Node.js 22：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres
cd frontend && npm ci && npm run build
cd ../backend && go run ./cmd/dbmock
```

从仓库根目录运行 `make test` 执行后端和前端测试，`make build` 生成单文件服务，
`make docker` 构建容器镜像。前端检查包含 TypeScript 类型检查和 Vitest 测试。

## 许可证

[Apache License 2.0](LICENSE)
