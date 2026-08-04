# DB Mock

DB Mock 是一个面向单管理员的测试数据库部署工具。它通过 SSH 管理已经安装
Docker Engine 和 Docker Compose 的 Linux 或 macOS 主机，让日常工作集中在一条流程内：

> 接入主机 → 创建数据库 → 跟踪任务 → 复制连接信息 → 启停与查看日志 → 安全删除

当前版本只面向开发、测试数据库，不承担生产数据库、高可用集群或数据库内容管理职责。

## MVP 能力

- 首次启动创建管理员账号，随后登录、退出和修改自己的密码。
- 使用 SSH 密码或私钥接入主机，校验 SSH、主机指纹、Docker、Compose、CPU、内存、
  磁盘、数据目录和端口池。
- 从数据库页选择内置单机数据库及固定版本，填写名称、资源、可选主机和模板必要参数后创建。
- 在详情和任务中心查看部署阶段、进度、日志、失败原因、恢复建议和安全重试入口。
- 查看并复制地址、端口、用户名、密码、URI、适用时的 JDBC，以及完整交付摘要。
- 启动、停止、重启数据库，查看当前状态和最近容器日志。
- 删除前读取最新状态和阻断证据，并要求输入准确数据库名称确认。

登录后的一级入口固定为：工作台、主机、数据库、任务。账号设置位于右上角个人菜单。

## 不属于当前 MVP

项目与标签、多用户和角色治理、用户管理、告警、Webhook、审计查询、历史监控、批量操作、
到期治理、备份恢复、版本升级、在线改配、私有或离线镜像、自定义模板、实验性多容器数据库、
自动安装 Docker、离线安装包、SQL 控制台、SSO、公开 API Token 和多主机高可用均不在当前
产品范围内。

为保证已有数据库和升级数据安全，仓库中仍保留部分历史表、字段和任务记录；历史托管备份只提供
删除逃生路径，不再提供创建、恢复或调度能力。它们不是当前版本的使用承诺。范围边界与分阶段删除证据见
[MVP 范围收缩审计](docs/mvp-scope-reduction-2026-08-04.md)。

## 快速启动

控制平台需要 Docker Engine 24+、Docker Compose v2、至少 2 CPU、4 GiB 内存和
20 GiB 可用磁盘：

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env：至少更换 DBMOCK_POSTGRES_PASSWORD，并核对 DBMOCK_PUBLIC_URL
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
make up
```

也可以运行 `./scripts/install.sh` 自动生成 PostgreSQL 随机密码并启动。访问
`DBMOCK_PUBLIC_URL` 创建首个管理员账号。

目标数据库主机必须先具备：

- 可从控制平台访问的 SSH；
- 已安装且可由 SSH 用户使用的 Docker Engine 与 Docker Compose v2；
- SSH 用户可写的数据目录，默认 `/opt/dbmock`；
- 可分配给测试数据库的端口范围，默认 `20000–40000`。

完整安装、HTTPS、升级与排障步骤见[部署说明](docs/zh/deployment.md)。

## 日常使用顺序

1. 在“主机”中接入并测试一台主机。
2. 在“数据库”中选择内置标准模板和固定版本。
3. 填写部署名称，核对资源和主机后创建。
4. 留在数据库详情观察任务；失败时按页面建议修复主机或安全重试。
5. 部署成功后打开“连接信息”，复制完整摘要交给开发人员。
6. 从列表或详情执行启动、停止、重启；在详情查看最近日志。
7. 不再需要时打开删除，处理历史阻断项并输入数据库名称确认。

## 安全与数据边界

- SSH 和数据库凭据加密保存；密码不会写入任务日志或 Git。
- 首次 SSH 连接需要确认主机指纹，后续指纹变化会阻止操作。
- 主机仍有托管数据库时不能删除。
- 网络结果不确定或证据未刷新时，页面禁止盲目重复提交。
- 平台只清理自己在目标数据根目录下创建的受管目录，不接管已有容器或任意外部路径。
- DB Mock 不修改防火墙或云安全组；数据库端口的开放范围由使用者负责。
- `deploy/.env`、TLS 私钥和真实凭据不得提交到仓库。

## 文档

- [需求规格](docs/requirements.md)
- [技术架构](docs/architecture.md)
- [部署说明](docs/zh/deployment.md)
- [公司内部试用清单](docs/internal-trial-checklist.md)
- [MVP 最终验收](docs/mvp-acceptance-2026-08-04.md)
- [核心工作流审计](docs/core-workflow-audit-2026-07-31.md)

## 本地开发

需要 Go 1.25.12+ 和 Node.js 22：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres
cd frontend && npm ci && npm run build
cd ../backend && go run ./cmd/dbmock
```

常用检查：

```bash
make test
make build
make docker
./scripts/ci/verify-template-images.sh
```

前端构建产物写入 `backend/web/dist` 并嵌入 Go 服务。仓库结构：

```text
backend/   Go API、任务执行、SSH/Docker 编排和内嵌页面
frontend/  React 页面、Vitest 与 Playwright 测试
deploy/    在线 Docker Compose 部署文件与环境变量模板
scripts/   安装、升级、检查和底层兼容运维脚本
docs/      当前需求、架构、部署、试用清单和历史审计证据
```

## 许可证

[Apache License 2.0](LICENSE)
