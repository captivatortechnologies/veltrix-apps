import test from 'node:test'
import assert from 'node:assert/strict'
import handler from '../rollback'
import { recordFetch } from '../../../lib/__tests__/fakeGraph'
test('rollback gates unsupported app-only agreement management without network calls', async () => {
 const { calls, restore } = recordFetch([])
 try {
  const result = await handler({} as never)
  assert.equal(calls.length, 0)
  assert.equal(result.success, false)
 } finally { restore() }
})
