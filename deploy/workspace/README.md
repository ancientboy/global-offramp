# 第一阶段：独立账号入口（内测 / 资金沙箱）

本阶段提供可运行的自托管账号及 PostgreSQL 接线，不是正式资金系统验收。未接入邮件验证、找回密码、MFA、真实 KYC、付款、收币或换汇。没有默认管理员、默认口令或自动输出的登录 Token。

## 路由与数据边界

- `/`、`/api/*` 继续使用既有 `deploy/vps/server.mjs` + Miniflare/D1/R2 公开免登录演示；旧数据不迁移、不重置。
- `/workspace` 是独立注册/登录页面；`/workspace/api/*` 由新的 Node 服务直接连接 `pg`，账号接口不通过 Miniflare。网页复用现有布局、客户/管理员工作台、回单库及本地 OCR。
- 必须使用**独立 PostgreSQL 数据库**及独立私有回单目录。启动拒绝未迁移或含不绑定账号的旧演示客户的数据库。业务数据不读 D1，业务身份不读演示角色或 cookie。
- cookie `__Secure-offramp-workspace` 仅在 `/workspace/api` 路径发送，HttpOnly / Secure / SameSite=Strict；会话绝对有效期8小时，只存 SHA256 摘要；每次请求检查账号 enabled、过期和吊销。注销会吊销数据库会话。身份头被忽略，身份只来自服务端关系表。
- 注册严格字段白名单，仅允许个人/企业普通客户，随机客户ID，默认 `pending`；管理员CLI创建，管理员审核后客户可保存收款人/报价。客户不能读写其他客户，也不能读回单原件，只能下载管理员明确发布给自己的脱敏副本。分享前仍须管理员核实文件已脱敏；系统不自动脱敏、不扫描恶意软件。
- demo seed/reset/deposit、wallet deposit、mock-payout、manual-payout、complete-recorded-payment，以及执行/退款/对账等付款结果命令均未开放，管理员也不能调用。余额默认零。新增账号可查看资料及审核状态；审核后可测试收款人和报价。钱包UI无法在零余额下完成付款，是资金关闭的预期行为。回单库支持上传/识别；新未付款订单不可关联付款回单，合法历史沙箱订单的回单访问另有权限测试。

## 安全和事务

密码使用随机盐 scrypt N=32768,r=8,p=1，32字节结果；每进程最多4个哈希任务。登录限速在数据库共享：每邮箱10次/15分钟，每IP30次/15分钟；注册每IP5次/小时；全部API每IP300次/分钟。计数包括成功请求，不随进程重启清空，也可能导致临时拒绝服务，仍需后续监控和调优。所有写请求要求同源 Origin、JSON，拒绝跨站 Fetch Metadata；代理不能放宽或代填浏览器 Origin。

`workspace.accounts/customers/sessions/auth_audit/rate_limits` 使用关系表。注册使用 `PostgresStore.transactionWithClient` 在同一数据库连接事务内创建账号关系、业务客户、业务审计及认证审计；重复邮箱、状态写失败均回滚，不遗留孤立客户。登录的会话+审计、注销的吊销+审计也各自同事务。失败登录只记录邮箱摘要，不记录密码、原始IP或会话Token。认证审计有数据库禁止更新/删除触发器。

**业务未全量规范化**：业务客户状态、收款人、报价、订单、批次及回单元数据等仍在 `runtime.state` JSONB 单行聚合，串行行锁；`runtime.journals/ledger_lines/audit/outbox` 同事务镜像。沿用 core append-only 检查、SQL账本平衡、封账和禁止账本/审计重写约束；应用角色不可拥有表或DDL。聚合完整语义依赖应用，直接SQL修改 state 没有全量规范化约束保证。`db/migrations/001_core.sql` 是后续目标，不能宣称业务已经接入其全部关系表。

后续迁移：冻结/版本化聚合 → 映射客户/收款人/报价/订单及回单授权 → 双写同事务核对金额与快照 → 按客户行锁、外键及唯一约束切换读写 → 只读保留旧聚合。迁移前须做故障恢复、并发幂等、账务独立核对和真实PG角色权限验收。

文件先写私有目录再提交元数据：内容摘要键、0600文件、0700目录，读取复核摘要。数据库失败可能留下未引用对象，**不会自动删文件**。中断写入可能产生损坏孤儿，需管理员离线核查，不能擅自清理。目录不得在静态资源根下。文件只有通过应用权限检查才能下载；文件与数据库需成套一致备份。建议维护窗口暂停写入后快照，本次没有执行备份、停止或部署。沿用500份回单上限、每份2MiB、每请求3MiB；OCR在浏览器本地执行。

