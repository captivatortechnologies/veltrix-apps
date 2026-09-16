import rollback from '../rollback'
import type { RollbackEntry } from '../deploy'
import {
  AUTH_TOKEN,
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

const CONFIG_TYPE = 'reputation-overrides'
const OVERRIDES = `/appservices/v6/orgs/${ORG_KEY}/reputations/overrides`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'
const KEY = `sha256:${HASH}`

/** The pre-management body deploy captured — note it carries no `id`. */
const PRIOR = {
  override_list: 'WHITE_LIST',
  override_type: 'SHA256',
  sha256_hash: HASH,
  filename: 'old.exe',
  description: 'vendor allow',
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black reputation-overrides rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: false, id: 'ov-1' }], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: false, id: 'ov-1' }], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes an override the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: false, id: 'ov-new' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${OVERRIDES}/ov-new`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('recreates the exact prior body of an override the deploy adopted', async () => {
    await withFetch([cbJson({}), cbJson({ id: 'ov-restored' })], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: true, id: 'ov-1', prior: PRIOR }]))

      expect(result.success).toBe(true)
      // No update API — the app's version is removed and the original re-posted.
      expect(calls).toHaveLength(2)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${OVERRIDES}/ov-1`)
      expect(calls[1].method).toBe('POST')
      expect(calls[1].path).toBe(OVERRIDES)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[1])).toEqual(PRIOR)
      expect(result.message).toContain('1 restored')
    })
  })

  it('still recreates the original when the app version is already gone', async () => {
    await withFetch([cbNotFound(), cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: true, id: 'ov-1', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(2)
      expect(result.message).toContain('1 restored')
    })
  })

  it('does nothing when there is no rollback state at all', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx(undefined))

      expect(result.success).toBe(true)
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

  it('skips an entry whose override id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: false }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted override untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: true, id: 'ov-1' }]))

      // Deleting from nothing would destroy an override this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted override as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: KEY, existed: false, id: 'ov-gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('reports failure rather than throwing when the vendor rejects the recreate', async () => {
    await withFetch([cbJson({}), cbError('override already exists', 409)], async () => {
      const result = await rollback(ctx([{ name: KEY, existed: true, id: 'ov-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('override already exists')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('abandons a restore whose delete failed rather than duplicating the override', async () => {
    await withFetch([cbError('override is locked', 409)], async (calls) => {
      const result = await rollback(ctx([{ name: KEY, existed: true, id: 'ov-1', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('override is locked')
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: KEY, existed: false, id: 'ov-1' },
          { name: `sha256:${'bb'.repeat(32)}`, existed: false, id: 'ov-2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${OVERRIDES}/ov-2`)
    })
  })
})
