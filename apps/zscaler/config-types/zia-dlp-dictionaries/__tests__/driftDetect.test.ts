// driftDetect for zia-dlp-dictionaries.
//
// The shared contract covers the invariants: drift never writes, a deleted
// dictionary is critical drift, and a 500 is never reported as the dictionary
// being gone. What is specific here is the comparison itself — the managed
// description plus the phrase and pattern CARDINALITY — and the attribution that
// rides on the live dictionary's `lastModifiedBy`.
//
// NOT asserted, deliberately: a phrase or pattern edited in place. The handler
// compares counts only, so swapping one regex for another of the same set size
// comes back in sync — see the report.

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

const DICTIONARY = item('Acme Secrets', {
  name: 'Acme Secrets',
  description: 'desired description',
  phrases: 'project-zephyr\nacme-confidential',
  patterns: 'ACME-[0-9]{6}',
})

registerDriftContract({
  label: 'zia-dlp-dictionaries',
  handler: driftDetect,
  product: 'zia',
  items: [DICTIONARY],
})

const live = (over: Record<string, unknown> = {}) => ({
  id: 7701,
  name: 'Acme Secrets',
  custom: true,
  description: 'desired description',
  dictionaryType: 'PATTERNS_AND_PHRASES',
  phrases: [
    { action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'project-zephyr' },
    { action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'acme-confidential' },
  ],
  patterns: [{ action: 'PATTERN_COUNT_TYPE_ALL', pattern: 'ACME-[0-9]{6}' }],
  ...over,
})

test('zia-dlp-dictionaries driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([live()])])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries driftDetect: reports a changed description', async () => {
  const { restore } = recordFetch([TOKEN, ziaList([live({ description: 'edited in the ZIA console' })])])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme Secrets.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, 'desired description')
    assert.equal(diff.actual, 'edited in the ZIA console')
    assert.equal(diff.severity, 'info')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries driftDetect: reports a phrase removed in the tenant', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([live({ phrases: [{ action: 'PHRASE_COUNT_TYPE_ALL', phrase: 'project-zephyr' }] })]),
  ])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme Secrets.phrases')
    assert.ok(diff, `expected a phrases diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, '2 phrase(s)')
    assert.equal(diff.actual, '1 phrase(s)')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries driftDetect: reports every pattern stripped in the tenant', async () => {
  // A DLP dictionary whose patterns were removed still exists and still matches
  // its phrases — nothing else in the pipeline would notice.
  const { restore } = recordFetch([TOKEN, ziaList([live({ patterns: [] })])])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'Acme Secrets.patterns')
    assert.ok(diff)
    assert.equal(diff.expected, '1 pattern(s)')
    assert.equal(diff.actual, '0 pattern(s)')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries driftDetect: attributes a manual change to the admin who made it', async () => {
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        description: 'edited in the ZIA console',
        lastModifiedBy: { id: 55, name: 'alice@acme.com' },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    const diff = result.diffs.find((d) => d.field === 'Acme Secrets.description') as
      | { actor?: { name?: string; at?: string } }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor?.name, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2020-09-13T12:26:40.000Z')
  } finally {
    restore()
  }
})

test('zia-dlp-dictionaries driftDetect: does not attribute our own deploy as a manual change', async () => {
  // The OneAPI client id is the identity Veltrix's own writes are recorded
  // under — attributing those would report every deploy as somebody's edit.
  const { restore } = recordFetch([
    TOKEN,
    ziaList([
      live({
        description: 'edited by the pipeline',
        lastModifiedBy: { id: CLIENT_ID, name: CLIENT_ID },
        lastModifiedTime: 1600000000,
      }),
    ]),
  ])
  try {
    const result = await driftDetect(driftContext([DICTIONARY]))

    const diff = result.diffs.find((d) => d.field === 'Acme Secrets.description') as
      | { actor?: unknown }
      | undefined
    assert.ok(diff)
    assert.equal(diff.actor, undefined)
  } finally {
    restore()
  }
})
