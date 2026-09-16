import rollback from '../rollback'
import type { HashRollbackEntry } from '../deploy'
import { apiError, dataOf, envelope, rollbackContext, withFetch } from '../../../lib/__tests__/fakeS1'

const CONFIG_TYPE = 's1-hash-allowlist'
const SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709'

function ctx(previousState: HashRollbackEntry[] | undefined) {
  return rollbackContext(previousState === undefined ? {} : { previousState }, {
    configTypeId: CONFIG_TYPE,
  })
}

const created: HashRollbackEntry = {
  value: SHA1,
  osType: 'windows',
  label: `${SHA1} (windows)`,
  existed: false,
  id: 'res-new',
}

const preExisting: HashRollbackEntry = { ...created, existed: true, id: 'res-1' }

describe('SentinelOne Hash Allowlist Rollback Handler', () => {
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

  it('reports failure and touches nothing when there is no previous state', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No previous state available for rollback')
      expect(calls).toHaveLength(0)
    })
  })

  it('removes a hash this deploy allowlisted', async () => {
    await withFetch([envelope({})], async (calls) => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe('/restrictions')
      expect(dataOf(calls[0])).toEqual({ ids: ['res-new'] })
    })
  })

  it('never removes a hash that was already allowlisted before the deploy', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([preExisting]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('reverts in reverse deploy order so later writes are undone first', async () => {
    const second: HashRollbackEntry = { ...created, id: 'res-second', label: 'second' }
    await withFetch([envelope({}), envelope({})], async (calls) => {
      await rollback(ctx([created, second]))

      expect(dataOf(calls[0])).toEqual({ ids: ['res-second'] })
      expect(dataOf(calls[1])).toEqual({ ids: ['res-new'] })
    })
  })

  it('treats a hash already removed out-of-band (404) as reverted', async () => {
    await withFetch([apiError('not found', 404)], async () => {
      const result = await rollback(ctx([created]))
      expect(result.success).toBe(true)
    })
  })

  it('reports failure rather than throwing when a removal is rejected', async () => {
    await withFetch([apiError('access denied', 403)], async () => {
      const result = await rollback(ctx([created]))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/access denied/)
    })
  })
})
