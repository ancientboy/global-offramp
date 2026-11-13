# 汇途 / HUITU — FLOW 品牌落地

用户于 2026-11-13 在飞书选择方案 A（FLOW）。名称继续沿用“汇途 / HUITU”。品牌目标是提高识别度，并让用户、运营、服务商、推广伙伴各端保持一致。

## 视觉规范

- 主标识：带负形前进通道的 H 形交织路径；采用完整图像标识，不用临时字体或字符代替定制字标。
- 主色：墨色 `#0e2631`、品牌青绿 `#049a88`、亮柠 `#d1ed70`。
- 操作色：`#087f73` 与白字搭配；亮柠主要用于墨色背景上的关键操作和选中状态。
- 页面底色：浅灰绿 `#f4f6f2`；卡片保持白底、细边框和轻阴影。
- 字体：沿用系统中文字体与现有 Inter 回退栈，强调标题和数字层级；不引入外部字体请求。
- 尺寸：桌面侧栏 238px，卡片圆角 14–19px，表单控件 43–49px。手机登录输入框使用 16px 字号，避免 iOS 聚焦自动放大。

## 最终资产与提示词

以下资产均由内置 ImageGen 生成，原始生成结果保留在生成目录。最终版本已复制至项目，不引用外部临时路径。透明白字版本出现边缘杂点后已弃用，深色版本采用完整墨色底图并在页面中作轻量混合呈现。

| 文件（相对 apps/web/public/brand） | 使用位置 | 最终生成提示要点 |
| --- | --- | --- |
| `flow-logo-light-v1.png` | 手机顶部、登录页浅底标识 | Extract the primary full horizontal logo lockup from the top left of selected FLOW board. Preserve teal/navy/citron H-ribbon, transparent arrow channel, exact 汇途 and HUITU lettering; transparent background; one logo only. |
| `flow-logo-dark-v1.png` | 墨色侧栏、品牌入口横条 | Extract the reverse-color lockup at the top right of selected FLOW board; white H-ribbon, citron accent, exact 汇途/HUITU on a uniform solid deep navy background; no board labels, duplicate logos or transparent edge artifacts. |
| `flow-symbol-v1.png` | 钱包品牌图形、紧凑导航 | Extract only the colored H-ribbon symbol; preserve geometry and negative-space route arrow; square transparent canvas; no lettering or background. |
| `flow-sculpture-v1.png` | 桌面登录页品牌主视觉 | Premium matte teal ribbon road, folding into an architectural H gateway with navy undersides and one citron terminal accent; transparent background; no text, coins, map, flags, certificates or UI. |
| `flow-app-icon-v1.png` | 浏览器图标、Apple 触屏图标 | One square full-bleed deep navy app icon; exact white H-ribbon, citron cap, navy arrow gap; no text, wordmark, outer border or duplicate icon. |

初始方向图的共同提示为：面向 USDT/USDC 与六种法币的汇途全球代付运营产品，制作原创、清晰、适合 24px 图标识别的品牌系统；不使用银行标识、虚构认证、业绩承诺或通用地球箭头。选中方向 A 的要求为墨色、青绿、少量亮柠和交织路径 H 标记。

## 界面范围

1. 登录/注册：双栏品牌入口、生成式品牌雕塑、统一标识、密码可见性按钮；邀请注册、校验、提交字段和登录行为保持原流程。
2. 用户端：墨色侧栏与资产主卡、清晰资金层级、亮柠结汇入口、六币种提示。保留模拟充值；去掉“演示资产”标签。
3. 管理后台：品牌化导航、日期筛选区、指标卡；清理面向开发者的字段名文案，统计逻辑不变。
4. 服务商：统一品牌横条、状态摘要；手机订单采用卡片式排布，处理入口无需横向滚动。
5. 推广伙伴：统一品牌横条、邀请主卡、客户与佣金层级。邀请、归属和佣金数据隔离保持不变。

## 浏览器验收

用户明确允许使用 Playwright 只读打开网站和截图。以 1440×1000 与 390×844 检查登录、用户钱包、运营概览、服务商和伙伴端，核对缺图、控制台异常、横向溢出、导航及弹窗。

原始截图和角色会话仅存于工作区私有目录 `.cc-connect/private/ui-brand-audit/`，不提交账户数据或认证信息。预览通过拦截静态资源在浏览器内使用本地构建，API 保持真实只读；禁止业务写入。发布后再对公开地址重拍和核对，不把本地构建或接口健康视作最终视觉验收。
