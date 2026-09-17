// deploy for zia-dlp-notification-templates.
//
// What is specific to this type and worth driving end to end:
//   * identity is `name` and the id is NUMERIC; there is no predefined/built-in
//     variant to refuse, so every matching template is fair game for a PUT;
//   * the two booleans carry defaults the canvas can leave unset — `tlsEnabled`
//     defaults FALSE and `attachContent` defaults TRUE — and both are always sent;
//   * `htmlMessage` is sent even when blank, so clearing it converges the live
//     template;
//   * the update path must record the LIVE prior bodies, which are the only thing
//     rollback can restore;
//   * ZIA stages writes, so a deploy that never reaches `/status/activate` has
//     changed nothing the customer can see.
//
// NOT asserted, deliberately: the path where the POST succeeds but the response
// carries no id. deploy throws there BEFORE pushing the rollback entry, so the
// template exists in the tenant with nothing recorded — see the report.

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
  ok,
  recordFetch,
  resourceWrites,
  routeFetch,
  serverError,
  ziaError,
  ziaList,
} from '../../../lib/__tests__/fakeZscaler'
import { registerDeployGuardContract } from '../../../lib/__tests__/zscalerContracts'

const TEMPLATE = item('Acme DLP Notice', {
  name: 'Acme DLP Notice',
  subject: 'DLP violation detected',
  plain_text_message: 'Your upload was blocked by Acme DLP.',
  html_message: '<p>Your upload was blocked by Acme DLP.</p>',
  tls_enabled: true,
  attach_content: false,
})

/**
 * The live template, deliberately UNLIKE the canvas: a different subject, a
 * different body, no HTML and both booleans the other way round. A rollback entry
 * mirroring the canvas rather than this has recorded the desired state, not the
 * prior state.
 */
const LIVE = {
  id: 9901,
  name: 'Acme DLP Notice',
  subject: 'Policy notification',
  plainTextMessage: 'edited in the ZIA console',
  htmlMessage: '',
  tlsEnabled: false,
  attachContent: true,
}

const OTHER = { id: 9999, name: 'Something Else' }

registerDeployGuardContract({
  label: 'zia-dlp-notification-templates',
  handler: deploy,
  product: 'zia',
  items: [TEMPLATE],
})

test('zia-dlp-notification-templates deploy: creates a template that does not exist, then activates', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 9910, name: 'Acme DLP Notice' }),
    ACTIVATED,
  ])
  try {
    const result = await deploy(deployContext([TEMPLATE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[0].method, 'GET')
    assert.match(tenant[0].url, /\/zia\/api\/v1\/dlpNotificationTemplates\?/)
    assert.equal(tenant[1].method, 'POST')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpNotificationTemplates$/)

    const body = bodyOf(tenant[1])
    assert.equal(body?.name, 'Acme DLP Notice')
    assert.equal(body?.subject, 'DLP violation detected')
    assert.equal(body?.plainTextMessage, 'Your upload was blocked by Acme DLP.')
    assert.equal(body?.htmlMessage, '<p>Your upload was blocked by Acme DLP.</p>')
    assert.equal(body?.tlsEnabled, true)
    assert.equal(body?.attachContent, false)

    assert.equal(activateCalls(calls).length, 1, 'a staged ZIA write is invisible until activation')
    assert.equal(result.success, true)

    const rollback = result.rollbackData as { previousState: Array<Record<string, unknown>>; createdIds: number[] }
    assert.deepEqual(rollback.previousState, [{ name: 'Acme DLP Notice', existed: false, id: 9910 }])
    assert.deepEqual(rollback.createdIds, [9910])
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates deploy: sends the ZIA defaults for booleans the canvas leaves unset', async () => {
  // attach_content defaults ON and tls_enabled OFF, and both are sent on every
  // write — a template deployed from a canvas that never mentions them must not
  // silently flip the live setting.
  const minimal = item('Acme DLP Notice', {
    name: 'Acme DLP Notice',
    subject: 'DLP violation detected',
    plain_text_message: 'Your upload was blocked by Acme DLP.',
  })
  const { calls, restore } = recordFetch([TOKEN, ziaList([OTHER]), created({ id: 9910 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([minimal]))

    const body = bodyOf(assertAuthenticatedFirst(assert, calls)[1])
    assert.equal(body?.tlsEnabled, false)
    assert.equal(body?.attachContent, true)
    assert.equal(body?.htmlMessage, '', 'a blank HTML body is sent so clearing it converges')
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates deploy: updates an existing template and records its LIVE prior body', async () => {
  const { calls, restore } = recordFetch([TOKEN, ziaList([LIVE]), ok({ id: 9901 }), ACTIVATED])
  try {
    const result = await deploy(deployContext([TEMPLATE]))

    const tenant = assertAuthenticatedFirst(assert, calls)
    assert.equal(tenant[1].method, 'PUT', 'a template that exists is updated, not created')
    assert.match(tenant[1].url, /\/zia\/api\/v1\/dlpNotificationTemplates\/9901$/)
    assert.equal(bodyOf(tenant[1])?.subject, 'DLP violation detected')

    assert.equal(result.success, true)
    const rollback = result.rollbackData as {
      previousState: Array<{ existed: boolean; id: number; prior: Record<string, unknown> }>
    }
    const entry = rollback.previousState[0]
    assert.equal(entry.existed, true)
    assert.equal(entry.id, 9901)
    assert.equal(entry.prior.subject, 'Policy notification', 'rollback must restore what was there')
    assert.equal(entry.prior.plainTextMessage, 'edited in the ZIA console')
    assert.equal(entry.prior.tlsEnabled, false)
    assert.equal(entry.prior.attachContent, true)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates deploy: a rejected write fails the deploy rather than throwing', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([LIVE]),
    ziaError(400, 'Unsupported token in notification subject'),
  ])
  try {
    const result = await deploy(deployContext([TEMPLATE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Unsupported token in notification subject/)
    assert.equal(activateCalls(calls).length, 0, 'a failed write must not be activated')
    // The PUT already overwrote the live template, so the prior body deploy read
    // beforehand has to survive on the failure path or it can never be restored.
    const rollback = result.rollbackData as { previousState: Array<{ prior?: { subject?: string } }> }
    assert.equal(rollback.previousState.length, 1)
    assert.equal(rollback.previousState[0].prior?.subject, 'Policy notification')
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates deploy: a failed listing stops the deploy before it writes anything', async () => {
  const { calls, restore } = routeFetch([{ url: /\/dlpNotificationTemplates/, respond: serverError() }])
  try {
    const result = await deploy(deployContext([TEMPLATE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed to list DLP notification templates/)
    assert.equal(resourceWrites(calls).length, 0, 'an unreadable tenant must not be written to')
    assert.equal(activateCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('zia-dlp-notification-templates deploy: a failed activation reports the writes as staged, and keeps rollback state', async () => {
  const { calls, restore } = recordFetch([
    TOKEN,
    ziaList([OTHER]),
    created({ id: 9910 }),
    ziaError(409, 'Another activation is already in progress'),
  ])
  try {
    const result = await deploy(deployContext([TEMPLATE]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /activation failed/)
    assert.match(String(result.message), /saved but not active/)
    assert.equal(activateCalls(calls).length, 1)
    const rollback = result.rollbackData as { createdIds: number[] }
    assert.deepEqual(rollback.createdIds, [9910], 'the staged template still exists and must be revertible')
  } finally {
    restore()
  }
})
