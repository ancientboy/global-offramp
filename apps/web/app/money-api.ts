export const movementLabels: Record<string, string> = {
  requested: "待审核",
  approved: "提现处理中",
  completed: "已完成",
  cancelled: "已取消",
  rejected: "未通过",
};
const messages: Record<string, string> = {
  MFA_SETUP_REQUIRED: "请先在账户安全中绑定验证器。",
  MFA_STEP_UP_REQUIRED: "请在账户安全中验证动态码后重试。",
  INSUFFICIENT_BALANCE: "可用余额不足。",
  INVALID_WALLET_ADDRESS: "钱包地址或校验码不正确，请核对网络和地址。",
  MOVEMENT_LIMIT_EXCEEDED: "金额超出单笔限额。",
  DAILY_MOVEMENT_LIMIT: "已达到今日额度。",
  MOVEMENT_LOCKED: "申请已进入处理，暂不能取消。",
  TREASURY_WALLET_UNCONFIGURED: "结算钱包地址尚待配置核实。",
  TRANSACTION_NOT_FINAL: "交易尚未达到最终确认，请稍后重新核验。",
  TRANSACTION_FAILED: "该交易未执行成功。",
  TRANSFER_MISMATCH: "交易的币种、付款方、收款方或金额与申请不匹配。",
  TRANSFER_ALREADY_CLAIMED: "这笔链上转账已用于其他申请，不能重复登记。",
  TRANSACTION_TIME_MISMATCH: "交易时间与审批时间不匹配。",
  AMBIGUOUS_TRANSFER: "该交易包含多笔相同转账，请在高级选项中指定事件序号。",
  CHAIN_LOOKUP_UNAVAILABLE: "链上查询暂不可用，请稍后重试。",
  REAL_FUNDS_DISABLED: "当前环境未开放真实资金核验。",
  PAYOUTS_PAUSED: "资金处理暂时暂停。",
  INSUFFICIENT_PROVIDER_PAYABLE: "申请金额超过该服务商当前可结算余额。",
  IDEMPOTENCY_CONFLICT: "申请内容已变化，请核对原申请后重试。",
  CUSTOMER_BLOCKED: "账户正在核对，暂不能申请。",
  PAYMENT_NOT_LINKED: "请先关联该充值在 NOWPayments 的支付编号。",
  PAYMENT_IDENTITY_MISMATCH: "服务商支付记录与本平台充值申请不匹配。",
  NOT_PARTIALLY_PAID: "该充值当前不是可接受净额的少付状态。",
  DEPOSITS_UNAVAILABLE: "真实充值尚未开放。",
};
export async function moneyRequest(path: string, body?: unknown) {
  const r = await fetch("/workspace/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const v = await r.json();
  if (!r.ok) throw Error(messages[v.error] ?? "操作未完成，请刷新记录后重试。");
  return v;
}