## 构建与检查

Node >=22；依赖已在根 package-lock 中，无需身份供应商或付费调用。

```sh
npm ci
npm run typecheck
npx tsc --noEmit -p apps/web/tsconfig.json
npm run typecheck:sites
npm run test:workspace
npm test
npm run test:sites
npm run test:db
npm run build:workspace
npm run build:sites
```

`build:sites` 一起导出 `/` 和 `/workspace`，沿用公共演示的静态 `_next` 资源。不要混用不同构建的 html/chunks。`build:workspace` 生成独立 Node 入口 `dist/apps/workspace/src/main.js`；它复用命令适配器代码，但不依赖 Miniflare 运行账号或业务API。

开发可同时运行 `npm run dev:workspace` 和 `npm run dev:web`。WORKSPACE_ORIGIN 必须是浏览器实际HTTPS来源，开发需本地HTTPS代理，cookie不会为了HTTP开发降低安全设置。Next 的业务API rewrite 指向 WORKSPACE_INTERNAL_URL，默认127.0.0.1:4182。独立服务用 `npm run start:workspace` 启动。

自动测试用 PGlite 执行 PostgreSQL SQL、事务及磁盘关闭重开，不能替代服务器真实 PostgreSQL、网络、TLS、systemd、备份和应用角色权限的独立验收。

## 指挥官部署步骤（本次未执行）

