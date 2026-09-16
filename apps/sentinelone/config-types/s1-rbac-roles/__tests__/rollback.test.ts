import rollback from '../rollback'
import type { RbacRoleRollbackEntry } from '../deploy'
import {
  SCOPELESS_SETTINGS,
  apiError,
  dataOf,
  envelope,
  filterOf,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-rbac-roles'
const ROLES = '/rbac/roles'

function ctx(previousState: RbacRoleRollbackEntry[] | undefined, settings?: Record<string, unknown>) {
  return rollbackContext(previousState === undefined ? {} : { previousState }, {
    configTypeId: CONFIG_TYPE,
    settings,
  })
}

const created: RbacRoleRollbackEntry = {
  key: 'soc analyst',
  label: 'SOC Analyst',
  existed: false,
  id: 'role-new',
}

const updated: RbacRoleRollbackEntry = {
  key: 'legacy admin',
  label: 'Legacy admin',
  existed: true,
  id: 'role-1',
  prior: {
    name: 'Legacy admin',
    description: 'original',
    permissions: { threats: { mitigate: false }, agents: { reboot: true } },
  },
}

describe('SentinelOne RBAC Roles Rollback Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created] }, { configTypeId: CONFIG_TYPE, credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Scope ID setting is unset', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([updated], SCOPELESS_SETTINGS))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Scope ID/)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports failure and touches nothing when there is no previous state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No previous state available for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a role the deploy created', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(ROLES)
      expect(dataOf(calls[0])).toEqual({ ids: ['role-new'] })
    })
  })

  it('restores an updated role to its complete pre-deploy permission tree', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('PUT')
      expect(filterOf(calls[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(calls[0])).toEqual({
        id: 'role-1',
        name: 'Legacy admin',
        description: 'original',
        permissions: { threats: { mitigate: false }, agents: { reboot: true } },
      })
    })
  })

  it('restores an un-wrapped prior permission tree using the same extraction rule as deploy', async () => {
    const unwrapped: RbacRoleRollbackEntry = {
      ...updated,
      prior: { threats: { mitigate: false } },
    }
    await withFetch([envelope({})], async (calls) => {
      await rollback(ctx([unwrapped]))

      expect(dataOf(calls[0]).permissions).toEqual({ threats: { mitigate: false } })
      // The role name falls back to the recorded label when the prior carries none.
      expect(dataOf(calls[0]).name).toBe('Legacy admin')
    })
  })

  it('reverts in reverse deploy order so later writes are undone first', async () => {
    await withFetch([envelope({}), envelope({})], async (calls) => {
      await rollback(ctx([updated, created]))

      expect(calls[0].method).toBe('DELETE')
      expect(calls[1].method).toBe('PUT')
    })
  })

  it('treats a role already deleted out-of-band (404) as reverted', async () => {
    await withFetch([apiError('not found', 404)], async () => {
      const result = await rollback(ctx([created]))
      expect(result.success).toBe(true)
    })
  })

  it('reports failure rather than throwing when a restore is rejected', async () => {
    await withFetch([apiError('access denied', 403)], async () => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/access denied/)
    })
  })
})
