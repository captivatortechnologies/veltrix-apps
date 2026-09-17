// rollback for the ISC tenant configuration singletons.
//
// These settings are tenant-wide — lockout thresholds, session limits, password
// policy defaults — so a rollback that writes the wrong thing changes how
// everybody signs in. An entry naming a setting the registry does not know has no
// endpoint at all and must make no call.

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN, bodyOf, ok, pathOf, recordFetch, rollbackContext, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { PATCH_PATH, PATCH_SETTING, PUT_PATH, PUT_SETTING, livePutConfig } from './fixtures'

registerRollbackContract({
  label: 'tenant-config-singletons',
  handler: rollback,
  restore: {
    entry: { setting: PUT_SETTING, method: 'PUT', prior: livePutConfig() },
    method: 'PUT',
    path: PUT_PATH,
    bodyIncludes: ['"digitTokenLength":6', '"customInstructionsEnabled":false'],
  },
  unrecoverable: [
    // A setting the registry does not know has no endpoint to write to.
    { setting: 'not-a-real-singleton', method: 'PUT', prior: { anything: true } },
  ],
})

test('tenant-config-singletons rollback: reverts a PATCH singleton key by key', async () => {
  // The prior for a PATCH singleton is only the keys deploy changed — reverting
  // must not send back a whole object it never captured.
  const { calls, restore } = recordFetch([TOKEN, ok({})])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ setting: PATCH_SETTING, method: 'PATCH', prior: { maximumAttempts: 10, lockoutDuration: 30 } }],
      }),
    )

    assert.equal(result.success, true, result.message)
    const write = writeCalls(calls)[0]
    assert.equal(write.method, 'PATCH')
    assert.equal(pathOf(write), PATCH_PATH)
    assert.deepEqual(bodyOf(write), [
      { op: 'replace', path: '/maximumAttempts', value: 10 },
      { op: 'replace', path: '/lockoutDuration', value: 30 },
    ])
  } finally {
    restore()
  }
})
