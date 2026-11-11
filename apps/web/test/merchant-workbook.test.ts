import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import { readMerchantWorkbook, merchantRowPreview } from "../app/merchant-workbook";
const path="apps/web/public/templates/merchant-batch-template.xlsx";
const buffer=async()=>{const bytes=await fs.readFile(path);return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;};
test("downloadable template is directly importable and preserves exact text account",async()=>{
 const data=await buffer(); const rows=await readMerchantWorkbook(data);assert.equal(rows.length,1);
 assert.equal(rows[0].accountNumber,"0012345678901234567");assert.equal(rows[0].targetAmount,"7200");
 assert.equal(merchantRowPreview(rows[0],0).errors.length,0);assert.equal(merchantRowPreview(rows[0],0).accountNumber,"**** 4567");
 const w=new ExcelJS.Workbook();await w.xlsx.load(data);assert.equal(w.getWorksheet("批量结汇")!.getCell("C2").numFmt,"@");assert.equal(w.getWorksheet("批量结汇")!.getCell("C2").type,ExcelJS.ValueType.String);
});
test("numeric and formula account cells remain rejected after XLSX parsing",async()=>{
 for(const value of [12345678901234567,{formula:"12345678901234567",result:12345678901234567}]){
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await buffer());workbook.worksheets[0].getCell("C2").value=value;
  // Disposable malformed-file fixtures only; deliverable is authored by artifact-tool.
  const data=await workbook.xlsx.writeBuffer();const rows=await readMerchantWorkbook(new Uint8Array(data as unknown as Uint8Array).buffer);
  assert.ok(merchantRowPreview(rows[0],0).errors.length);
 }
});
test("duplicate header and extra columns reject rather than overwrite",async()=>{
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await buffer());workbook.worksheets[0].getCell("B1").value="姓名";
 await assert.rejects(()=>workbook.xlsx.writeBuffer().then(data=>readMerchantWorkbook(new Uint8Array(data as unknown as Uint8Array).buffer)),/表头/);
});
test("forged declared expanded lengths are rejected before workbook load",async()=>{
 const data=await buffer();const bytes=new Uint8Array(data);const view=new DataView(data);
 for(let i=0;i<bytes.length-46;i++) if(view.getUint32(i,true)===0x02014b50){
  const len=view.getUint16(i+28,true);const name=new TextDecoder().decode(bytes.subarray(i+46,i+46+len));
  if(name==="xl/worksheets/sheet1.xml") {const local=view.getUint32(i+42,true);view.setUint32(i+24,1,true);view.setUint32(local+22,1,true);break;}
 }
 await assert.rejects(()=>readMerchantWorkbook(data));
});
