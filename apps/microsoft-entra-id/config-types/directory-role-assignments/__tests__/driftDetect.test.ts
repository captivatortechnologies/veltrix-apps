// ============================================================================
// driftDetect for directory role assignments, against a fake Microsoft Graph.
//
// The assignment is immutable, so the only drift is a declared grant that is no
// longer in the directory. The subtle case — and the one worth a test — is a
// TRUNCATED listing: absence cannot be proved from a partial read, so the
// handler must say "not verified" rather than raise a critical "absent" that
// would send an operator chasing a revocation that never happened.
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

const ASSIGNMENTS = /\/roleManagement\/directory\/roleAssignments$/
const GLOBAL_ADMIN = '62e90394-69f5-4237-9190-012177145e10'
const ADA = '071cc716-8147-4397-a5ba-b2105951cc0b'

function grant(fields: Record<string, unknown> = {}) {
  return item('Global admin for Ada', {
    roleDefinitionId: GLOBAL_ADMIN,
    principalId: ADA,
    label: 'Global admin for Ada',
    ...fields,
  })
}

const LIVE = { id: 'ra-live', roleDefinitionId: GLOBAL_ADMIN, principalId: ADA, directoryScopeId: '/' }

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([grant()], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed listing reports no drift and writes nothing', async () => {
  const { calls, restore } = routeFetch([
    { url: ASSIGNMENTS, method: 'GET', respond: graphError(403, 'Insufficient privileges.') },
  ])
  try {
    const result = await driftDetect(driftContext([grant()]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when the declared grant is live', async () => {
  const { calls, restore } = routeFetch([{ url: ASSIGNMENTS, method: 'GET', respond: collection([LIVE]) }])
  try {
    const result = await driftDetect(driftContext([grant()]))

    assert.deepEqual(result.diffs, [])
    assert.equal(result.hasDrift, false)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('a revoked grant is critical drift', async () => {
  const { restore } = routeFetch([{ url: ASSIGNMENTS, method: 'GET', respond: collection([]) }])
  try {
    const result = await driftDetect(driftContext([grant()]))

    assert.equal(result.hasDrift, true)
    assert.deepEqual(result.diffs[0], {
      field: 'Global admin for Ada',
      expected: 'present',
      actual: 'absent',
      severity: 'critical',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a truncated listing reports "not verified", never a false "absent"', async () => {
  const { restore } = routeFetch([
    {
      url: ASSIGNMENTS,
      method: 'GET',
      respond: page([], 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments'),
    },
  ])
  try {
    const result = await driftDetect(driftContext([grant()]))

    assert.ok(
      !result.diffs.some((d) => d.actual === 'absent'),
      'absence cannot be proved from a partial listing',
    )
    const notice = result.diffs.find((d) => d.field === '(role-assignment listing)')
    assert.ok(notice, 'the operator has to be told the listing was incomplete')
    assert.equal(notice.severity, 'info')
    assert.match(String(notice.actual), /truncated/)
  } finally {
    restore()
  }
})

test('a scope that no longer resolves is critical drift, not a silent pass', async () => {
  const { restore } = routeFetch([{ url: ASSIGNMENTS, method: 'GET', respond: collection([LIVE]) }])
  try {
    const result = await driftDetect(driftContext([grant({ directoryScopeId: 'Ghost Unit' })]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs[0].severity, 'critical')
    assert.match(String(result.diffs[0].actual), /Ghost Unit/)
  } finally {
    restore()
  }
})

test('a grant re-scoped to an administrative unit no longer matches the tenant-wide one', async () => {
  const AU = '5d107bba-d8e2-4e13-b6ae-884be90e5d1a'
  const { restore } = routeFetch([
    {
      url: ASSIGNMENTS,
      method: 'GET',
      respond: collection([{ ...LIVE, directoryScopeId: `/administrativeUnits/${AU}` }]),
    },
  ])
  try {
    const result = await driftDetect(driftContext([grant()]))

    assert.equal(result.hasDrift, true, 'a narrowed or widened scope is a different grant entirely')
    assert.equal(result.diffs[0].actual, 'absent')
  } finally {
    restore()
  }
})
