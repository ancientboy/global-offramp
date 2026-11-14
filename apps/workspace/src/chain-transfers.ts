import { createHash } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { HttpError } from "./auth";
import { units } from "../../../packages/core/src/money";
export type TransferNetwork = "usdttrc20" | "usdcbase";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const TRANSFER_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const hash = (b: Buffer) => createHash("sha256").update(b).digest();
export function address(network: TransferNetwork, value: string) {
  if (network === "usdcbase") {
    if (!/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/i.test(value))
      throw new HttpError(400, "INVALID_WALLET_ADDRESS");
    const lower = value.slice(2).toLowerCase();
    if (
      value.slice(2) !== lower &&
      value.slice(2) !== value.slice(2).toUpperCase()
    ) {
      const digest = Buffer.from(keccak_256(Buffer.from(lower))).toString(
        "hex",
      );
      for (let i = 0; i < 40; i++)
        if (
          /[a-f]/.test(lower[i]) &&
          value[i + 2] !==
            (parseInt(digest[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i])
        )
          throw new HttpError(400, "INVALID_WALLET_ADDRESS");
    }
    return "0x" + lower;
  }
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value))
    throw new HttpError(400, "INVALID_WALLET_ADDRESS");
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(B58.indexOf(c));
  const raw = Buffer.from(n.toString(16).padStart(50, "0"), "hex");
  if (
    raw.length !== 25 ||
    raw[0] !== 0x41 ||
    raw.subarray(1, 21).every((n) => n === 0) ||
    !hash(hash(raw.subarray(0, 21)))
      .subarray(0, 4)
      .equals(raw.subarray(21))
  )
    throw new HttpError(400, "INVALID_WALLET_ADDRESS");
  return value;
}
export function addressHex(network: TransferNetwork, value: string) {
  const v = address(network, value);
  if (network === "usdcbase") return v.slice(2);
  let n = 0n;
  for (const c of v) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(50, "0").slice(2, 42);
}
export interface TransferExpectation {
  network: TransferNetwork;
  destination: string;
  amount: string;
  approvedAt: Date | string;
}
export interface TransferProof {
  network: TransferNetwork;
  txid: string;
  logIndex: number;
  blockNumber: string;
  blockHash: string;
  sourceAddress: string;
}
export class ChainTransfers {
  private selectedBase?: { url: string; at: number };
  readonly baseUrls: string[];
  readonly treasury: Record<TransferNetwork, string[]>;
  constructor(
    treasury: Partial<Record<TransferNetwork, string[]>> = {},
    readonly fetcher: typeof fetch = fetch,
    baseUrls?: string[],
  ) {
    this.baseUrls = baseUrls?.length
      ? baseUrls
      : [
          "https://base-rpc.publicnode.com",
          "https://base.llamarpc.com",
          "https://mainnet.base.org",
        ];
    if (
      this.baseUrls.length > 5 ||
      this.baseUrls.some((v) => {
        try {
          const u = new URL(v);
          return u.protocol !== "https:" || !!u.username || !!u.password;
        } catch {
          return true;
        }
      })
    )
      throw Error("Invalid trusted Base RPC configuration");
    this.treasury = {
      usdttrc20: (treasury.usdttrc20 ?? []).map((a) => address("usdttrc20", a)),
      usdcbase: (treasury.usdcbase ?? []).map((a) => address("usdcbase", a)),
    };
  }
  config() {
    return {
      usdttrc20: { configured: this.treasury.usdttrc20.length > 0 },
      usdcbase: { configured: this.treasury.usdcbase.length > 0 },
    };
  }
  async post(url: string, body: unknown) {
    try {
      const r = await this.fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(6000),
        redirect: "error",
      });
      if (!r.ok) throw Error();
      const text = await r.text();
      if (text.length > 2 * 1024 * 1024) throw Error();
      return JSON.parse(text);
    } catch {
      throw new HttpError(503, "CHAIN_LOOKUP_UNAVAILABLE");
    }
  }
  async rpc(
    method: string,
    params: unknown[],
    url = this.selectedBase?.url ?? this.baseUrls[0],
  ) {
    let r: any;
    try {
      r = await this.post(url, {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });
    } catch (e) {
      if (this.selectedBase?.url === url) this.selectedBase = undefined;
      throw e;
    }
    if (r.error) throw new HttpError(503, "CHAIN_LOOKUP_UNAVAILABLE");
    return r.result;
  }
  async selectBaseRpc() {
    if (this.selectedBase && Date.now() - this.selectedBase.at < 60000)
      return this.selectedBase.url;
    for (const url of this.baseUrls) {
      try {
        const chainId = await this.rpc("eth_chainId", [], url);
        if (chainId !== "0x2105")
          throw new HttpError(503, "CHAIN_NETWORK_MISMATCH");
        this.selectedBase = { url, at: Date.now() };
        return url;
      } catch (e) {
        if (e instanceof HttpError && e.code === "CHAIN_NETWORK_MISMATCH")
          throw e;
      }
    }
    throw new HttpError(503, "CHAIN_LOOKUP_UNAVAILABLE");
  }
  async verify(
    e: TransferExpectation,
    input: { txid: string; logIndex?: number },
  ): Promise<TransferProof> {
    if (!this.treasury[e.network].length)
      throw new HttpError(503, "TREASURY_WALLET_UNCONFIGURED");
    const txid = input.txid.toLowerCase();
    let index = input.logIndex;
    if (this.treasury[e.network].includes(address(e.network, e.destination)))
      throw new HttpError(409, "TRANSFER_MISMATCH");
    if (
      (index !== undefined &&
        (!Number.isSafeInteger(index) || index < 0 || index > 2147483647)) ||
      !(e.network === "usdcbase" ? /^0x[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(
        txid,
      )
    )
      throw new HttpError(400, "INVALID_TRANSACTION_REFERENCE");
    const strip = (v: unknown) => String(v).replace(/^0x/, "").toLowerCase();
    const matches = (l: any) =>
      Array.isArray(l?.topics) &&
      l.topics.length === 3 &&
      strip(l.topics[0]) === TRANSFER_TOPIC &&
      /^0{24}[a-f0-9]{40}$/.test(strip(l.topics[1])) &&
      /^0{24}[a-f0-9]{40}$/.test(strip(l.topics[2])) &&
      /^[a-f0-9]{64}$/.test(strip(l.data)) &&
      this.treasury[e.network].some(
        (a) => addressHex(e.network, a) === strip(l.topics[1]).slice(-40),
      ) &&
      strip(l.topics[2]).slice(-40) === addressHex(e.network, e.destination) &&
      BigInt("0x" + strip(l.data)) === units(e.amount, 6);
    let log: any, blockNumber: string, blockHash: string, time: number;
    if (e.network === "usdcbase") {
      const node = await this.selectBaseRpc(),
        rpc = (method: string, params: unknown[]) =>
          this.rpc(method, params, node);
      const [chainId, receipt, finalized] = await Promise.all([
        rpc("eth_chainId", []),
        rpc("eth_getTransactionReceipt", [txid]),
        rpc("eth_getBlockByNumber", ["finalized", false]),
      ]);
      if (chainId !== "0x2105")
        throw new HttpError(503, "CHAIN_NETWORK_MISMATCH");
      if (!receipt) throw new HttpError(409, "TRANSACTION_NOT_FINAL");
      if (
        receipt.transactionHash?.toLowerCase() !== txid ||
        receipt.status !== "0x1"
      )
        throw new HttpError(409, "TRANSACTION_FAILED");
      if (
        !finalized?.number ||
        !receipt.blockNumber ||
        BigInt(finalized.number) < BigInt(receipt.blockNumber)
      )
        throw new HttpError(409, "TRANSACTION_NOT_FINAL");
      const block = await rpc("eth_getBlockByNumber", [
        receipt.blockNumber,
        false,
      ]);
      if (
        !block ||
        block.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase() ||
        block.number !== receipt.blockNumber
      )
        throw new HttpError(409, "TRANSACTION_NOT_FINAL");
      if (index === undefined) {
        const candidates = (receipt.logs ?? []).filter(
          (l: any) =>
            l.address?.toLowerCase() === BASE_USDC &&
            !l.removed &&
            l.transactionHash?.toLowerCase() === txid &&
            l.blockHash?.toLowerCase() === receipt.blockHash?.toLowerCase() &&
            matches(l),
        );
        if (candidates.length !== 1)
          throw new HttpError(
            409,
            candidates.length ? "AMBIGUOUS_TRANSFER" : "TRANSFER_MISMATCH",
          );
        index = Number(BigInt(candidates[0].logIndex));
      }
      log = receipt.logs?.find(
        (l: any) => Number(BigInt(l.logIndex)) === index,
      );
      if (
        !log ||
        log.removed ||
        log.transactionHash?.toLowerCase() !== txid ||
        log.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase() ||
        log.address?.toLowerCase() !== BASE_USDC
      )
        throw new HttpError(409, "TRANSFER_MISMATCH");
      blockNumber = String(BigInt(receipt.blockNumber));
      blockHash = receipt.blockHash;
      time = Number(BigInt(block.timestamp)) * 1000;
    } else {
      const [info, tx] = await Promise.all([
        this.post(
          "https://api.trongrid.io/walletsolidity/gettransactioninfobyid",
          { value: txid },
        ),
        this.post("https://api.trongrid.io/walletsolidity/gettransactionbyid", {
          value: txid,
        }),
      ]);
      if (!info?.id) throw new HttpError(409, "TRANSACTION_NOT_FINAL");
      if (info.id.toLowerCase() !== txid || info.receipt?.result !== "SUCCESS")
        throw new HttpError(409, "TRANSACTION_FAILED");
      if (
        tx.txID?.toLowerCase() !== txid ||
        tx.ret?.[0]?.contractRet !== "SUCCESS"
      )
        throw new HttpError(409, "TRANSACTION_FAILED");
      if (index === undefined) {
        const candidates = (info.log ?? [])
          .map((l: any, i: number) => ({ l, i }))
          .filter(
            ({ l }: any) =>
              l.address?.toLowerCase() === addressHex("usdttrc20", TRON_USDT) &&
              matches(l),
          );
        if (candidates.length !== 1)
          throw new HttpError(
            409,
            candidates.length ? "AMBIGUOUS_TRANSFER" : "TRANSFER_MISMATCH",
          );
        index = candidates[0].i;
      }
      log = info.log?.[index!];
      if (
        !log ||
        log.address?.toLowerCase() !== addressHex("usdttrc20", TRON_USDT)
      )
        throw new HttpError(409, "TRANSFER_MISMATCH");
      if (
        !Number.isSafeInteger(info.blockNumber) ||
        !Number.isSafeInteger(info.blockTimeStamp)
      )
        throw new HttpError(503, "CHAIN_LOOKUP_UNAVAILABLE");
      const block = await this.post(
        "https://api.trongrid.io/walletsolidity/getblockbynum",
        { num: info.blockNumber },
      );
      if (
        !/^[a-f0-9]{64}$/.test(block.blockID) ||
        block.block_header?.raw_data?.number !== info.blockNumber ||
        block.block_header?.raw_data?.timestamp !== info.blockTimeStamp
      )
        throw new HttpError(409, "TRANSACTION_NOT_FINAL");
      blockNumber = String(info.blockNumber);
      blockHash = block.blockID;
      time = info.blockTimeStamp;
    }
    if (
      !Array.isArray(log.topics) ||
      log.topics.length !== 3 ||
      strip(log.topics[0]) !== TRANSFER_TOPIC ||
      !/^0{24}[a-f0-9]{40}$/.test(strip(log.topics[1])) ||
      !/^0{24}[a-f0-9]{40}$/.test(strip(log.topics[2])) ||
      !/^[a-f0-9]{64}$/.test(strip(log.data))
    )
      throw new HttpError(409, "TRANSFER_MISMATCH");
    const source = this.treasury[e.network].find(
      (a) => addressHex(e.network, a) === strip(log.topics[1]).slice(-40),
    );
    if (
      !source ||
      strip(log.topics[2]).slice(-40) !==
        addressHex(e.network, e.destination) ||
      BigInt("0x" + strip(log.data)) !== units(e.amount, 6)
    )
      throw new HttpError(409, "TRANSFER_MISMATCH");
    if (
      !Number.isFinite(time) ||
      time < new Date(e.approvedAt).getTime() - 60000 ||
      time > Date.now() + 60000
    )
      throw new HttpError(409, "TRANSACTION_TIME_MISMATCH");
    return {
      network: e.network,
      txid,
      logIndex: index!,
      blockNumber,
      blockHash,
      sourceAddress: source,
    };
  }
}
