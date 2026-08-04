# DB Mock MVP 部署说明

本说明只覆盖当前支持的 Docker Compose 在线安装、HTTPS、升级和核心排障。完全离线安装包、
私有/离线数据库镜像和设置中心不属于 MVP。

## 1. 前置条件

### 控制平台

- Linux `amd64`/`arm64`，或安装 Docker Desktop 的 macOS。
- Docker Engine 24+ 与 Docker Compose v2。
- 至少 2 CPU、4 GiB 内存和 20 GiB 可用磁盘。
- 能联网拉取 DB Mock、PostgreSQL 以及要部署的公开数据库镜像。
- 浏览器能访问 DB Mock；DB Mock 容器能访问目标主机 SSH。

### 目标数据库主机

- 可 SSH 直连的 Linux 或 macOS，不经过跳板机。
- 已安装并运行 Docker Engine 与 Docker Compose v2；DB Mock 不负责安装或升级 Docker。
- SSH 用户可以运行 `docker version`、`docker compose version`，并能写入专用数据根目录。
- 安装 `ss`、`lsof` 或 `netstat` 至少一个工具，用于端口池探测。
- 为测试数据库预留端口范围，并按公司网络策略配置防火墙或安全组。

## 2. 在线安装

在仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，至少更换 DBMOCK_POSTGRES_PASSWORD 并核对 DBMOCK_PUBLIC_URL
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

也可以使用安装脚本：

```bash
./scripts/install.sh
```

脚本在 `deploy/.env` 不存在时生成随机 PostgreSQL 密码，优先拉取已发布镜像；发布镜像不可用时
从当前检出构建应用镜像。

默认健康检查：

```bash
curl -fsS http://127.0.0.1:8080/api/v1/health
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 dbmock
```

打开 `DBMOCK_PUBLIC_URL`，创建首个管理员账号。`DBMOCK_TIMEZONE` 只在首次初始化时写入平台；
没有设置页面可在初始化后修改它，因此请在创建管理员前确认时区。

## 3. 配置项

`deploy/.env` 不得提交。MVP 常用配置：

| 变量 | 作用 | 默认/要求 |
| --- | --- | --- |
| `DBMOCK_POSTGRES_PASSWORD` | 元数据 PostgreSQL 密码 | 必须改为强随机值 |
| `DBMOCK_IMAGE` | DB Mock 应用镜像 | `ghcr.io/arlowen/db-mock:latest` |
| `POSTGRES_IMAGE` | 元数据数据库镜像 | `postgres:17-alpine` |
| `DBMOCK_PUBLIC_URL` | 浏览器实际访问的 HTTP/HTTPS origin | 不得包含路径、查询或片段 |
| `DBMOCK_BIND_ADDRESS` | 控制平台监听地址 | `0.0.0.0`；反向代理建议收窄 |
| `DBMOCK_PORT` | 宿主机端口 | `8080` |
| `DBMOCK_TIMEZONE` | 首次初始化的 IANA 时区 | `Asia/Shanghai` |
| `DBMOCK_SESSION_DURATION` | 会话有效期，Go duration | `720h` |
| `DBMOCK_TASK_WORKERS` | 持久化任务并发 | `4`，允许 `1–32` |
| `DBMOCK_TRUSTED_PROXIES` | 可提供 `X-Forwarded-For` 的直连代理 | 默认空 |

应用在连接 PostgreSQL 和启动 worker 前严格校验配置。非法时长、任务并发、公开 URL、TLS 密钥对
或可信代理范围会阻止启动，并在日志中指出变量名。

## 4. HTTPS

### 内置 TLS

把证书和私钥放入 `deploy/tls/`，在 `deploy/.env` 使用容器内路径：

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

重新执行 Compose `up -d`。证书和私钥必须同时配置且匹配，公开地址必须使用 HTTPS。容器内
`dbmock` 用户为 UID/GID `100:101`，证书目录和文件必须允许该用户读取。

健康检查改用公开地址并正常校验证书：

```bash
curl -fsS https://dbmock.example.com:8080/api/v1/health
```

### 反向代理终止 TLS

保持内置证书变量为空，把 `DBMOCK_PUBLIC_URL` 设置为浏览器访问的 `https://` origin，并将
`DBMOCK_BIND_ADDRESS` 收窄到 `127.0.0.1` 或代理专用网络。HTTPS 公开地址仍会启用 Secure
会话 Cookie 和 HSTS。

