import rollback from '../rollback'
import type { GroupRollbackEntry } from '../deploy'
import {
  SITE_SETTINGS,
  apiError,
  dataOf,
  envelope,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-groups'

function ctx(previousState: GroupRollbackEntry[] | undefined) {
  return rollbackContext(previousState === undefined ? {} : { previousState }, {
    configTypeId: CONFIG_TYPE,
    settings: SITE_SETTINGS,
  })
}

const created: GroupRollbackEntry = { name: 'Workstations', existed: false, id: 'grp-new' }
const updated: GroupRollbackEntry = {
  name: 'Servers',
  existed: true,
  id: 'grp-1',
  prior: { name: 'Servers', inherits: false },
}

describe('SentinelOne Groups Rollback Handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [created] }, {
          configTypeId: CONFIG_TYPE,
          settings: SITE_SETTINGS,
          credential: null,
        }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
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

  it('reports failure and touches nothing when the previous state is empty', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([]))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a group the deploy created', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe('/groups/grp-new')
    })
  })

  it('restores an updated group to its prior name and inheritance', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe('/groups/grp-1')
      // `description: ''` is sent explicitly, not omitted: the prior group had
      // none, and omitting the field would leave a description the deploy added
      // in place while the rollback reported success.
      expect(dataOf(calls[0])).toEqual({ name: 'Servers', inherits: false, description: '' })
    })
  })

  it('reverts in reverse deploy order so later writes are undone first', async () => {
    await withFetch([envelope({}), envelope({})], async (calls) => {
      const result = await rollback(ctx([updated, created]))

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/groups/grp-new')
      expect(calls[1].path).toBe('/groups/grp-1')
    })
  })

  it('treats a group already deleted out-of-band (404) as reverted', async () => {
    await withFetch([apiError('not found', 404)], async () => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('Workstations')
    })
  })

  it('reports failure rather than throwing when a delete is rejected', async () => {
    await withFetch([apiError('access denied', 403)], async () => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/access denied/)
    })
  })

  it('reports how many entries were reverted before a failure', async () => {
    await withFetch([envelope({}), apiError('access denied', 403)], async () => {
      const result = await rollback(ctx([updated, created]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('after 1 of 2')
    })
  })
})
