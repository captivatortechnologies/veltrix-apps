// ============================================================================
// deploy for ISC notification templates.
//
// There is no PATCH or PUT here: POSTing a template replaces the tenant's custom
// override for that (key, medium, locale). So every deploy overwrites, and the
// only thing standing between an overwrite and a permanent loss is the `existed`
// flag and the prior snapshot recorded alongside it — captured from the listing
// taken BEFORE the POST.
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TOKEN,
  assertAuthenticatedFirst,
  bodyOf,
  deployContext,
  iscError,
  leaksSecret,
  listPage,
  ok,
  pathOf,
  recordFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeIsc'
import { MISSING_CREDENTIAL_MESSAGE } from '../../../lib/isc'
import deploy from '../deploy'
import { BASE, BULK_DELETE, KEY, LOCALE, MEDIUM, PRIOR, liveTemplate, templateItem } from './fixtures'

type Entries = Array<Record<string, unknown>>

function entriesOf(result: { rollbackData?: unknown }): Entries {
  return ((result.rollbackData as { entries?: Entries } | undefined)?.entries ?? []) as Entries
}

test('notification-templates deploy: refuses without a credential instead of calling ISC', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([templateItem()], { credential: null }))

    assert.equal(result.success, false)
    assert.equal(result.message, MISSING_CREDENTIAL_MESSAGE)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('notification-templates deploy: refuses when the tenant setting is missing', async () => {
  const { calls, restore } = recordFetch([])
  try {
    const result = await deploy(deployContext([templateItem()], { settings: {} }))

    assert.equal(result.success, false)
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('notification-templates deploy: a failed listing stops the deploy before it writes', async () => {
  // The listing is where `existed` and the prior snapshot come from. Writing
  // without it would overwrite a template with no record of what it said.
  const { calls, restore } = recordFetch([TOKEN, iscError(500, 'upstream failure')])
  try {
    const result = await deploy(deployContext([templateItem()]))

    assert.equal(result.success, false)
    assert.match(result.message, /Failed to list/i)
    assert.equal(writeCalls(calls).length, 0)
  } finally {
    restore()
  }
})

test('notification-templates deploy: creates an override the tenant does not have yet', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), ok({})])
  try {
    const result = await deploy(deployContext([templateItem()]))

    assert.equal(result.success, true, result.message)
    const iscCalls = assertAuthenticatedFirst(assert, calls)
    assert.ok(pathOf(iscCalls[0]).startsWith(BASE))

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'POST')
    assert.equal(pathOf(writes[0]), BASE)
    const body = bodyOf(writes[0]) as Record<string, unknown>
    assert.equal(body.key, KEY)
    assert.equal(body.medium, MEDIUM)
    assert.equal(body.locale, LOCALE)
    assert.equal(body.subject, 'You have access requests waiting')

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false, 'a template with no prior override must be recorded as new')
    assert.equal(entries[0].prior, undefined, 'there was nothing there — nothing must be invented')
  } finally {
    restore()
  }
})

test('notification-templates deploy: records the LIVE prior override it is about to replace', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([liveTemplate()]), ok({})])
  try {
    const result = await deploy(deployContext([templateItem()]))

    assert.equal(result.success, true, result.message)
    assert.equal(writeCalls(calls).length, 1)

    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, true, 'an override that was already there must be recorded as pre-existing')
    assert.deepEqual(entries[0].prior, PRIOR)
  } finally {
    restore()
  }
})

test('notification-templates deploy: matches the override by key, medium AND locale', async () => {
  // Same key and medium, different locale — a different template entirely. The
  // German override must not be recorded as the prior state of the English one.
  const { restore } = recordFetch([TOKEN, listPage([liveTemplate({ locale: 'de' })]), ok({})])
  try {
    const result = await deploy(deployContext([templateItem()]))

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].prior, undefined)
  } finally {
    restore()
  }
})

test('notification-templates deploy: reports a rejected write rather than throwing', async () => {
  const { restore } = recordFetch([TOKEN, listPage([]), iscError(400, 'the template key is not recognised')])
  try {
    const result = await deploy(deployContext([templateItem()]))

    assert.equal(result.success, false)
    assert.ok(result.message.includes('the template key is not recognised'), result.message)
    assert.ok(result.rollbackData)
    assert.equal(leaksSecret(result), false)
  } finally {
    restore()
  }
})

test('notification-templates deploy: bulk-deletes the overrides it created and no longer declares', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), ok({}), ok({})])
  try {
    const result = await deploy(
      deployContext([templateItem()], {
        priorRollbackData: {
          entries: [{ key: 'retired_template', medium: 'EMAIL', locale: 'en', existed: false }],
        },
      }),
    )

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 2)
    assert.equal(pathOf(writes[1]), BULK_DELETE)
    assert.deepEqual(bodyOf(writes[1]), [{ key: 'retired_template', medium: 'EMAIL', locale: 'en' }])
  } finally {
    restore()
  }
})

test('notification-templates deploy: never bulk-deletes an override the tenant already had', async () => {
  const { calls, restore } = recordFetch([TOKEN, listPage([]), ok({})])
  try {
    await deploy(
      deployContext([templateItem()], {
        priorRollbackData: {
          entries: [{ key: 'their_template', medium: 'EMAIL', locale: 'en', existed: true, prior: {} }],
        },
      }),
    )

    const writes = writeCalls(calls)
    assert.equal(writes.length, 1, 'only the declared template should have been written')
    assert.equal(pathOf(writes[0]), BASE)
  } finally {
    restore()
  }
})
