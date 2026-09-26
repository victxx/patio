import assert from "node:assert/strict";
import { test } from "node:test";

import { base64ToBytes, bytesToBase64 } from "./base64.ts";

for (const environment of ["node", "browser"]) {
  test(`Base64 conversions (${environment})`, () => {
    const originalBuffer = globalThis.Buffer;
    try {
      if (environment === "browser") globalThis.Buffer = undefined;

      assert.equal(bytesToBase64(new Uint8Array()), "");
      assert.deepEqual(base64ToBytes(""), new Uint8Array());

      const bytes = new Uint8Array([0, 127, 128, 255]);
      assert.equal(bytesToBase64(bytes), "AH+A/w==");
      assert.deepEqual(base64ToBytes("AH+A/w=="), bytes);

      const allBytes = Uint8Array.from({ length: 256 }, (_, index) => index);
      assert.deepEqual(base64ToBytes(bytesToBase64(allBytes)), allBytes);

      const view = new Uint8Array([99, 0, 127, 128, 255, 99]).subarray(1, 5);
      assert.equal(bytesToBase64(view), "AH+A/w==");
    } finally {
      globalThis.Buffer = originalBuffer;
    }
  });
}
