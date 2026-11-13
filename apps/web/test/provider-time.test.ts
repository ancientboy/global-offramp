import test from "node:test";
import assert from "node:assert/strict";
import { initialPaymentTime } from "../app/provider-time";
test("same-minute payment keeps sub-second precision after creation in China, Brazil and UTC", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Asia/Shanghai", "America/Sao_Paulo", "UTC"]) {
      process.env.TZ = tz;
      const created = "2026-11-13T15:23:45.900Z",
        now = "2026-11-13T15:23:46.123Z";
      const input = initialPaymentTime(created, now);
      assert.equal(new Date(input).toISOString(), now);
      assert.ok(Date.parse(input) > Date.parse(created));
      assert.equal(
        new Date(initialPaymentTime(created, created)).getTime(),
        Date.parse(created) + 1,
      );
      assert.equal(
        new Date(initialPaymentTime(created, now, 1500)).getTime(),
        Date.parse(now) + 1500,
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