应用默认忽略 `X-Forwarded-For`。只有需要记录原始客户端 IP 时，才配置实际能够直接连接应用的
代理 IP/CIDR：

```dotenv
DBMOCK_TRUSTED_PROXIES=10.0.0.10,10.0.1.0/24
```

不要使用 `0.0.0.0/0`、`::/0` 或大于实际代理范围的网段。入口代理必须覆盖客户端自行提交的
同名请求头。

## 5. 持久化与备份边界

Compose 使用两个命名卷：

- `dbmock_postgres_data`：账号、主机、数据库、任务和其他元数据；
- `dbmock_dbmock_data`：凭据主密钥和底层兼容制品。

普通 `docker compose down` 不删除这些卷。不要手工删除应用数据卷：主密钥丢失后，已保存的
SSH 与数据库凭据无法解密。

`deploy/.env`、TLS 证书和私钥不在命名卷内，需要单独备份。仓库仍保留 `make backup` 和恢复脚本
作为升级保护，但没有控制平面备份恢复 Web UI，也不属于数据库日常工作流。归档包含可解密凭据的
主密钥，必须当作秘密保存；恢复会替换平台元数据，只能按脚本说明和变更流程执行。

## 6. 升级

```bash
./scripts/upgrade.sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
make logs
```

升级脚本默认先在 `backups/` 创建控制平面恢复归档，再拉取并启动新镜像。只有已经有独立、经过
验证的恢复副本时，才可以设置 `DBMOCK_SKIP_PRE_UPGRADE_BACKUP=true` 跳过。

正常停止或升级会给运行中的任务最多约 4 分钟收敛和保存状态。强制终止前必须接受任务恢复不完整
的风险；服务重启后在“任务”页面检查 interrupted 或失败任务。

应用迁移只保证向前升级。不要直接把 `DBMOCK_IMAGE` 改回旧版本来降级数据库；需要回滚时使用
升级前整套恢复归档，或先在副本环境验证旧版本能读取当前数据库。

## 7. 日常命令

```bash
# 状态
docker compose --env-file deploy/.env -f deploy/compose.yaml ps

# 应用日志
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 dbmock

# PostgreSQL 日志
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 postgres

# 跟踪应用日志
make logs

# 停止并保留数据卷
make down

# 重新启动
make up
```

不要在未验证备份时执行 `docker compose down -v`。

## 8. 故障排查

### 控制平台无法启动

1. 运行 Compose 配置校验。
2. 查看 `postgres` 是否 healthy，再查看 `dbmock` 日志中的第一个 ERROR。
3. 核对 `DBMOCK_PUBLIC_URL`、PostgreSQL 密码、端口占用和 TLS 文件权限。
4. 若日志提示数据库未就绪，检查 PostgreSQL 日志和命名卷可写性，不要删除卷重试。

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 postgres dbmock
```

### 无法接入目标主机

在目标主机以相同 SSH 用户验证：

```bash
docker version
docker compose version
test -w /opt/dbmock
command -v ss || command -v lsof || command -v netstat
```

同时检查 SSH 网络、端口、账号、密钥权限和主机指纹。Docker/Compose 缺失时先在主机上按公司
标准安装，完成后回到 DB Mock 重新检测。

### 数据库创建失败

- 从任务详情记录失败阶段、稳定错误代码和脱敏日志。
- 镜像拉取失败时，在目标主机验证能否拉取模板声明的公开镜像。
- 资源不足时核对主机当前可用 CPU、内存、磁盘和已有数据库预留。
- 端口冲突时核对实例端口是否落在端口池并被其他进程占用。
- SSH 或 Docker 修复后先重新检测主机，再从带原任务上下文的恢复入口安全重试。
- 响应不确定时不要重复点击；等待页面刷新任务证据。

### 连接信息可见但客户端无法连接

- 核对数据库状态已经运行且健康，不只是创建任务成功。
- 核对交付摘要中的连接地址和端口，而不是 SSH 地址或容器内部端口。
- 检查目标主机防火墙、安全组和客户端到目标主机的网络；DB Mock 不自动开放端口。
- 不把完整 URI 或密码粘贴到日志、工单或公共终端历史中。

### 删除受阻

- 等待活动任务结束后刷新删除审查。
- 如果存在历史托管备份，按弹窗逐项输入备份名称删除后重新审查。
- 如果证据加载失败，先恢复控制平台或主机连接；不要绕过服务端检查手工删除平台记录。
