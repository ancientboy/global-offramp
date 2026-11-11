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

浏览器打开 http://localhost:3000。客户、商家管理员、推广伙伴是三个业务入口；商家端固定使用 `admin-demo` 模拟身份，一个管理员完成审核、记录付款、补回单、异常处理、退款登记和佣金结算登记，无需切换经办/复核/财务身份。固定身份不是实际登录。旧经办/复核接口保留兼容测试，不是当前推荐操作流程。

客户默认输入目标法币出款金额，也可切换稳定币支付总额。以虚构费率为例，100,000 CNY、7.2 CNY/USDT、5 + 2 USDT 固定费用，需要 13,895.888889 USDT；50,000 USD、0.995 USD/USDT 同样费用需要 50,258.256282 USDT。反算本金向上取到 6 位，前向验证法币金额精确匹配。目标金额指登记的出款金额，并非保证收款银行扣费后的净到账。CSV 的 sourceAmount 继续表示本金。

订单建立后展示独立的资金转入步骤、币种、所需金额和有效期。当前 `payable=false`、地址为 null、网络为 MOCK，没有可转币地址或钱包二维码；必须接入受审查的托管服务后才能收真实资金。报价接受期限与订单 30 分钟模拟入金期限分开，在线会话也可能更早失效。

管理员使用模拟入金后，官方自营模拟单核对收款人、金额和执行方即可确认完成，服务器生成内部 MOCK 记录，备注选填；旧线下人工登记保留实际金额、付款时间、真实外部流水和说明，也可记录“结果未知”。这只是管理员对线下处理结果的登记，不执行付款，也不是银行核验。已付款可先完成，付款截图/水单稍后补传；回单上传不会改变付款事实或自动完成对账。

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

客户和商家管理员查看同一服务端订单。标准流程为：客户报价下单 → 模拟入金 → 管理员登记付款结果 → 订单完成并计提佣金 → 可选补回单；异常或历史待复核记录另行处理。审计区分管理员自证与独立核验，单管理员确认不标成银行验证。未知结果锁定，不允许直接重复付款；核实未付款且留下依据后才允许重试。

回单支持 PNG/JPEG/PDF，每份最多 2 MiB。新原件存于私有 R2，D1 保存元数据与关联；默认仅管理员读取。单客户脱敏副本须显式确认后发布给所属客户；同一公司商户的整批原件可在管理员选择实际已提交批次并确认归属后发布，已有跨商户或跨批次关联一律拒绝。PNG/JPEG 使用本站自托管 Tesseract.js 在浏览器本地实际识别，PDF 暂只存储。识别与匹配不证明真实付款，均须人工确认；不向外部 OCR 服务传图。仅上传有权处理的凭证，不上传密码或完整证件。无 DB 的临时预览附件随会话失效丢失。

运营费率支持模拟基准、管理员加减调整、预览与版本发布；新报价应用新值，旧快照不变。邀请注册、真实 KYC、真实托管与付款、生产私有文件存储和实际佣金支付尚未接入。

## 私有在线会话演示

同一 Next.js 客户端可静态导出，由 `sites/worker.ts` 复用相同领域服务提供隔离 MOCK API。它不运行 NestJS、PostgreSQL 或 Redis。配置 D1 后，按 Sites 网关注入的已认证用户 ID 保存隔离虚构历史，跨浏览器会话和实例重启保留；不接受缺失身份写入。状态采用乐观版本事务和不可变记录校验。总状态/元数据 1 MiB，新回单通过 BUCKET 私有 R2 单独保存，每份 2 MiB、元数据最多 500 项（可能先达到 1 MiB）；旧内嵌回单限 256 KiB，满额时保留原数据并停止新增，关闭重置。未绑定 DB 的本地预览仍使用随机 HttpOnly cookie 临时状态，30 分钟或实例重启失效。旧临时会话无法迁移或恢复。订单/钱包仅用虚构数据；凭证须有权处理且不公开。角色选择仍只是固定演示角色，不是生产权限体系。原 NestJS 生产启动阻断保持不变。

```sh
npm run typecheck:sites
npm run test:sites
npm run build:sites   # sites-dist/client + sites-dist/server/index.js
```

预览的持久化、来源校验、容量限制、重置和发布要求见 `sites/README.md`。构建产物必须由支持 Worker fetch 接口与静态资源绑定的私有宿主部署，不能把在线预览当作 PostgreSQL 部署验证。

## 已实现

- 个人与企业两类简单客户，审核状态；保存收款人后自动字段校验立即可用；CNY/中国大陆、USD/美国模拟路线
- 金额、汇率、手续费全部为十进制字符串，BigInt 定点计算；USDT/USDC 6 位、法币 2 位、汇率 8 位；前向报价向下取法币分，反向目标报价向上取稳定币最小单位
- 成本汇率、参考汇率、客户成交汇率分开；客户级手续费样例覆盖；报价有效期与版本、佣金归属快照不可覆盖
- 演示客户钱包与订单级资金兼容；冻结、消费、释放使用精确账本，入金、换汇登记、出款、回单状态独立
- Mock webhook 原始字节 HMAC 验签、5 分钟时窗、事件/交易双重幂等；少付、多付、过期入金进入未分配资金差异队列
- 外部换汇结果登记，无交易执行；当前只接受按订单净额分配后的目标币金额，成本/汇差的真实总账归集留待渠道接入
- 单管理员登记线下付款；请求幂等、金额/时间/流水校验；未知结果锁定，核实未付款依据后才可重试；保留旧双人流程接口
- 回单可在付款后补传；Sites R2 私有原件库支持多附件、批量、本地 OCR、人工关联和显式脱敏副本发布
- 按币种独立平衡的复式分录、冲正、幂等冲突校验；运行时 PostgreSQL 分录不可修改、不可向已提交凭证补记、反向冲正必须逐项一致
- PostgreSQL 原子事务保存状态、规范化分录、审计和 outbox；BullMQ 仅承载通知事件，不维护资金余额、不执行付款
- CSV 100 行/100KB 限制、逐行校验、公式前缀防护、客户范围与白名单校验、同客户跨批次子项去重
- 部分本金退款（换汇前）与服务费退款（发送后）记录、上限预留、管理员确认与幂等记录（旧双人身份接口仍保留）；退款并不执行链上/银行付款
- 只按已实现服务费计佣；确认完成后幂等计提，退款负向调整，累计舍入防微额遗漏；月结草稿、管理员批准、过期草稿锁定、取消重建
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
5. 生产文件恶意内容扫描、完整保留/删除策略、备份恢复和真实多租户身份系统；Sites 演示已接入私有 R2 文件与下载鉴权
6. 规范化持久化接线、真实 PostgreSQL 多连接竞争/故障/恢复测试，渠道成本/汇差记账及完整退款异常闭环
7. Redis/BullMQ 断线与重复投递测试、端到端告警、灾备演练、渗透与财务验收
8. 确认客户费率、伙伴归属有效期、计佣项目、分佣比例、结算币种/方式以及最低平台留存规则

源码可发布到经授权的代码仓库；代码公开不代表真实金融服务上线。私有在线演示仅承载合成数据，未申请金融账户或配置真实金融凭证。

新回单资料库 API 目前由 Sites Worker 提供，不在旧 Nest 本地开发适配器上运行。OCR 资源由 npm 锁版本依赖在 prebuild 阶段生成，不提交用户样例。
