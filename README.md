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
- 内置常见数据库模板，也可上传 Compose 模板包和 Docker 离线镜像。
- 主机与容器监控、日志、告警、通用 Webhook、任务中心和永久审计记录。
- 在线与完全离线的 Docker Compose 安装方式。

首版不包含 Windows、数据库备份/恢复、多主机数据库集群、SQL 控制台和公开 API
令牌。

## 快速启动

控制平台需要 Docker Engine 24+、Docker Compose v2，以及至少 2 CPU、4 GB 内存和
20 GB 磁盘：

```bash
cp .env.example .env
# 修改 .env 中的数据库密码和访问地址
docker compose up -d --build
```

访问 `http://localhost:8080` 创建首个账号。生产环境、内置 HTTPS 与离线安装步骤见
[中文部署文档](docs/zh/deployment.md) 或 [English deployment guide](docs/en/deployment.md)。

## 本地开发

```bash
docker compose up -d postgres
cd frontend && npm ci && npm run build
cd .. && go run ./cmd/dbmock
```

后端测试使用 `go test ./...`，前端使用 `npm test` 和 `npm run build`。

## 许可证

[Apache License 2.0](LICENSE)
