import rollback from '../rollback'
import type { RecipientRollbackEntry } from '../deploy'
import {
  SCOPELESS_SETTINGS,
  apiError,
  dataOf,
  envelope,
  filterOf,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-notification-recipients'
const RECIPIENTS = '/settings/recipients'

function ctx(previousState: RecipientRollbackEntry[] | undefined, settings?: Record<string, unknown>) {
  return rollbackContext(previousState === undefined ? {} : { previousState }, {
    configTypeId: CONFIG_TYPE,
    settings,
  })
}

const created: RecipientRollbackEntry = {
  key: 'soc@example.com',
  label: 'soc@example.com',
  existed: false,
  id: 'rcp-new',
}

const updated: RecipientRollbackEntry = {
  key: 'oncall@example.com',
  label: 'oncall@example.com',
  existed: true,
  id: 'rcp-1',
  prior: { id: 'rcp-1', email: 'oncall@example.com', name: 'On-call', sms: '+15559998888' },
}

describe('SentinelOne Notification Recipients Rollback Handler', () => {
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

  it('deletes a recipient the deploy created', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(RECIPIENTS)
      expect(dataOf(calls[0])).toEqual({ ids: ['rcp-new'] })
    })
  })

  it('restores an updated recipient to its prior name and SMS number', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([updated]))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('PUT')
      expect(filterOf(calls[0])).toEqual({ accountIds: ['act-1'] })
      expect(dataOf(calls[0])).toEqual({
        id: 'rcp-1',
        email: 'oncall@example.com',
        name: 'On-call',
        sms: '+15559998888',
      })
    })
  })

  it('reverts in reverse deploy order so later writes are undone first', async () => {
    await withFetch([envelope({}), envelope({})], async (calls) => {
      await rollback(ctx([updated, created]))

      expect(calls[0].method).toBe('DELETE')
      expect(calls[1].method).toBe('PUT')
    })
  })

  it('treats a recipient already deleted out-of-band (404) as reverted', async () => {
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
