# 汇途 · Stablecoin Offramp Mock Core

这是已实现、可运行并附测试的**模拟业务核心与技术底座**，不是可接真实资金的生产成品。高保真 Next.js 客户端、运营后台与伙伴中心连接同一 NestJS API；所有服务商适配默认 MOCK，程序不存在真实转账或交易入口。API 在 `NODE_ENV=production`、非 mock 模式或未明确启用演示认证时拒绝启动。真实身份服务接线说明见 `docs/AUTH_INTEGRATION.md`。

## 快速运行

需要 Node.js 22+（本次验证使用 Node.js 24）。所有演示身份、金额和费率均为虚构样例。

```sh
npm ci
cp .env.example .env
# Terminal 1: memory demo, data disappears on restart
set -a; . ./.env; set +a
npm run dev:api
# Terminal 2
npm run dev:web
# Terminal 3: complete mock financial workflow
set -a; . ./.env; set +a
npm run demo
```

浏览器打开 http://localhost:3000 。角色切换只用于本地验证，不是用户登录。单笔付款默认“支付总额（含费用）”：输入 1,000 USDT，扣除 5 USDT 服务费和 2 USDT 渠道费，兑换本金为 993 USDT，按 7.2 客户汇率预计到账 7,149.60 CNY。也可明确切换为“兑换本金（费用另加）”；CSV 的 sourceAmount 始终为本金。演示脚本创建 1,000 USDT 本金订单，另收 5 USDT 服务费和 2 USDT 渠道费，模拟 7,200 CNY 出款、独立对账及 1 USDT 佣金计提；不会充值、兑换或付款。前端从服务端读取报价、订单、白名单、批次与佣金。管理员可点击“创建 MOCK 场景”生成三个关联的服务端样例，也可触发单笔签名模拟入金；浏览器不会获得入金 webhook 签名密钥。

### 本地 PostgreSQL / Redis / Docker 方案

```sh
cp .env.example .env
# Only for an isolated local demo, with no real customer data:
docker compose up --build
# Visit http://localhost:8080
API_URL=http://127.0.0.1:8080/api npm run demo
```

Compose 仅将 Nginx 绑定到 `127.0.0.1:8080`，不对公网发布；PostgreSQL 和 Redis 无宿主端口。环境没有 Docker，因此本次**未执行容器构建或 Compose 联调**。Docker 配置是待目标环境验证的运行配方，不能据此声称已部署。真实环境还必须分离数据库迁移/应用角色、配置 TLS、密钥管理、备份、告警和真实认证。

## 三端统一演示

客户创建报价与订单后，管理员查看的是同一笔服务端订单。经办记录模拟入金，财务登记外部换汇，然后完成经办、复核、出款结果与独立对账；伙伴中心读取由该订单生成的服务费佣金。刷新浏览器不会重置 API 数据，MemoryStore 模式重启 API 才清空。

批量 CSV、白名单与客户审核、退款、对账、佣金结算和审计均使用服务端接口。费率面板只读；邀请注册、真实 KYC、回单文件上传下载和真实付款明确标为未接入，不由前端伪造完成状态。

## 私有在线会话演示

同一 Next.js 客户端可静态导出，由 `sites/worker.ts` 复用相同领域服务提供隔离 MOCK API。它不运行 NestJS、PostgreSQL 或 Redis；每个随机 HttpOnly cookie 仅索引独立的合成会话状态。30 分钟绝对有效期、实例重启或容量淘汰均会清空；不能储存真实客户、账户或交易资料。角色选择只是固定演示角色，不是真实登录。原 NestJS 的生产启动阻断保持不变。

```sh
npm run typecheck:sites
npm run test:sites
npm run build:sites   # sites-dist/client + sites-dist/server/index.js
```

预览的持久化、来源校验、容量限制、重置和发布要求见 `sites/README.md`。构建产物必须由支持 Worker fetch 接口与静态资源绑定的私有宿主部署，不能把在线预览当作 PostgreSQL 部署验证。

## 已实现

