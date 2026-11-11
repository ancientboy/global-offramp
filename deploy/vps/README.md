# 独立服务器演示部署

复用已构建的 `sites-dist`，通过固定版本 Miniflare/workerd 在本机运行原有 Worker；D1/R2 接口的数据落在服务器 `/var/lib/global-offramp`。这是自托管模拟演示，未连接 Cloudflare 云端数据库或支付渠道。

`npm ci` 安装本目录依赖。运行 `server.mjs` 前配置 `APP_ROOT`、`PUBLIC_ORIGIN`、`DATA_DIR`、`HOST`、`PORT` 和 `AUTH_FILE`。默认拒绝缺失认证配置；仅在用户明确选择公开演示时设置 `PUBLIC_DEMO=true`，该模式所有访客共享同一个模拟数据空间。

认证文件是 JSON：`username`、密码 SHA256 的 `passwordHash`、稳定的 `ownerId`。代理不接受客户端提交的身份头，而在验证访问密码后注入本地固定身份。演示角色选择仍不代表独立后台权限。认证文件、明文访问凭据和运行数据不可提交 Git。

systemd 单元仅允许写入数据目录。Caddy 使用现有 HTTPS 证书，将指定域名转发至 Docker 网桥地址上的网关端口；其余域名路由保持原状。内部 workerd 仅监听回环地址。

升级时保留认证身份和数据目录；备份数据时先停止本服务以保证 SQLite 及附件一致，再启动。原 Sites 历史数据不在此仓库内，未自动迁移。