1. 保留公共演示服务、原D1/R2目录；准备独立数据库 offramp_workspace、无超级权限应用角色、独立迁移所有者及仅服务用户可写的私有目录。使用 workspace.env.example，真实配置放服务器私有环境文件，不能进Git/日志。远程PG须证书校验，不能关闭校验。
2. 迁移所有者设置 WORKSPACE_MIGRATION_DATABASE_URL，在仓库根运行 `npm run workspace:migrate`，或 `node dist/apps/workspace/src/cli.js migrate`；只将 db-runtime.sql 和 002_workspace.sql 应用到新库。用 psql 的 app_role 变量执行 grants.sql。应用角色不能拥有表、DDL、DELETE/TRUNCATE 权限，也不能继承所有者。不要给服务注入迁移凭据。grants.sql 用于全新专用角色，不会撤销角色此前被额外授予的危险权限，必须核对。
3. 同一版本构建，保留旧制品以便回退；安装独立 systemd 样例并按真实目录和Node路径调整。环境文件只放应用数据库URL，不放迁移URL。新服务只监听127.0.0.1:4182，不覆盖原4181演示进程。
4. 仅给既有HTTPS站点新增业务路径匹配，其余保留原代理。宿主机 Caddy 示意：

   ```caddyfile
   @workspace path /workspace /workspace/*
   handle @workspace {
       reverse_proxy 127.0.0.1:4182 {
           header_up X-Real-IP {remote_host}
       }
   }
   # 既有公开演示 handle / reverse_proxy 保留
   ```

   Caddy若在Docker，容器127.0.0.1不是宿主机；指挥官须结合现有网络使用受保护的 host-network/同网络代理方案，不能为了可达把账号服务直接裸露公网。限速默认按连接来源；只有受信回环代理覆盖 X-Real-IP 时才开启 WORKSPACE_TRUST_LOOPBACK_PROXY，否则访客共享代理IP限速。/_next/*、品牌图片及OCR模型继续由同一次静态构建的公开演示服务提供，不含账号数据。代理不得缓存 /workspace*，不得添加跨站CORS许可。
5. 用真实PG应用角色独立验收：迁移、注册事务失败恢复、客户A/B及管理员隔离、demo/mock完成路径被拒绝、cookie属性、CSRF、注销/过期/吊销、账本/审计 UPDATE/DELETE/TRUNCATE/封账追加均失败、服务重启后账号/会话/业务保留；再次验证 / 免登录、原演示API、资料库及OCR。真实资金始终关闭。
6. 回退只撤去新增业务路径并停止**新**服务，保留PG及回单数据；不要清理数据、修改原演示身份或重置演示。

## 管理员初始化与撤销

管理员仅由本地CLI创建，CLI不接受邮箱/密码参数，密码不进argv、环境变量或日志。从操作员终端隐藏输入，通过 stdin 传JSON：

```sh
python3 deploy/workspace/admin-input.py | npm run workspace:create-admin
# 编译部署：
python3 deploy/workspace/admin-input.py | node dist/apps/workspace/src/cli.js create-admin
```

输入脚本把提示写到stderr，stdout仅包含给CLI的JSON。首次创建不返回会话Token，管理员自行在 /workspace 登录。不要用含真实密码的echo、shell参数或仓库JSON。重复邮箱拒绝，不会将客户升级成管理员，管理员另选邮箱。

没有网页角色提升或任意账号管理API。暂停账号/撤销全部会话由授权数据库管理员在同一事务中更新 accounts.enabled=false、标记对应 sessions.revoked_at，并向 auth_audit 追加审计；应用本身没有更新 enabled 的权限。此阶段不自动清理会话、限速键或审计，容量监控/归档待后续设计，审计不可删除。未验证邮箱只是登录标识，不能作为外部付款授权或身份认证证据。



## 本次集成调整

- 管理员使用用户名+密码，不要求邮箱；普通客户注册使用邮箱（尚未验证）。CLI输入为 `{username,name,password}`，不得预置或输出密码。
- `/workspace/api/routes` 提供USDT/USDC至CNY/USD/EUR/MXN/BRL/GBP的12条草稿路线；管理员可保存汇率、手续费、出款限额、线下合作方和处理说明。草稿有乐观版本锁与审计，不修改既有报价或开启资金功能。
- `/workspace/api/routes/:id/validate-recipient` 按路线验证基础格式，返回脱敏结果，不保存原始账号。没有真实性或账户归属核验。
- 现有沙箱订单/报价引擎仍只支持CNY/USD；六币种真实业务的核算、渠道和资金流程尚需后续接线，不能仅凭目录存在即宣称全部开通。
- 额外迁移为 `003_route_drafts.sql`，通过同一个workspace迁移命令安装。
- 本机Caddy运行在Docker时，服务可显式绑定172.18.0.1；`WORKSPACE_TRUSTED_PROXY_IP`仅填写该Caddy容器的真实IP。Caddy必须覆盖X-Real-IP。其他来访者传入的IP头均不可信。

## 已部署运行与验收

业务入口 https://bhcbtc.club/workspace。公开演示 / 与 /api 继续免登录，不共享业务库。应用 PostgreSQL 连接127.0.0.1:55432，数据库容器 global-offramp-business-postgres；业务服务 global-offramp-workspace.service。服务目录 /opt/global-offramp/business/current；私有环境文件在 /etc/global-offramp/business，仅root读取。不在文档放置登录密码或数据库密钥。

每6小时备份数据库和不可变回单到 /var/backups/global-offramp/business。已实际执行新库恢复并核对回单SHA256，随后仅删除本次临时恢复库。备份在同一服务器，未配置异地副本或自动清理策略。

服务器日志仅用于进程错误，不输出会话或密码。依赖仍需持续更新、漏洞跟踪和独立安全审查；当前账号内测不等于真实金融业务验收。测试账户标注为部署验收，不冒充真实客户。

## 运维创建的用户名客户

迁移004允许运维为普通客户配置用户名，无需编造邮箱。公开注册仍只接受客户邮箱，并拒绝自选角色和用户名。登录验证已有密码；新注册的创建策略与登录校验分开。运维修改密码须在同一数据库事务中更新哈希、撤销该账号已有会话并写认证审计，不将明文写入代码、日志或Git。

### 自动参考汇率与六币种报价

工作台从 ECB 日参考价计算 USD 对 CNY、USD、EUR、MXN、BRL、GBP 的交叉汇率，并结合 Kraken 的 USDT/USD、USDC/USD 买卖价中值生成 12 组参考价。启动时获取，之后每 15 分钟更新；30 分钟未更新则暂停新报价。ECB 日期允许最多 7 天，覆盖休市日。金额和汇率使用整数定点计算，历史报价保留原有锁价快照。自动更新保留运营设置的手续费和各路线调整。

管理后台可刷新参考汇率并调整六种币种的客户定价。`005_multi_fiat.sql` 扩展账本币种检查，保留不可修改、分币种平衡和法币两位小数约束。VPS 网关通过内部服务绑定读取同一公开参考快照，供已有公开工作台同步定价。

`WORKSPACE_ENABLE_SIMULATED_TOPUPS=true` 仅启用测试余额充值，默认关闭；启用后仍执行账户归属、同源和幂等校验，不开启真实转账。
