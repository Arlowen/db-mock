# DB Mock 部署说明

## 前置条件

- 控制平台：Linux x86_64/arm64 或安装了 Docker Desktop 的 macOS。
- Docker Engine 24+ 与 Docker Compose v2；至少 2 CPU、4 GB 内存、20 GB 可用磁盘。
- 默认监听 `0.0.0.0:8080`。浏览器和控制平台容器需要能够访问被管理主机的 SSH 端口。
- 被管理 Linux 主机需支持 SSH 直连；由平台安装/升级 Docker 时，SSH 用户必须具备免密 `sudo`。
- 被管理主机的 SSH 用户必须能够创建配置的数据根目录并在其中读写文件。
- 被管理主机需安装 `ss`、`lsof` 或 `netstat` 中至少一个工具，用于验证端口池并避开已有监听端口。
- Linux Docker daemon 代理可在主机页面配置后点击“Apply Docker proxy”；macOS 代理需先在 Docker Desktop 中配置。

## 在线安装

在源码仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，必须更换 DBMOCK_POSTGRES_PASSWORD 和公开访问地址
make up
```

也可运行 `./scripts/install.sh` 自动生成 PostgreSQL 随机密码并启动。脚本优先拉取
`ghcr.io/arlowen/db-mock:latest`；尚未发布镜像或镜像不可用时，会从当前源码检出构建应用镜像。
首次打开 `DBMOCK_PUBLIC_URL` 后，页面会要求创建第一个平台账号。

`DBMOCK_TIMEZONE` 是首次初始化使用的 IANA 时区默认值。创建首个账号后，请在“系统设置”中调整时区；
该运行时设置会立即统一影响审计、任务、告警和监控时间展示，无需重启服务。

进程级配置采用严格校验：时长使用 Go duration 格式（例如 `720h`），任务并发数必须在
`1-32`，上传硬上限必须在支持范围内。无法解析或超出范围的值会让应用拒绝启动，并在日志中
指出具体变量名，不会静默退回默认值。`DBMOCK_PUBLIC_URL` 必须是浏览器实际访问的单个
HTTP/HTTPS origin，不能包含账号、路径、查询参数或片段。

应用容器同时提供 API 和内嵌 Web 页面，Compose 中只有 DB Mock 与 PostgreSQL 两个服务，
不需要 Nginx 或独立前端容器。

## 离线安装

每个版本的 GitHub Release 提供 `amd64`、`arm64` 两个离线包及顶层 `SHA256SUMS`。
也可以在能够访问镜像仓库且安装了 Docker 的机器上自行制作对应架构的离线包：

```bash
./scripts/package-offline.sh v0.1.0 amd64
./scripts/package-offline.sh v0.1.0 arm64
```

将 `dist/dbmock-v0.1.0-linux-amd64-offline.tar.gz` 复制到离线控制平台，解压后运行：

```bash
tar -xzf dbmock-v0.1.0-linux-amd64-offline.tar.gz
cd dbmock-offline
./offline-install.sh
```

离线包是独立的扁平目录，包内的 `compose.yaml`、`.env.example` 和安装脚本都位于
解压目录根部，不使用源码仓库的 `deploy/` 路径。

离线包只包含控制平台和 PostgreSQL 镜像。数据库镜像通过平台的“镜像与仓库”页面上传
`docker save` 生成的 `.tar`、`.tar.gz` 或 `.tgz` 文件。
安装和离线升级会先校验包内镜像的 SHA-256，再使用 `--pull never --no-build` 启动，
保证离线机器不会意外访问仓库或尝试从缺失的源码构建镜像。

## HTTPS

默认由 Go 服务直接提供 HTTP。若启用 HTTPS，把证书与私钥放入 `deploy/tls/`，并在
`deploy/.env` 中配置容器内路径：

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

重新执行 `make up`。证书和私钥必须同时配置，公开地址必须使用 HTTPS；应用会在连接
PostgreSQL 和启动后台任务前读取并校验证书/私钥是否匹配。
证书目录必须允许容器内的 `dbmock` 用户进入，证书与私钥必须可读；在 Linux 上该用户的
固定 UID/GID 为 `100:101`，可将私钥保留为仅所有者和该组可读。容器健康检查与灾备恢复
探针会自动改用内部 HTTPS，并仅在容器内部探针中跳过主机名校验。

也可以由反向代理终止 TLS。此时保持 `DBMOCK_TLS_CERT_FILE` 和 `DBMOCK_TLS_KEY_FILE`
为空，把 `DBMOCK_PUBLIC_URL` 设置为浏览器访问的 `https://` origin，并让代理保留原始
`Host`。建议同时把 `DBMOCK_BIND_ADDRESS` 设置为 `127.0.0.1` 或只允许代理访问的私网地址。
无论 HTTPS 在应用还是代理处终止，HTTPS 公开地址都会启用 Secure 会话 Cookie 和 HSTS。

