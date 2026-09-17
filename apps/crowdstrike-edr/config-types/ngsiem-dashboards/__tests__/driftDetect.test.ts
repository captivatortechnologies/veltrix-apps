// driftDetect for ngsiem-dashboards.
//
// The shared contract covers the invariants: drift never writes, a deleted
// dashboard is critical drift, and a 500 is never reported as the dashboard
// being gone. What is specific here is the definition comparison — the
// widget/layout object is canonicalized before comparing, so key reordering is
// not drift while an actually different widget set is.

import test from 'node:test'
import assert from 'node:assert/strict'
import driftDetect from '../driftDetect'
import {
  CLIENT_ID,
  TOKEN,
  driftContext,
  entityPage,
  idsPage,
  item,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeFalcon'
import { registerDriftContract } from '../../../lib/__tests__/falconContracts'

const DEFINITION = '{"widgets":[{"title":"Failed logons","query":"#event_simpleName=UserLogonFailed"}],"layout":{"columns":2}}'

const DASHBOARD = item('Authentication overview', {
  name: 'authentication-overview',
  description: 'Failed logon activity across the estate',
  definition: DEFINITION,
  shared: true,
})

registerDriftContract({ label: 'ngsiem-dashboards', handler: driftDetect, items: [DASHBOARD] })

/** The live dashboard exactly matching the canvas, overridable field by field. */
const live = (over: Record<string, unknown> = {}) => ({
  id: 'dash-live-1',
  name: 'authentication-overview',
  description: 'Failed logon activity across the estate',
  definition: JSON.parse(DEFINITION) as Record<string, unknown>,
  shared: true,
  ...over,
})

/** The two-call lookup every entity-adapter read performs: id query, then get. */
function lookup(entity: Record<string, unknown> | null) {
  return entity === null
    ? [TOKEN, { status: 200, body: { resources: [] } }]
    : [TOKEN, idsPage([String(entity.id)]), entityPage([entity])]
}

test('ngsiem-dashboards driftDetect: reports no drift when the tenant matches', async () => {
  const { calls, restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    assert.equal(result.hasDrift, false, `unexpected drift: ${JSON.stringify(result.diffs)}`)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reports a widget definition edited in the console', async () => {
  const { restore } = recordFetch(
    lookup(
      live({
        definition: {
          widgets: [{ title: 'Failed logons', query: '#event_simpleName=UserLogonSuccess' }],
          layout: { columns: 2 },
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    assert.equal(result.hasDrift, true)
    const diff = result.diffs.find((d) => d.field === 'authentication-overview.definition')
    assert.ok(diff, `expected a definition diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.severity, 'critical')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: ignores JSON key ORDER, which the API does not preserve', async () => {
  // The definition is canonicalized (keys sorted, array order kept) before
  // comparing, so a re-serialized object is not reported as a changed dashboard.
  const { restore } = recordFetch(
    lookup(
      live({
        definition: {
          layout: { columns: 2 },
          widgets: [{ query: '#event_simpleName=UserLogonFailed', title: 'Failed logons' }],
        },
      }),
    ),
  )
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    assert.equal(result.hasDrift, false, `reordered keys are not drift: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reports a widget ORDER change, which is a different dashboard', async () => {
  const twoWidgets = item('Authentication overview', {
    name: 'authentication-overview',
    definition: '{"widgets":[{"title":"A"},{"title":"B"}]}',
    shared: true,
  })
  const { restore } = recordFetch(
    lookup(live({ definition: { widgets: [{ title: 'B' }, { title: 'A' }] } })),
  )
  try {
    const result = await driftDetect(driftContext([twoWidgets]))

    assert.ok(
      result.diffs.some((d) => d.field === 'authentication-overview.definition'),
      `widget order is significant: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reports a dashboard un-shared in the console', async () => {
  const { restore } = recordFetch(lookup(live({ shared: false })))
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    const diff = result.diffs.find((d) => d.field === 'authentication-overview.shared')
    assert.ok(diff, `expected a shared diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.expected, true)
    assert.equal(diff.actual, false)
    assert.equal(diff.severity, 'warning')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reads the sharing flag from either field name', async () => {
  // The template representation is not fully documented — `is_shared` is
  // accepted as an alias so an unexpected field name is not permanent drift.
  const { restore } = recordFetch(lookup(live({ shared: undefined, is_shared: true })))
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    assert.equal(
      result.diffs.some((d) => d.field === 'authentication-overview.shared'),
      false,
      `is_shared was not read: ${JSON.stringify(result.diffs)}`,
    )
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reports a description edited in the console', async () => {
  const { restore } = recordFetch(lookup(live({ description: 'edited by hand' })))
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    const diff = result.diffs.find((d) => d.field === 'authentication-overview.description')
    assert.ok(diff, `expected a description diff, got ${JSON.stringify(result.diffs)}`)
    assert.equal(diff.actual, 'edited by hand')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: attributes a manual change to the operator who made it', async () => {
  const { restore } = recordFetch(
    lookup(live({ shared: false, updated_by: 'alice@acme.com', updated_at: '2026-01-04T10:00:00Z' })),
  )
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    const diff = result.diffs.find((d) => d.field === 'authentication-overview.shared')
    assert.ok(diff)
    assert.equal(diff.actor?.email, 'alice@acme.com')
    assert.equal(diff.actor?.at, '2026-01-04T10:00:00Z')
    assert.equal(diff.actor?.source, 'crowdstrike-audit')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: does not attribute drift to our own API client', async () => {
  // A change last written by the connection's own API client is a Veltrix
  // deploy, not a manual edit — reporting it as one sends an operator hunting.
  const { restore } = recordFetch(lookup(live({ shared: false, updated_by: CLIENT_ID })))
  try {
    const result = await driftDetect(driftContext([DASHBOARD]))

    const diff = result.diffs.find((d) => d.field === 'authentication-overview.shared')
    assert.ok(diff, 'the drift itself is still reported')
    assert.equal(diff.actor, undefined, 'our own deploy must not be attributed as a manual change')
  } finally {
    restore()
  }
})

test('ngsiem-dashboards driftDetect: reads the DEPLOYED config, not the current canvas', async () => {
  // Drift compares the tenant against what was last deployed. An edit the
  // operator has made on the canvas but not yet deployed is not drift.
  const edited = item('Authentication overview', {
    name: 'authentication-overview',
    description: 'Failed logon activity across the estate',
    definition: '{"widgets":[{"title":"Something else"}]}',
    shared: false,
  })
  const { restore } = recordFetch(lookup(live()))
  try {
    const result = await driftDetect(driftContext([DASHBOARD], { canvasItems: [edited] }))

    assert.equal(result.hasDrift, false, `compared against the canvas: ${JSON.stringify(result.diffs)}`)
  } finally {
    restore()
  }
})
