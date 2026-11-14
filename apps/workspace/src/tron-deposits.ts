import { createHash } from "node:crypto";
import { addressHex, TRANSFER_TOPIC, TRON_USDT } from "./chain-transfers";
import { USDT_TRC20_RECEIVER } from "../../../packages/core/src/deposit-policy";
import { decimal } from "../../../packages/core/src/money";
export interface IncomingTransfer {
  txid: string;
  logIndex: number;
  amount: string;
  sourceHex: string;
  blockNumber: number;
  blockHash: string;
  time: number;
}
/** TronGrid is discovery only. No indexer amount/status can authorize a credit. */
export class TronDeposits {
  constructor(
    readonly apiKey = "",
    readonly fetcher: typeof fetch = fetch,
  ) {}
  private async request(path: string, body?: unknown): Promise<any> {
    const r = await this.fetcher("https://api.trongrid.io" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { "TRON-PRO-API-KEY": this.apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (!r.ok) throw Error("TRON read unavailable");
    const data = await r.json();
    if (data.Error || data.success === false) throw Error("TRON read rejected");
    return data;
  }
  async solidTime() {
    const b = await this.request("/walletsolidity/getnowblock", {});
    if (
      !/^[a-f0-9]{64}$/.test(b.blockID) ||
      !Number.isSafeInteger(b.block_header?.raw_data?.timestamp)
    )
      throw Error("Invalid solid block");
    const time = b.block_header.raw_data.timestamp;
    if (time > Date.now() + 60000 || time < Date.now() - 120000)
      throw Error("TRON finality is stale");
    return time as number;
  }
  async discover(from: number, through: number) {
    const txids = new Set<string>();
    let fingerprint = "";
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({
        only_confirmed: "true",
        only_to: "true",
        limit: "200",
        contract_address: TRON_USDT,
        order_by: "block_timestamp,asc",
        min_timestamp: String(from),
        max_timestamp: String(through),
      });
      if (fingerprint) q.set("fingerprint", fingerprint);
      const v = await this.request(
        `/v1/accounts/${USDT_TRC20_RECEIVER}/transactions/trc20?${q}`,
      );
      if (v.success !== true || !Array.isArray(v.data))
        throw Error("Invalid TRON discovery");
      for (const t of v.data) {
        if (!/^[a-f0-9]{64}$/.test(t.transaction_id))
          throw Error("Invalid TRON transaction");
        txids.add(t.transaction_id);
      }
      const next = v.meta?.fingerprint;
      if (!next || !v.data.length) return [...txids];
      if (next === fingerprint) throw Error("TRON pagination stalled");
      fingerprint = next;
    }
    throw Error("TRON discovery requires narrower scan window");
  }
  async verify(txid: string): Promise<IncomingTransfer[]> {
    if (!/^[a-f0-9]{64}$/.test(txid))
      throw Error("Invalid transaction identity");
    const info = await this.request("/walletsolidity/gettransactioninfobyid", {
      value: txid,
    });
    const tx = await this.request("/walletsolidity/gettransactionbyid", {
      value: txid,
    });
    if (
      info.id !== txid ||
      info.receipt?.result !== "SUCCESS" ||
      tx.txID !== txid ||
      tx.ret?.[0]?.contractRet !== "SUCCESS" ||
      !/^(?:[a-f0-9]{2})+$/i.test(tx.raw_data_hex ?? "") ||
      createHash("sha256")
        .update(Buffer.from(tx.raw_data_hex, "hex"))
        .digest("hex") !== txid
    )
      throw Error("Transaction is not a successful solidified transfer");
    if (
      !Number.isSafeInteger(info.blockNumber) ||
      !Number.isSafeInteger(info.blockTimeStamp)
    )
      throw Error("Invalid receipt block");
    const b = await this.request("/walletsolidity/getblockbynum", {
      num: info.blockNumber,
    });
    if (
      !/^[a-f0-9]{64}$/.test(b.blockID) ||
      b.block_header?.raw_data?.number !== info.blockNumber ||
      b.block_header?.raw_data?.timestamp !== info.blockTimeStamp ||
      !b.transactions?.some((t: any) => t.txID === txid)
    )
      throw Error("Receipt does not belong to solidified block");
    if (info.blockTimeStamp > Date.now() + 60000)
      throw Error("Invalid transfer time");
    const transfers: IncomingTransfer[] = [];
    for (const [i, l] of (info.log ?? []).entries()) {
      if (l.address?.toLowerCase() !== addressHex("usdttrc20", TRON_USDT))
        continue;
      if (
        !Array.isArray(l.topics) ||
        l.topics.length !== 3 ||
        l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
        !/^0{24}[a-f0-9]{40}$/i.test(l.topics[1]) ||
        !/^0{24}[a-f0-9]{40}$/i.test(l.topics[2]) ||
        !/^[a-f0-9]{64}$/i.test(l.data)
      )
        continue;
      if (
        l.topics[2].slice(-40).toLowerCase() !==
        addressHex("usdttrc20", USDT_TRC20_RECEIVER)
      )
        continue;
      const amount = BigInt("0x" + l.data);
      if (amount <= 0n || amount >= 10n ** 30n) continue;
      transfers.push({
        txid,
        logIndex: i,
        amount: decimal(amount, 6),
        sourceHex: l.topics[1].slice(-40).toLowerCase(),
        blockNumber: info.blockNumber,
        blockHash: b.blockID,
        time: info.blockTimeStamp,
      });
    }
    return transfers;
  }
}