应用默认忽略所有 `X-Forwarded-For`，并把直接连接方记录为会话和审计来源 IP。只有需要
保留真实客户端 IP 时，才在 `deploy/.env` 中配置能够直接连接应用的代理 IP 或 CIDR：

```dotenv
DBMOCK_TRUSTED_PROXIES=10.0.0.10,10.0.1.0/24
```

应用只接受这些可信连接方提供的 `X-Forwarded-For`，并从右向左越过连续可信代理；多级代理
链中的每一跳都必须列入配置。让入口代理覆盖来自公网的同名请求头，后续代理按标准追加地址。
应用会拒绝 `0.0.0.0/0` 和 `::/0`；也不要配置超出代理实际网段的地址范围。当前不读取
`Forwarded` 或 `X-Real-IP`。

## 升级和运维

```bash
./scripts/upgrade.sh
make logs
curl -fsS http://127.0.0.1:8080/api/v1/health
```

上面的健康检查命令适用于默认 HTTP；内置 TLS 部署应使用公开 HTTPS 地址并让 `curl` 按
生产 CA 链校验证书，例如 `curl -fsS https://dbmock.example.com:8080/api/v1/health`。

升级脚本默认先把当前控制平面备份到 `backups/`，成功后才拉取并启动新版本。仅在已经通过
其他方式确认存在可恢复副本时，才可显式设置 `DBMOCK_SKIP_PRE_UPGRADE_BACKUP=true` 跳过。

正常停止或升级时，Compose 最多保留 4 分钟让正在执行的数据库任务完成恢复动作并持久化
中断状态。只有在确认可以承担未完成恢复的风险时才强制终止控制服务；重新启动后应在
“任务”页面检查并重试标记为“已中断”的操作。

登录后可在“系统设置”中调整监控采集间隔、指标保留时间、磁盘阈值以及各类告警开关；
配置在下一轮监控生效，无需重启。SSH 密码或私钥被目标主机拒绝时会产生独立告警，更新
主机凭据并重新检测成功后由系统自动解决。

离线镜像的运行时单文件上限和浏览器分片大小也在“系统设置”中调整，对新建上传任务
立即生效。`DBMOCK_MAX_UPLOAD_BYTES` 是部署级硬上限，页面中的单文件上限不能超过它；
进行中的断点上传继续沿用创建时已接受的文件总大小。

“镜像”页面可按 7 至 365 天扫描未使用的离线归档，预览候选数量和预计释放空间后手动
选择清理。平台只清理没有被现有实例引用、且在所选时间内没有实际分发记录的控制端文件；
不会自动删除目标主机上已经由 Docker 加载的镜像。

### 控制平面备份与恢复

PostgreSQL 元数据、主密钥和上传制品位于 Compose 命名卷中。使用以下命令创建一致备份：

```bash
make backup
# 或指定输出文件
./scripts/backup-platform.sh /secure/path/dbmock-control-plane.tar.gz
```

备份期间应用会短暂停止以冻结写入；如果整套服务原本已停止，脚本只临时启动 PostgreSQL，
结束后恢复停止状态。归档以 `0600` 创建，包含可解密全部已保存凭据的主密钥，必须立即复制
到控制机之外的受限存储。生产环境建议使用独立口令文件加密，并与归档分开保存：

```bash
openssl rand -base64 32 > /secure/path/dbmock-backup.pass
chmod 600 /secure/path/dbmock-backup.pass
DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  ./scripts/backup-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc
```

先做只读校验，再执行恢复：

```bash
DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  DBMOCK_RESTORE_VALIDATE_ONLY=true \
  ./scripts/restore-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc

DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  DBMOCK_RESTORE_CONFIRM=RESTORE \
  ./scripts/restore-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc
```

恢复会完全替换当前 PostgreSQL 数据库和应用数据卷。脚本在覆盖前自动创建
`dbmock-control-plane-pre-restore-*` 安全备份，恢复当前版本应用并等待健康检查；任一步失败
都会尝试自动回滚。成功后仍保留安全备份，确认业务数据无误后再按组织策略归档或删除。
在离线包解压目录中，备份和恢复脚本位于根目录，分别使用 `./backup-platform.sh` 和
`./restore-platform.sh`，其余参数与环境变量相同。
归档不包含 `deploy/.env`、TLS 证书或私钥；灾备存储中应另行保存这些部署配置。不要手工删除
`dbmock_postgres_data` 或 `dbmock_dbmock_data`，主密钥丢失后已保存凭据无法解密。

DB Mock 不会自动修改防火墙或云安全组。数据库实例端口必须在目标主机端口池中，并由
运维人员按网络策略开放。
