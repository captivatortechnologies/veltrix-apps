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

const CONFIG_TYPE = 'policies'
const POLICIES = `/policyservice/v1/orgs/${ORG_KEY}/policies`

const PRIOR = {
  id: 7,
  org_key: ORG_KEY,
  name: 'Standard',
  description: 'old description',
  priority_level: 'LOW',
  is_system: false,
  av_settings: { onAccessScan: { enabled: false } },
  rules: [{ id: 1, action: 'TERMINATE' }],
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black policies rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: false, policyId: '7' }], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        ctx([{ name: 'Standard', existed: false, policyId: '7' }], { settings: NO_ORG_KEY_SETTINGS }),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a policy the deploy created', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: false, policyId: '42' }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(`${POLICIES}/42`)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact prior state of a policy the deploy adopted', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: true, policyId: '7', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      // An adopted policy is restored in place, never deleted.
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(`${POLICIES}/7`)
      // The pre-deploy snapshot goes back verbatim — that is the whole point.
      expect(objectBody(calls[0])).toEqual(PRIOR)
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

  it('skips an entry whose policy id was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: false }]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('leaves an adopted policy untouched when no prior snapshot was captured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: true, policyId: '7' }]))

      // Restoring from nothing would blank a policy this app does not own.
      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted policy as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: 'Standard', existed: false, policyId: 'gone' }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('treats a restore onto a policy that is gone as rolled back', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([{ name: 'Standard', existed: true, policyId: 'gone', prior: PRIOR }]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 restored')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('policy is in use by 12 devices', 409)], async () => {
      const result = await rollback(ctx([{ name: 'Standard', existed: true, policyId: '7', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('policy is in use by 12 devices')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([
          { name: 'First', existed: false, policyId: '1' },
          { name: 'Second', existed: false, policyId: '2' },
        ]),
      )

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].path).toBe(`${POLICIES}/2`)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
      const result = await rollback(ctx([{ name: 'Standard', existed: true, policyId: '7', prior: PRIOR }]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
