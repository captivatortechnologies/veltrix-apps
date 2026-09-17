// rollback for rbac-labels.
//
// The shared contracts cover the refusals (no credential, no tenant host,
// nothing recorded, an entry with no id, an entry with no prior body) and the
// restore/delete/404/error paths. What is specific here: the restore body is the
// prior name and colour deploy captured, with a blank colour omitted exactly as
// the deploy body omits it.

import test from 'node:test'
import assert from 'node:assert/strict'
import rollback from '../rollback'
import { bodyOf, ok, rollbackContext, routeFetch, writeCalls } from '../../../lib/__tests__/fakeNetskope'
import {
  registerCrudRollbackContract,
  registerRollbackGuardContract,
} from '../../../lib/__tests__/netskopeContracts'

const BASE = '/rbac/labels'

registerRollbackGuardContract({ label: 'rbac-labels', handler: rollback })

registerCrudRollbackContract({
  label: 'rbac-labels',
  handler: rollback,
  basePath: BASE,
  updateMethod: 'PATCH',
  prior: { name: 'veltrix-alpha', color: '#ffeedd' },
  assertRestoreBody: (body) => {
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal(body.color, '#ffeedd', 'the restore must write back the colour deploy found, not the one it wrote')
  },
})

test('rbac-labels rollback: omits color when the label had none before the deploy', async () => {
  const { calls, restore } = routeFetch([{ url: /\/rbac\/labels/, method: 'PATCH', respond: ok({ id: '4102' }) }])
  try {
    const result = await rollback(
      rollbackContext({
        entries: [{ name: 'veltrix-alpha', existed: true, id: '4102', prior: { name: 'veltrix-alpha', color: '' } }],
      }),
    )

    assert.equal(result.success, true, result.message)
    const body = bodyOf(writeCalls(calls)[0]) ?? {}
    assert.equal(body.name, 'veltrix-alpha')
    assert.equal('color' in body, false, 'a label that had no colour must not be restored with one')
  } finally {
    restore()
  }
})
