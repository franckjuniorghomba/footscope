import assert from 'node:assert/strict';
import { reserveProviderSlot } from '../worker/index.js';
let value = null,
  etag = null,
  revision = 0;
const env = {
  BUCKET: {
    get: async () => (value ? { etag, json: async () => JSON.parse(value) } : null),
    put: async (k, v, options) => {
      const condition = options.onlyIf;
      if (condition instanceof Headers) {
        if (value) return null;
      } else if (condition.etagMatches !== etag) return null;
      value = v;
      etag = String(++revision);
      return { etag };
    },
  },
};
const slots = await Promise.all(Array.from({ length: 6 }, () => reserveProviderSlot(env, 10)));
slots.sort((a, b) => a - b);
assert.equal(new Set(slots).size, 6);
for (let i = 1; i < slots.length; i++)
  assert(slots[i] - slots[i - 1] >= 10, 'Concurrent callers reserve different, spaced slots');
console.log('Passed: atomic shared pacing with conditional writes and concurrent callers.');
