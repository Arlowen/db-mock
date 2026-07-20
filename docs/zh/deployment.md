# DB Mock 部署说明

## 前置条件

- 控制平台：Linux x86_64/arm64 或安装了 Docker Desktop 的 macOS。
- Docker Engine 24+ 与 Docker Compose v2；至少 2 CPU、4 GB 内存、20 GB 可用磁盘。
- 默认监听 `0.0.0.0:8080`。浏览器和控制平台容器需要能够访问被管理主机的 SSH 端口。
- 被管理 Linux 主机需支持 SSH 直连；由平台安装/升级 Docker 时，SSH 用户必须具备免密 `sudo`。
- Linux Docker daemon 代理可在主机页面配置后点击“Apply Docker proxy”；macOS 代理需先在 Docker Desktop 中配置。

## 在线安装

在源码仓库根目录执行：

```bash
cp deploy/.env.example deploy/.env
# 编辑 deploy/.env，必须更换 DBMOCK_POSTGRES_PASSWORD 和公开访问地址
make up
```

也可运行 `./scripts/install.sh` 自动生成 PostgreSQL 随机密码并启动。首次打开
`DBMOCK_PUBLIC_URL` 后，页面会要求创建第一个平台账号。

应用容器同时提供 API 和内嵌 Web 页面，Compose 中只有 DB Mock 与 PostgreSQL 两个服务，
不需要 Nginx 或独立前端容器。

## 离线安装

在可以访问镜像仓库且安装了 Docker 的机器上制作 x86_64 离线包：

```bash
./scripts/package-offline.sh v0.1.0 amd64
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

## HTTPS

默认由 Go 服务直接提供 HTTP。若启用 HTTPS，把证书与私钥放入 `deploy/tls/`，并在
`deploy/.env` 中配置容器内路径：

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

重新执行 `make up`。证书和私钥必须同时配置。

## 升级和运维

```bash
./scripts/upgrade.sh
make logs
curl -fsS http://127.0.0.1:8080/api/v1/health
```

PostgreSQL 数据、主密钥和上传镜像分别保存在 Compose 命名卷中。平台没有内置元数据
备份功能；不要手工删除 `dbmock_postgres_data` 或 `dbmock_dbmock_data`。主密钥丢失后，
已保存的 SSH、仓库和数据库凭据无法解密。

DB Mock 不会自动修改防火墙或云安全组。数据库实例端口必须在目标主机端口池中，并由
运维人员按网络策略开放。