- 个人与企业两类简单客户，审核状态；白名单收款人审批；CNY/中国大陆、USD/美国模拟路线
- 金额、汇率、手续费全部为十进制字符串，BigInt 定点计算；USDT/USDC 6 位、法币 2 位、汇率 8 位；明确向下舍入
- 成本汇率、参考汇率、客户成交汇率分开；客户级手续费样例覆盖；报价有效期与版本、佣金归属快照不可覆盖
- 订单级资金，入金、外部换汇登记、出款、回单四组状态独立；不存在客户储值钱包
- Mock webhook 原始字节 HMAC 验签、5 分钟时窗、事件/交易双重幂等；少付、多付、过期入金进入未分配资金差异队列
- 外部换汇结果登记，无交易执行；当前只接受按订单净额分配后的目标币金额，成本/汇差的真实总账归集留待渠道接入
- 人工出款经办/复核分离；请求幂等；未知结果锁定重试，财务提供未付款依据后才可重试
- 回单元数据可在发送后补录，完全独立于出款成功；文件存储适配未配置时拒绝上传和下载，不使用公开桶
- 按币种独立平衡的复式分录、冲正、幂等冲突校验；运行时 PostgreSQL 分录不可修改、不可向已提交凭证补记、反向冲正必须逐项一致
- PostgreSQL 原子事务保存状态、规范化分录、审计和 outbox；BullMQ 仅承载通知事件，不维护资金余额、不执行付款
- CSV 100 行/100KB 限制、逐行校验、公式前缀防护、客户范围与白名单校验、同客户跨批次子项去重
- 部分本金退款（换汇前）与服务费退款（发送后）记录、上限预留、独立审批与幂等记录；退款并不执行链上/银行付款
- 只按已实现服务费计佣；对账后计提，退款负向调整，累计舍入防微额遗漏；月结草稿、独立批准、过期草稿锁定、取消重建
- 默认拒绝授权、客户数据隔离、伙伴端不返回本金/成本/账户信息、敏感字段脱敏审计
- 可运行 Next.js 验证台、NestJS API、健康检查、备份/恢复与异常运行手册

20% 分佣、7 天观察期、费率与路线参数只是 fixture，不代表商业条款已确认。结算只有草稿/批准/取消状态，**没有实际佣金支付功能**。

## 验证

```sh
npm run check       # backend typecheck + domain/API/runtime PostgreSQL tests + reference SQL tests
npm run build       # backend typecheck + optimized Next.js build and frontend typecheck
npm run build:api   # compiled NestJS/worker output
npm run demo        # talks to a separately running local mock API
npm run test:sites  # isolated hosted Worker boundaries and actual bundled execution
npm run build:sites # exported client + standalone hosted mock API
```

测试覆盖精确金额、报价过期、并发幂等、回调验签、入金异常、经办复核分离、未知结果重试阻断、审计/账本不可变、事务回滚、部分退款、佣金舍入、月结取消重建、批量去重、HTTP 授权和数据库约束。测试报告见 `docs/VERIFICATION.md`。

## 目录与实际持久化边界

- `apps/web`：沿用高保真视觉原型的 Next.js 客户端、运营后台与伙伴中心，关键状态连接同一 API；原始视觉原型文件未修改
- `apps/api`：NestJS API、mock 角色入口、outbox/BullMQ worker
- `packages/core`：领域状态机、精确金额、授权、账本、存储适配、服务商接口与测试
- `db-runtime.sql`：**当前 API 真正使用的运行时数据库结构**
- `db/migrations/001_core.sql`：**独立的规范化参考设计**，有 SQL 测试但没有接入 API；不是已集成生产库
- `sites`：短生命周期、逐会话隔离的私有在线 MOCK 适配器与测试
- `docs`：API 合约、架构取舍、运行手册与验收清单

API 的业务聚合当前以 PostgreSQL `runtime.state` 单行 JSON 文档持久化，用行锁串行化写入；资金分录、审计与 outbox 则同步写入受约束的独立关系表。这是优先验证一致性的 mock 实现，吞吐、查询、索引、数据权限和迁移能力不足以支撑真实运营。独立参考结构的字段与状态模型有差异，**必须做显式映射与迁移设计，不能直接把 API 切过去**。详见 `docs/ARCHITECTURE.md`。

## 真实上线前仍须完成

1. 身份服务、客户与后台 MFA/会话/权限、KYC/KYB、制裁与风险审核；真实客户资料生命周期和权限测试
2. 托管、入金链/资产精度、换汇、出款和退款服务商；已验证的银行信息、签名、轮询、重组/撤销、对账导入
3. 根据经营主体、客户、资金路径和实际 CNY/USD 渠道确认资质、合同、隐私、税务与合规边界
4. 替换演示身份；生产认证实现前不得移除启动阻断。配置不接受任意“已准备好”标记绕过此限制
5. 私有对象存储真实上传/查验/恶意文件扫描/下载鉴权，当前仅回单元数据记录
6. 规范化持久化接线、真实 PostgreSQL 多连接竞争/故障/恢复测试，渠道成本/汇差记账及完整退款异常闭环
7. Redis/BullMQ 断线与重复投递测试、端到端告警、灾备演练、渗透与财务验收
8. 确认客户费率、伙伴归属有效期、计佣项目、分佣比例、结算币种/方式以及最低平台留存规则

源码可发布到经授权的代码仓库；代码公开不代表真实金融服务上线。私有在线演示仅承载合成数据，未申请金融账户或配置真实金融凭证。
