// rollback for npa-rules.
//
// The shared contracts cover the refusals and the restore/delete paths. What is
// specific here: the restore sends the prior snapshot WHOLE, because the PUT
// replaces `rule_data` — a partial body would drop match criteria — and it puts
// back the action and the enabled flag the tenant held, which is the difference
// between undoing a change and leaving an allow rule live.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE_RE = /\/policy\/npa\/rules/
const PRIOR = {
  rule_name: 'veltrix-alpha',
  description: 'edited in the console',
  enabled: '0',
  group_id: '55',
  rule_data: {
    policy_type: 'private-app',
    match_criteria_action: { action_name: 'block' },
    private_apps: ['[LegacyApp]'],
    users: ['bob@acme.test'],
    json_version: 3,
  },
}

registerRollbackGuardContract({ label: 'npa-rules', handler: rollback })

registerCrudRollbackContract({
  label: 'npa-rules',
  handler: rollback,
  basePath: '/policy/npa/rules',
  updateMethod: 'PUT',
  prior: PRIOR,
  assertRestoreBody: (body) => {
    assert.equal(body.enabled, '0', 'a rule that was disabled must not come back enabled')
    assert.equal(body.group_id, '55')
    const data = body.rule_data as Record<string, unknown>
    assert.deepEqual(data.match_criteria_action, { action_name: 'block' }, 'the prior action is restored verbatim')
    assert.deepEqual(data.private_apps, ['[LegacyApp]'])
  },
})

test('npa-rules rollback: sends the recorded snapshot verbatim, adding nothing of its own', async () => {
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'PUT', respond: ok({ rule_id: '4102' }) }])
  try {
    await rollback(rollbackContext({ entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: PRIOR }] }))

    assert.deepEqual(
      bodyOf(writeCalls(calls)[0]),
      PRIOR,
      'anything the rollback adds or drops here is a policy change nobody asked for',
    )
  } finally {
    restore()
  }
})

test('npa-rules rollback: deletes a rule deploy created rather than disabling it', async () => {
  // A rule left behind disabled is still in the policy and can be re-enabled by
  // anyone with console access.
  const { calls, restore } = routeFetch([{ url: BASE_RE, method: 'DELETE', respond: ok() }])
  try {
    const result = await rollback(rollbackContext({ entries: [{ name: 'veltrix-beta', existed: false, id: '9001' }] }))

    assert.equal(result.success, true, result.message)
    const writes = writeCalls(calls)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].method, 'DELETE')
    assert.match(writes[0].url, /\/policy\/npa\/rules\/9001$/)
  } finally {
    restore()
  }
})
