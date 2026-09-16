import rollback from '../rollback'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
  NO_BASE_URL_SETTINGS,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  cbJson,
  cbNotFound,
  mentionsSecret,
  objectBody,
  rollbackContext,
  withFetch,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'device-control-blocks'
const BLOCKS = `/device_control/v3/orgs/${ORG_KEY}/blocks`

/** What the block looked like before this app adopted it. */
const PRIOR = { policy_id: 101, windows: { approved_devices: { allow_write: false, allow_execute: true } } }

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black device-control-blocks rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-1' }], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-1' }], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-1' }], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a block the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-new' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${BLOCKS}/blk-new`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact prior state of a block the deploy adopted', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: true, id: 'blk-1', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(`${BLOCKS}/blk-1`)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[0])).toEqual(PRIOR)
      expect(result.message).toContain('1 restored')
    })
  })

  it('does nothing when there is no rollback state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
      expect(result.message).toContain('0 deleted, 0 restored')
      expect(calls).toHaveLength(0)
    })
  })

  it('does nothing for an empty entry list', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips an entry whose block id the bulk create never returned', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false }]))

      // Nothing to address the DELETE at — the created block survives.
      expect(result.success).toBe(true)
      expect(result.message).toContain('0 deleted')
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted block untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: true, id: 'blk-1' }]))

      // Restoring from nothing would clear enforcement on a policy this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted block as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('treats a restore onto an already-deleted block as rolled back too', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: '101', existed: true, id: 'blk-gone', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 restored')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('block is managed elsewhere', 409)], async () => {
      const result = await rollback(ctx([{ name: '101', existed: true, id: 'blk-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('restore block for policy 101')
      expect(result.message).toContain('block is managed elsewhere')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: '101', existed: false, id: 'blk-1' },
          { name: '202', existed: false, id: 'blk-2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${BLOCKS}/blk-2`)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
      const result = await rollback(ctx([{ name: '101', existed: false, id: 'blk-1' }]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
