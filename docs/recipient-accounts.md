# 收款账户绑定

按本地收款方式收集完整资料，用户只看到对应方式需要的字段。这里只做格式、国家匹配和校验位检查；未接入银行账户归属、账户存续状态或 Pix DICT 在线核验。

|地区 / 币种|收款方式与字段|
|---|---|
|中国 / CNY|账户持有人、银行、完整账号、开户支行、省份、城市|
|美国 / USD|本地 ACH：账户持有人、银行、9位 ABA 路由号、完整账号、checking/savings、街道、城市、州、邮编|
|欧元区 / EUR|账户持有人、收款国家、IBAN；BIC / SWIFT 选填|
|墨西哥 / MXN|账户持有人、18位 CLABE|
|巴西 / BRL|银行账户：账户持有人、银行名称、COMPE / ISPB、分行号、含校验位的账号、账户类型、CPF / CNPJ；或 Pix：账户持有人、密钥类型及完整密钥|
|英国 / GBP|账户持有人、6位 Sort code、8位账号；或 GB IBAN，BIC 选填|

依据：
- [中国银行境内人民币汇款字段](https://pic.bankofchina.com/bocappd/pbservice/202107/P020210723329842714469.pdf)
- [USD 本地收款字段](https://wise.com/help/articles/2932150/guide-to-usd-transfers)
- [GBP 本地收款字段](https://wise.com/help/articles/2932148/guide-to-gbp-transfers)
- [Swift IBAN Registry](https://www.swift.com/standards/data-standards/iban-international-bank-account-number)
- [墨西哥央行 CLABE](https://www.banxico.org.mx/footer-es/preguntas-frecuentes-dudas-ba.html)
- [巴西本地银行账户字段](https://wise.com/help/articles/2932353/guide-to-brl-transfers)
- [巴西央行 Pix / DICT](https://www.bcb.gov.br/estabilidadefinanceira/dict)
- [巴西税务机关 CNPJ 字母数字校验位](https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj/manual-dv-cnpj.pdf)

这些是已支持的本地方式，不能据此推断已支持全部跨境 SWIFT 渠道。后续签约渠道新增必填项时，应扩展方式表单及服务器校验，不在所有用户页面堆放说明。

完整字段由服务器规范化后用 AES-256-GCM 加密，存入现有事务状态，AAD 绑定客户、币种、国家、账户令牌和方式。密钥由 `WORKSPACE_RECIPIENT_KEY_FILE` 指向的32字节私有文件提供，不进入仓库、前端或日志；文件应仅由 root 与 workspace 服务组读取，并单独备份，后续升级必须保留同一密钥。

列表和普通 dashboard 只返回姓名、银行、尾号、方式与完整状态；完整值仅向账户所有者、管理员及已分配订单的服务商详情开放，响应禁止缓存。推广伙伴不具备收款资料读取权限。历史尾号账户保留，不从尾号推造完整资料；用户通过重新绑定建立完整的新账户。

付款时间输入保留毫秒，以服务器时间为基准，在本地时区显示及编辑，再转回 UTC 提交。服务器继续拒绝早于下单时间或晚于允许范围的付款时间。
