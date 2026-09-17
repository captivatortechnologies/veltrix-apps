// driftDetect for zia-dlp-notification-templates.
//
// The shared contract covers the invariants: drift never writes, a deleted
// template is critical drift, and a 500 is never reported as the template being
// gone. What is specific here is the comparison itself — `subject` (trimmed),
// `tlsEnabled` and `attachContent`, the last two compared as strict booleans so
// an absent flag reads as false — and the attribution that rides on the live
// template's `lastModifiedBy`.
//
// NOT asserted, deliberately: the plain-text and HTML bodies. deploy writes both
// on every run but drift never compares them, so a notification rewritten in the
// ZIA console comes back in sync — see the report.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  item,
  recordFetch,
  writeCalls,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDriftContract } from '../../../lib/__tests__/zscalerContracts'

const TEMPLATE = item('Acme DLP Notice', {
  name: 'Acme DLP Notice',
  subject: 'DLP violation detected',
  plain_text_message: 'Your upload was blocked by Acme DLP.',
  tls_enabled: true,
  attach_content: false,
})

registerDriftContract({
  label: 'zia-dlp-notification-templates',
  handler: driftDetect,
  product: 'zia',
  items: [TEMPLATE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 9901,
  name: 'Acme DLP Notice',
  subject: 'DLP violation detected',
  plainTextMessage: 'Your upload was blocked by Acme DLP.',
  htmlMessage: '',
  tlsEnabled: true,
  attachContent: false,
  ...over,
})

test('zia-dlp-notification-templates driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates driftDetect: reports a changed subject', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ subject: 'Rewritten in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme DLP Notice.subject')
    assert.ok(diff, `expected a subject diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'DLP violation detected')
    assert.equal(diff.actual, 'Rewritten in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates driftDetect: reports TLS turned off on the notification mail', async () => {
  // The notification carries the blocked content, so delivering it in the clear
  // is the drift worth catching here.
  const { restore } = recordFetch([TOKEN, ziaList([live({ tlsEnabled: false })])])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme DLP Notice.tlsEnabled')
    assert.ok(diff)
    assert.equal(diff.expected, 'true')
    assert.equal(diff.actual, 'false')
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates driftDetect: reports attachContent switched back on', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ attachContent: true })])])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme DLP Notice.attachContent')
    assert.ok(diff)
    assert.equal(diff.expected, 'false')
    assert.equal(diff.actual, 'true')
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        subject: 'Rewritten in the ZIA console',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    const diff = result.diffs.find((d) => d.field === 'Acme DLP Notice.subject') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        subject: 'Rewritten by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([TEMPLATE]))

    const diff = result.diffs.find((d) => d.field === 'Acme DLP Notice.subject') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
