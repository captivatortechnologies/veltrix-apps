// deploy for zia-file-type-rules.
//
// What is specific to this type:
//   * identity is the rule NAME and the id is numeric, so an existing rule is
//     PUT to /fileTypeRules/{id} rather than POSTed again;
//   * the file types themselves are not first-class fields — they, the
//     protocols and every object reference arrive as the `rule_json` escape
//     hatch, so a rule deployed without them inspects nothing the author meant;
//   * state and action are normalised to the vendor's casing before they are
//     sent, and an unrecognised action falls back to BLOCK;
//   * ZIA STAGES writes, so nothing is live until /status/activate.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  ACTIVATED,
  TOKEN,
  activateCalls,
  assertAuthenticatedFirst,
  bodyOf,
  created,
  deployContext,
  item,
  leaksSecret,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  writeCalls,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const RULE = item('Caution On Spreadsheets', {
  name: 'Caution On Spreadsheets',
  order: 12,
  state: 'DISABLED',
  action: 'CAUTION',
  rule_json: JSON.stringify({
    fileTypes: ['FTCATEGORY_MS_EXCEL', 'FTCATEGORY_PDF'],
    protocols: ['HTTPS_RULE'],
    urlCategories: ['INTERNET_SERVICES'],
    labels: [{ id: 44 }],
  }),
})

/**
 * The live rule, deliberately UNLIKE the canvas: it ALLOWS where the canvas
 * cautions, is enabled, sits at a different order and covers a different file
 * type. A rollback entry that mirrors the canvas rather than this has recorded
 * the desired state instead of the prior state.
 */
const LIVE = {
  id: 505,
  name: 'Caution On Spreadsheets',
  order: 3,
  rank: 7,
  state: 'ENABLED',
  action: 'ALLOW',
  fileTypes: ['FTCATEGORY_ENCRYPT'],
  labels: [{ id: 99, name: 'Hand-made legacy label' }],
}

registerDeployGuardContract({ label: 'zia-file-type-rules', handler: deploy, product: 'zia', items: [RULE] })

test('zia-file-type-rules deploy: creates a rule that does not exist, with the file types it was given', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 1, name: 'Something Else', order: 1 }]),
    created({ id: 5001, name: 'Caution On Spreadsheets' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/fileTypeRules\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/fileTypeRules$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Caution On Spreadsheets')
    assert.equal(body?.order, 12)
    assert.equal(body?.state, 'DISABLED', 'a rule written ENABLED when the author disabled it is a live rule')
    assert.equal(body?.action, 'CAUTION')
    assert.deepEqual(
      body?.fileTypes,
      ['FTCATEGORY_MS_EXCEL', 'FTCATEGORY_PDF'],
      'a file type rule with no file types inspects nothing',
    )
    assert.deepEqual(body?.protocols, ['HTTPS_RULE'])
    assert.deepEqual(body?.urlCategories, ['INTERNET_SERVICES'])
    assert.deepEqual(body?.labels, [{ id: 44 }])

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: unknown[]; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Caution On Spreadsheets', existed: false, id: 5001 }])
    assert.deepEqual(rollback.createdIds, [5001])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: normalises the authored state and action to the vendor casing', async () => {
  const lowercased = item('Caution On Spreadsheets', {
    name: 'Caution On Spreadsheets',
    order: 12,
    state: 'disabled',
    action: 'caution',
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 5002 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([lowercased]))

    const body = bodyOf(calls.find((c) => c.method === 'POST' && c.url.endsWith('/fileTypeRules')))
    assert.equal(body?.state, 'DISABLED')
    assert.equal(body?.action, 'CAUTION')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: the JSON escape hatch can never rename the rule', async () => {
  // Identity is the name, so a JSON `name` must lose to the first-class field —
  // otherwise the next deploy would not recognise its own rule and would create
  // a duplicate. The other scalars are NOT asserted here: the JSON wins over
  // them while driftDetect compares the first-class values, and asserting that
  // would bless it — reported instead.
  const overriding = item('Caution On Spreadsheets', {
    name: 'Caution On Spreadsheets',
    order: 12,
    state: 'DISABLED',
    action: 'CAUTION',
    rule_json: JSON.stringify({ name: 'Renamed', fileTypes: ['FTCATEGORY_PDF'] }),
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([]), created({ id: 5003 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([overriding]))

    const body = bodyOf(calls.find((c) => c.method === 'POST' && c.url.endsWith('/fileTypeRules')))
    assert.equal(body?.name, 'Caution On Spreadsheets')
    assert.deepEqual(body?.fileTypes, ['FTCATEGORY_PDF'])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: updates an existing rule and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), created({ id: 505 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([RULE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a rule that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/fileTypeRules\/505$/)
    assert.equal(bodyOf(tenant[1])?.action, 'CAUTION')
    assert.deepEqual(bodyOf(tenant[1])?.fileTypes, ['FTCATEGORY_MS_EXCEL', 'FTCATEGORY_PDF'])

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 505)
    assert.equal(entry.prior.action, 'ALLOW', 'rollback must restore what was there, not what we wanted')
    assert.equal(entry.prior.state, 'ENABLED')
    assert.equal(entry.prior.order, 3)
    assert.deepEqual(entry.prior.fileTypes, ['FTCATEGORY_ENCRYPT'])
    assert.deepEqual(entry.prior.labels, [{ id: 99, name: 'Hand-made legacy label' }])
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: refuses to overwrite the protected default rule, and writes nothing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([{ id: 9, name: 'Caution On Spreadsheets', isDefaultRule: true }]),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /protected default file type rule/)
    assert.equal(writeCalls(calls).length, 0, 'the built-in rule must never be written to')
    const rollback = result.rollbackData as { previousState: unknown[] }
    assert.deepEqual(rollback.previousState, [], 'the default rule is never captured for rollback')
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Unknown file type FTCATEGORY_MS_EXCEL'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Unknown file type FTCATEGORY_MS_EXCEL/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already reached the live rule, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { action?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.action, 'ALLOW')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/fileTypeRules/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list file type rules/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-file-type-rules deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([]),
    created({ id: 5004 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([RULE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [5004], 'the staged rule still exists and must be revertible')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

// NOT asserted: a POST that answers 200 with no id. deploy throws that case
// BEFORE pushing the rollback entry, so the staged rule exists in the tenant
// with nothing recorded to revert it. Asserting the empty rollbackData would
// bless it — reported instead.
