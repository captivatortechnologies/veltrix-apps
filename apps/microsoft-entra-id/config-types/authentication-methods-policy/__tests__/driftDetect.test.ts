// ============================================================================
// driftDetect for the Entra authentication methods policy, against a fake Graph.
//
// A method quietly re-enabled in the portal is a new way into every account in
// the tenant — SMS re-enabled after an SS7 review, say, or a Temporary Access
// Pass left on. The state comparison is the whole detector, so both directions
// of it are pinned here down to `field`, `expected`, `actual` and `severity`.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  driftContext,
  graphError,
  item,
  leaksSecret,
  recordFetch,
  resource,
  vendorCalls,
  writeCalls,
} from '../../../lib/__tests__/fakeGraph'
import driftDetect from '../driftDetect'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

function methodItem(method: string, state?: string) {
  return item(method, state === undefined ? { method } : { method, state })
}

function liveMethod(id: string, state: string) {
  return resource({ id, state })
}

test('driftDetect makes no Graph call at all without a credential', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([methodItem('sms', 'disabled')], { credential: null }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('driftDetect makes no Graph call when the directory (tenant) id setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([methodItem('sms', 'disabled')], { settings: {} }))

    assert.deepEqual(result, { hasDrift: false, diffs: [], checked: false })
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a failed read reports no drift and, crucially, writes nothing', async () => {
  const { calls, restore } = recordFetch([TOKEN, graphError(403, 'Insufficient privileges to complete the operation.')])
  try {
    const result = await driftDetect(driftContext([methodItem('sms', 'disabled')]))

    assert.equal(result.hasDrift, false)
    assert.deepEqual(result.diffs, [])
    assert.equal(writeCalls(calls).length, 0, 'drift detection must never write')
  } finally {
    restore()
  }
})

test('reports no drift when every live method state matches the deployed canvas', async () => {
  const { calls, restore } = recordFetch([TOKEN, liveMethod('sms', 'disabled'), liveMethod('fido2', 'enabled')])
  try {
    const result = await driftDetect(driftContext([methodItem('sms', 'disabled'), methodItem('fido2', 'enabled')]))

    const graphCalls = assertAuthenticatedFirst(assert, calls)
    assert.equal(graphCalls.length, 2)
    assert.ok(graphCalls.every((c) => c.method === 'GET'))
    assert.ok(graphCalls[0].url.includes(`${BASE}/sms?$select=id,state`))
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('SMS re-enabled out of band is drift', async () => {
  const { restore } = recordFetch([TOKEN, liveMethod('sms', 'enabled')])
  try {
    const result = await driftDetect(driftContext([methodItem('sms', 'disabled')]))

    assert.equal(result.hasDrift, true)
    assert.equal(result.diffs.length, 1)
    assert.deepEqual(result.diffs[0], {
      field: 'sms.state',
      expected: 'disabled',
      actual: 'enabled',
      severity: 'warning',
    })
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('a method switched OFF out of band is drift too — this is not a one-way check', async () => {
  // FIDO2 turned off in the portal strands every user who registered a key.
  const { restore } = recordFetch([TOKEN, liveMethod('fido2', 'disabled')])
  try {
    const result = await driftDetect(driftContext([methodItem('fido2', 'enabled')]))

    assert.deepEqual(result.diffs[0], {
      field: 'fido2.state',
      expected: 'enabled',
      actual: 'disabled',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('every drifted method gets its own diff', async () => {
  const { restore } = recordFetch([
    TOKEN,
    liveMethod('sms', 'enabled'),
    liveMethod('voice', 'enabled'),
    liveMethod('email', 'disabled'),
  ])
  try {
    const result = await driftDetect(
      driftContext([methodItem('sms', 'disabled'), methodItem('voice', 'disabled'), methodItem('email', 'disabled')]),
    )

    assert.equal(result.diffs.length, 2)
    assert.deepEqual(
      result.diffs.map((d) => d.field),
      ['sms.state', 'voice.state'],
    )
  } finally {
    restore()
  }
})

test('a method configuration Graph returns without a state is read as disabled', async () => {
  const { restore } = recordFetch([TOKEN, resource({ id: 'temporaryAccessPass' })])
  try {
    const result = await driftDetect(driftContext([methodItem('temporaryAccessPass', 'enabled')]))

    assert.deepEqual(result.diffs[0], {
      field: 'temporaryAccessPass.state',
      expected: 'enabled',
      actual: 'disabled',
      severity: 'warning',
    })
  } finally {
    restore()
  }
})

test('a method id Graph does not know about is not probed at all', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await driftDetect(driftContext([methodItem('passkeyOverCarrierPigeon', 'enabled')]))

    assert.equal(vendorCalls(calls).length, 0)
    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})

test('drift compares the DEPLOYED canvas, not an edit that has not been deployed yet', async () => {
  const { restore } = recordFetch([TOKEN, liveMethod('sms', 'enabled')])
  try {
    const result = await driftDetect(
      driftContext([methodItem('sms', 'disabled')], { deployedItems: [methodItem('sms', 'enabled')] }),
    )

    assert.deepEqual(result, { hasDrift: false, diffs: [] })
  } finally {
    restore()
  }
})
