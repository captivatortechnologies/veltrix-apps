// driftDetect for ISC verified from-addresses.
//
// There are only two things to report: the address is gone from the tenant, or it
// is registered but still unverified — which means nothing actually sends from it
// yet, even though the deploy succeeded.

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN, driftContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { EMAIL, addressItem, liveAddress } from './fixtures'

registerCollectionDriftContract({
  label: 'verified-from-addresses',
  handler: driftDetect,
  listPath: '/beta/verified-from-addresses',
  item: addressItem(),
  matchingLive: liveAddress(),
  driftedLive: liveAddress({ verified: false }),
  driftedField: `${EMAIL}.verified`,
  absentField: EMAIL,
})

test('verified-from-addresses driftDetect: accepts either spelling of the verified flag', async () => {
  // ISC has answered with both `verified` and `isVerified` across API versions;
  // reading only one of them would report every address as pending.
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([{ id: 'vfa-1', email: EMAIL, isVerified: true }]),
  ])
  try {
    const result = await driftDetect(driftContext([addressItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})
