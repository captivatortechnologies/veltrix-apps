// ============================================================================
// driftDetect for PIM role eligibility, against a fake Microsoft Graph.
//
// Two conclusions this handler must never reach wrongly. A declared eligibility
// missing from the applied schedules is CRITICAL — somebody revoked a
// break-glass grant. But absence cannot be proved from a partial read, so a
// truncated listing must report "not verified" instead of sending an operator
// after a revocation that never happened.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collection,
  driftContext,
  graphError,
  item,
  leaksSecret,
  page,
  recordFetch,
  routeFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const SCHEDULES = /\/roleEligibilitySchedules\?/
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'
const ADA = '071cc716-8147-4397-a5ba-b2105951cc0b'
const LABEL = `${GLOBAL_ADMIN} → ${ADA} @ /`

function liveSchedule(over: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    status: 'Provisioned',
    scheduleInfo: { expiration: { type: 'noExpiration' } },
    ...over,
  }
}

function eligibilityItem(fields: Record<string, unknown> = {}) {
  return item('Global admin for Ada', {
    principalId: ADA,
    roleDefinitionId: GLOBAL_ADMIN,
    directoryScopeId: '/',
    expirationType: 'noExpiration',
    justification: 'Break-glass access',
    ...fields,
  })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed schedule listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([{ url: SCHEDULES, respond: graphError(403, 'Insufficient privileges.') }])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the declared eligibility is applied with the same window', async () => {
  const { calls, restore } = routeFetch([{ url: SCHEDULES, respond: collection([liveSchedule()]) }])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a revoked eligibility is critical drift', async () => {
  const { restore } = routeFetch([{ url: SCHEDULES, respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      { field: LABEL, expected: 'eligible', actual: 'absent', severity: 'critical' },
    ])
    assert.equal(leaksSecret(result), false, 'diffs are persisted by the platform — they must not carry the token')
  } finally {
    restore()
  }
})

test('an eligibility re-scoped to an administrative unit no longer matches the tenant-wide one', async () => {
  const AU = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'
  const { restore } = routeFetch([
    { url: SCHEDULES, respond: collection([liveSchedule({ directoryScopeId: `/administrativeUnits/${AU}` })]) },
  ])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()]))

    assert.equal(result.hasDrift, true, 'a narrowed or widened scope is a different eligibility entirely')
    assert.equal(result.diffs[0].actual, 'absent')
  } finally {
    restore()
  }
})

test('an eligibility made permanent in the portal surfaces as an expiration diff', async () => {
  const { restore } = routeFetch([{ url: SCHEDULES, respond: collection([liveSchedule()]) }])
  try {
    const result = await driftDetect(
      driftContext([eligibilityItem({ expirationType: 'afterDuration', duration: 'P30D' })]),
    )

    assert.deepEqual(result.diffs, [
      { field: `${LABEL}.expiration`, expected: 'afterDuration', actual: 'noExpiration', severity: 'warning' },
    ])
  } finally {
    restore()
  }
})

test('an eligibility window extended in the portal surfaces with both durations', async () => {
  const { restore } = routeFetch([
    {
      url: SCHEDULES,
      respond: collection([liveSchedule({ scheduleInfo: { expiration: { type: 'afterDuration', duration: 'P365D' } } })]),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([eligibilityItem({ expirationType: 'afterDuration', duration: 'P30D' })]),
    )

    assert.deepEqual(result.diffs, [
      {
        field: `${LABEL}.expiration`,
        expected: 'duration=P30D',
        actual: 'duration=P365D',
        severity: 'warning',
      },
    ])
  } finally {
    restore()
  }
})

test('the same end instant written differently is not reported as drift', async () => {
  const { restore } = routeFetch([
    {
      url: SCHEDULES,
      respond: collection([
        liveSchedule({ scheduleInfo: { expiration: { type: 'afterDateTime', endDateTime: '2026-12-31T00:00:00Z' } } }),
      ]),
    },
  ])
  try {
    const result = await driftDetect(
      driftContext([
        eligibilityItem({ expirationType: 'afterDateTime', endDateTime: '2026-12-31T00:00:00.000+00:00' }),
      ]),
    )

    assert.deepEqual(result.diffs, [])
  } finally {
    restore()
  }
})

test('a principal that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([{ url: SCHEDULES, respond: collection([liveSchedule()]) }])
  try {
    const result = await driftDetect(driftContext([eligibilityItem({ principalId: 'Ghost User' })]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs, [
      {
        field: `${GLOBAL_ADMIN} → Ghost User @ /`,
        expected: 'resolvable',
        actual: 'unknown target(s): Ghost User',
        severity: 'critical',
      },
    ])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a truncated listing reports "not verified", never a false "absent"', async () => {
  const { restore } = routeFetch([
    {
      url: SCHEDULES,
      respond: page([], 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleEligibilitySchedules?$skiptoken=next'),
    },
  ])
  try {
    const result = await driftDetect(driftContext([eligibilityItem()]))

    assert.ok(
      !result.diffs.some((d) => d.actual === 'absent'),
      'absence cannot be proved from a partial listing',
    )
    const notice = result.diffs.find((d) => d.field === '(eligibility listing)')
    assert.ok(notice, 'the operator has to be told the listing was incomplete')
    assert.equal(notice.severity, 'info')
    assert.match(String(notice.actual), /truncated/)
  } finally {
    restore()
  }
})
