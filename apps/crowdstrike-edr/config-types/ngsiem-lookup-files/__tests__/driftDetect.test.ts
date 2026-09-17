// driftDetect for ngsiem-lookup-files.
//
// The shared contract covers the invariants: drift never writes, a deleted file
// is critical drift, and a 500 is never reported as the file being gone. What is
// specific here is the CSV CONTENT — the whole configuration of a lookup file.
// A row edited or removed in the console changes what every query enriched by
// this table returns, so the comparison has to be on the content itself.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const CSV = 'hostname,owner,criticality\npay-db-01,payments,tier1\npay-db-02,payments,tier1'

const LOOKUP = item('Payment estate owners', {
  filename: 'payment-estate.csv',
  repository: 'all',
  content: CSV,
  keyColumns: 'hostname',
})

registerDriftContract({ label: 'ngsiem-lookup-files', handler: driftDetect, items: [LOOKUP] })

/** The live file exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  filename: 'payment-estate.csv',
  search_domain: 'all',
  content: CSV,
  ...over,
})

/** This type reads a file in ONE call — the JSON bulk-get returns the content. */
function lookupFile(file: Record<string, unknown> | null) {
  return file === null ? [TOKEN, { status: 404, body: {} }] : [TOKEN, entityPage([file])]
}

test('ngsiem-lookup-files driftDetect: reports no drift when the CSV still matches', async () => {
  const { calls, restore } = recordFetch(lookupFile(live()))
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: reports a CSV row edited in the console', async () => {
  const { restore } = recordFetch(
    lookupFile(
      live({ content: 'hostname,owner,criticality\npay-db-01,payments,tier3\npay-db-02,payments,tier1' }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'payment-estate.csv.content')
    assert.ok(diff, `expected a content diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'declared CSV content')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: reports a CSV row removed in the console', async () => {
  // A missing row silently stops enriching one host — invisible unless compared.
  const { restore } = recordFetch(
    lookupFile(live({ content: 'hostname,owner,criticality\npay-db-01,payments,tier1' })),
  )
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    assert.ok(
      result.diffs.some((d) => d.field === 'payment-estate.csv.content'),
      `a removed row is drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: ignores a trailing newline, which the API may add', async () => {
  const { restore } = recordFetch(lookupFile(live({ content: `${CSV}\n` })))
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    assert.equal(
      result.hasDrift,
      false,
      `trailing whitespace is not drift: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: makes no write when the API returns the file without its content', async () => {
  // DEFECT (reported, not blessed): when the bulk-get answers without a
  // `content` field the handler compares nothing and returns a bare
  // `hasDrift: false`, which the platform reads as "I checked and it matches"
  // and uses to clear real drift. It wants `checked: false`. Only the half that
  // is certainly right is asserted here — that drift never writes.
  const { calls, restore } = recordFetch(
    lookupFile({ filename: 'payment-estate.csv', search_domain: 'all' }),
  )
  try {
    await driftDetect(driftContext([LOOKUP]))

    assert.equal(writeCalls(calls).length, 0, 'drift must never write')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookupFile(
      live({
        content: 'hostname,owner,criticality\nedited,by,hand',
        modified_by: 'alice@acme.com',
        modified_timestamp: '2026-01-04T10:00:00Z',
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    const diff = result.diffs.find((d) => d.field === 'payment-estate.csv.content')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(
    lookupFile(live({ content: 'hostname,owner\nchanged,by-us', modified_by: CLIENT_ID })),
  )
  try {
    const result = await driftDetect(driftContext([LOOKUP]))

    const diff = result.diffs.find((d) => d.field === 'payment-estate.csv.content')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-lookup-files driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Payment estate owners', {
    filename: 'payment-estate.csv',
    repository: 'all',
    content: 'hostname,owner,criticality\nnot-yet-deployed,payments,tier1',
  })
  const { restore } = recordFetch(lookupFile(live()))
  try {
    const result = await driftDetect(driftContext([LOOKUP], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
