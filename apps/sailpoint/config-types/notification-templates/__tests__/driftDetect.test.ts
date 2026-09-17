// driftDetect for ISC notification templates.
//
// Templates are matched on the (key, medium, locale) triple, so an override for
// another locale is not this one. The body is compared but never echoed into the
// diff — a template body is arbitrary HTML, and reproducing it in a drift record
// makes the record unreadable without making it more useful.

import test from 'node:test'
import assert from 'node:assert/strict'
import { TOKEN, driftContext, listPage, recordFetch, writeCalls } from '../../../lib/__tests__/fakeIsc'
import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { LABEL, inSyncTemplate, templateItem } from './fixtures'

registerCollectionDriftContract({
  label: 'notification-templates',
  handler: driftDetect,
  listPath: '/beta/notification-templates',
  item: templateItem(),
  matchingLive: inSyncTemplate(),
  driftedLive: inSyncTemplate({ subject: 'Edited in the console' }),
  driftedField: `${LABEL}.subject`,
  absentField: LABEL,
})

test('notification-templates driftDetect: reports an edited body without echoing it', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    listPage([inSyncTemplate({ body: '<p>Someone rewrote this in the console.</p>' })]),
  ])
  try {
    const result = await driftDetect(driftContext([templateItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.body`)
    assert.ok(diff, 'an edited body must be reported')
    assert.equal(diff.actual, 'differs')
    assert.equal(diff.expected, 'declared body')
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('notification-templates driftDetect: an override for another locale is not this one', async () => {
  const { restore } = recordFetch([TOKEN, listPage([inSyncTemplate({ locale: 'de' })])])
  try {
    const result = await driftDetect(driftContext([templateItem()]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    assert.ok(diff)
    assert.equal(diff.actual, 'absent')
  } finally {
    restore()
  }
})
