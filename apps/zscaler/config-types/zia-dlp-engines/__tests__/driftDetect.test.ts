// driftDetect for zia-dlp-engines.
//
// The shared contract covers the invariants: drift never writes, a deleted
// engine is critical drift, and a 500 is never reported as the engine being
// gone. What is specific here is the comparison itself — `engineExpression` is
// the one managed field compared, and it is compared after trimming — plus the
// attribution that rides on the live engine's `lastModifiedBy`.
//
// NOT asserted, deliberately: `description`. deploy writes it on every run but
// drift never compares it, so it is left out of these assertions rather than
// blessed as unmanaged — see the report.

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

const ENGINE = item('Acme Secret Leakage', {
  name: 'Acme Secret Leakage',
  description: 'desired description',
  engine_expression: '((D63.S > 1))',
})

registerDriftContract({
  label: 'zia-dlp-engines',
  handler: driftDetect,
  product: 'zia',
  items: [ENGINE],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 8801,
  name: 'Acme Secret Leakage',
  customDlpEngine: true,
  description: 'desired description',
  engineExpression: '((D63.S > 1))',
  ...over,
})

test('zia-dlp-engines driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([ENGINE]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-engines driftDetect: reports an expression loosened in the ZIA console', async () => {
  // Raising the threshold is how a DLP engine is quietly switched off without
  // deleting it — the case this check exists for.
  const { restore } = recordFetch([TOKEN, ziaList([live({ engineExpression: '((D63.S > 999))' })])])
  try {
    const result = await driftDetect(driftContext([ENGINE]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme Secret Leakage.engine_expression')
    assert.ok(diff, `expected an expression diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '((D63.S > 1))')
    assert.equal(diff.actual, '((D63.S > 999))')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-dlp-engines driftDetect: surrounding whitespace on the live expression is not drift', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ engineExpression: '  ((D63.S > 1))  ' })])])
  try {
    const result = await driftDetect(driftContext([ENGINE]))

    assert.equal(result.hasDrift, false, 'ZIA pads the stored expression — that is not a change')
  } finally {
    restore()
  }
})

test('zia-dlp-engines driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        engineExpression: '((D63.S > 999))',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([ENGINE]))

    const diff = result.diffs.find((d) => d.field === 'Acme Secret Leakage.engine_expression') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-dlp-engines driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        engineExpression: '((D63.S > 999))',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([ENGINE]))

    const diff = result.diffs.find((d) => d.field === 'Acme Secret Leakage.engine_expression') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
