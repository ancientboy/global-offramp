import assert from "node:assert/strict";
import test from "node:test";
import { harness, customer } from "./helpers";
import { ACTORS } from "../src/fixtures";
import { validateMerchantRow } from "../src/merchant-import";
const admin = ACTORS["merchant-demo"] ?? {id:"admin",role:"merchant_admin" as const};
const sample = {name:"虚构姓名,甲",bankName:"虚构银行,支行",accountNumber:"0012345678901234567",targetAmount:"7200.00",targetCurrency:"CNY",sourceCurrency:"USDT",clientItemId:"merchant-row-1"};
const input = (rows: unknown[], key="merchant-test") => ({customerId:"customer-2",clientBatchId:key,rows});
test("merchant import preserves target payout, masks card, quotes reverse and submits atomically", async()=>{
 const h=harness();const result=await h.service.importMerchantBatch(admin,input([sample]));
 assert.equal(result.items[0].status,"valid");assert.equal(result.items[0].accountMasked,"**** 4567");
 const s=await h.store.read();const b=s.beneficiaries.find(b=>b.id===result.items[0].beneficiaryId)!;
 assert.equal(b.customerId,"customer-2");assert.equal(b.bankName,sample.bankName);assert.equal(b.accountMasked,"**** 4567");
 assert.equal(JSON.stringify(s).includes(sample.accountNumber),false);
 const quote=await h.service.quoteBatch(admin,result.batch.id);
 assert.equal(quote.quotes[0].amountMode,"target_payout");assert.equal(quote.quotes[0].payoutAmount,"7200.00");
 assert.equal(quote.quotes[0].sourceAmount,"1000.000000");
 const submitted=await h.service.submitBatch(admin,result.batch.id,{fundingSource:"deposit"});
 assert.equal(submitted.items[0].status,"created");
 const order=(await h.store.read()).orders.find(o=>o.id===submitted.items[0].orderId)!;
 assert.equal(order.quote.payoutAmount,"7200.00"); assert.equal(order.quote.amountMode,"target_payout");
});
test("same batch key retries safely; changed payload conflicts; no duplicate recipients",async()=>{
 const h=harness();const a=await h.service.importMerchantBatch(admin,input([sample]));
 const n=(await h.store.read()).beneficiaries.length;
 const b=await h.service.importMerchantBatch(admin,input([sample]));assert.equal(a.batch.id,b.batch.id);assert.equal((await h.store.read()).beneficiaries.length,n);
 await assert.rejects(()=>h.service.importMerchantBatch(admin,input([{...sample,targetAmount:"7201.00"}])));
});
test("invalid rows create no recipients, quotes or orders; duplicates isolated",async()=>{
 const h=harness();const n=(await h.store.read()).beneficiaries.length;
 const invalid=[{...sample,accountNumber:12345678901234567},{...sample,accountNumber:"1.234567E+18"},{...sample,accountNumber:"=SUM(1)"},{...sample,targetAmount:"0"},{...sample,targetAmount:"-1"},{...sample,targetAmount:"1.001"},{...sample,targetAmount:"1e3"},{...sample,bankName:""},{...sample,customerId:"customer-1"}];
 const result=await h.service.importMerchantBatch(admin,input(invalid.map((r,i)=>({...r,clientItemId:`bad-${i}`}))));
 assert.ok(result.items.every(i=>i.status==="error")); const state=await h.store.read();assert.equal(state.beneficiaries.length,n);assert.equal(state.orders.length,0);assert.equal(state.quotes.length,0);
 assert.equal(JSON.stringify(state).includes("=SUM(1)"),false);
 const dup=await h.service.importMerchantBatch(admin,input([sample,sample],"duplicate"));assert.deepEqual(dup.items.map(i=>i.status),["valid","error"]);
});
test("merchant scope rejects personal and cross-customer; partner sees no batch recipient",async()=>{
 const h=harness(); await assert.rejects(()=>h.service.importMerchantBatch(customer,input([sample])));
 await assert.rejects(()=>h.service.importMerchantBatch(admin,{...input([sample]),customerId:"customer-1"}));
 await h.service.importMerchantBatch(admin,input([sample]));
 const other=await h.service.dashboard(customer);assert.equal(other.batchItems?.length,0);
 const partner=await h.service.dashboard(ACTORS["partner-demo"]);assert.equal(JSON.stringify(partner).includes(sample.name),false);
});
test("two currencies and omitted references work without accidental duplicate row defaults",async()=>{
 const h=harness();const {clientItemId,...withoutRef}=sample;
 const a=await h.service.importMerchantBatch(admin,input([withoutRef,{...withoutRef,targetAmount:"100.01",targetCurrency:"USD",sourceCurrency:"USDC"}]));
 assert.ok(a.items.every(i=>i.status==="valid"));assert.notEqual(a.items[0].clientItemId,a.items[1].clientItemId);
 const q=await h.service.quoteBatch(admin,a.batch.id);assert.equal(q.quotes[1].payoutAmount,"100.01");
 const b=await h.service.importMerchantBatch(admin,input([withoutRef],"another"));assert.equal(b.items[0].status,"valid");
});
test("exact text identifiers pass, numeric or formula values cannot be inferred",()=>{
 assert.equal(validateMerchantRow(sample,2).row.accountNumber,sample.accountNumber);
 for(const accountNumber of [12345678901234567,"=12345678901234567","1.23E+16","'0012345678901234567"]) assert.ok(validateMerchantRow({...sample,accountNumber},2).errors.length);
});

test("actual template flows through merchant import and reverse quote", async()=>{
 const fs=await import("node:fs/promises");
 const {readMerchantWorkbook}=await import("../../../apps/web/app/merchant-workbook");
 const bytes=await fs.readFile("apps/web/public/templates/merchant-batch-template.xlsx");
 const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
 const h=harness();const rows=await readMerchantWorkbook(data);
 const actor={id:"template-test",role:"merchant_admin" as const};
 const batch=await h.service.importMerchantBatch(actor,{customerId:"customer-2",clientBatchId:"template-roundtrip",rows});
 assert.equal(batch.items[0].status,"valid");
 const quote=await h.service.quoteBatch(actor,batch.batch.id);
 assert.equal(quote.quotes[0].payoutAmount,"7200.00");assert.equal(quote.quotes[0].amountMode,"target_payout");
 assert.equal(JSON.stringify(await h.store.read()).includes("0012345678901234567"),false);
});
