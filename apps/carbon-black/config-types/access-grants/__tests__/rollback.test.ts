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

const CONFIG_TYPE = 'access-grants'
const GRANTS = `/access/v2/orgs/${ORG_KEY}/grants`
const ORG_REF = `psc:org:${ORG_KEY}`

const ALICE = 'alice@corp.example'
const ALICE_URN = `psc:user:${ORG_KEY}:4001`
const ALICE_GRANT = `${GRANTS}/psc%3Auser%3A${ORG_KEY}%3A4001`
const BOB = 'bob@corp.example'
const BOB_URN = `psc:user:${ORG_KEY}:4002`
const BOB_GRANT = `${GRANTS}/psc%3Auser%3A${ORG_KEY}%3A4002`

const ANALYST = 'psc:role::SECOPS_ROLE_ANALYST'
const OUT_OF_BAND = `psc:role:${ORG_KEY}:INCIDENT_RESPONDER`

function created(overrides: Partial<RollbackEntry> = {}): RollbackEntry {
  return {
    itemId: 'item-1',
    principalEmail: ALICE,
    principalUrn: ALICE_URN,
    existed: false,
    declaredRoles: [ANALYST],
    priorRoles: [],
    ...overrides,
  }
}

function adopted(overrides: Partial<RollbackEntry> = {}): RollbackEntry {
  return created({ existed: true, priorRoles: [OUT_OF_BAND], ...overrides })
}

function ctx(entries: RollbackEntry[] | undefined, opts: Record<string, unknown> = {}) {
  return rollbackContext(entries === undefined ? undefined : { entries }, { configTypeId: CONFIG_TYPE, ...opts })
}

describe('carbon-black access-grants rollback handler', () => {
  it('refuses without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([created()], { credential: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/credential/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the Org Key setting is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([created()], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the region base URL is blank instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([created()], { settings: NO_BASE_URL_SETTINGS }))

      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('deletes a grant the deploy created from nothing', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([created()]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('DELETE')
      expect(calls[0].path).toBe(ALICE_GRANT)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('restores the exact pre-deploy role snapshot of a grant the deploy adopted', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([adopted()]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('PUT')
      expect(calls[0].path).toBe(ALICE_GRANT)
      // The pre-deploy snapshot goes back verbatim — the role this app added is
      // gone, the role it found is still there.
      expect(objectBody(calls[0])).toEqual({
        principal: ALICE_URN,
        principal_name: ALICE,
        org_ref: ORG_REF,
        roles: [OUT_OF_BAND],
      })
      expect(result.message).toContain('1 restored')
    })
  })

  it('restores an empty snapshot as an empty role set rather than skipping it', async () => {
    await withFetch([cbJson({})], async (calls) => {
      const result = await rollback(ctx([adopted({ priorRoles: [] })]))

      // The principal held no roles before the deploy, so rollback must leave
      // them holding none — anything else is access this app should not grant.
      expect(result.success).toBe(true)
      expect(objectBody(calls[0]).roles).toEqual([])
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
      expect(result.message).toContain('0 deleted, 0 restored')
    })
  })

  it('skips an entry whose principal URN was never recorded', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(ctx([created({ principalUrn: '' })]))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('treats an already-deleted grant as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([created()]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted')
    })
  })

  it('treats a restore onto a vanished grant as rolled back, not as a failure', async () => {
    await withFetch([cbNotFound()], async () => {
      const result = await rollback(ctx([adopted()]))

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 restored')
    })
  })

  it('reports failure rather than throwing when the vendor rejects a restore', async () => {
    await withFetch([cbError('grant is locked by another operation', 409)], async () => {
      const result = await rollback(ctx([adopted()]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('grant is locked by another operation')
      expect(mentionsSecret(result.message)).toBe(false)
    })
  })

  it('reports failure rather than throwing when the vendor rejects a delete', async () => {
    await withFetch([cbError('insufficient permissions to revoke', 403)], async () => {
      const result = await rollback(ctx([created()]))

      expect(result.success).toBe(false)
      expect(result.message).toContain('insufficient permissions to revoke')
    })
  })

  it('keeps going after one entry fails so the rest still roll back', async () => {
    await withFetch([cbError('boom', 500), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([created(), adopted({ itemId: 'item-2', principalEmail: BOB, principalUrn: BOB_URN })]),
      )

      // Leaving the remaining principals with roles this app granted would be a
      // half-rolled-back access state.
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(2)
      expect(calls[1].method).toBe('PUT')
      expect(calls[1].path).toBe(BOB_GRANT)
    })
  })

  it('deletes and restores in one pass and counts both', async () => {
    await withFetch([cbJson({}), cbJson({})], async (calls) => {
      const result = await rollback(
        ctx([created(), adopted({ itemId: 'item-2', principalEmail: BOB, principalUrn: BOB_URN })]),
      )

      expect(result.success).toBe(true)
      expect(result.message).toContain('1 deleted, 1 restored')
      expect(calls[0].method).toBe('DELETE')
      expect(calls[1].method).toBe('PUT')
      expect(objectBody(calls[1]).principal_name).toBe(BOB)
    })
  })

  it('keeps the API secret in the auth header — never in a URL, a body or a message', async () => {
    await withFetch([cbError('unauthorized', 401)], async (calls) => {
      const result = await rollback(ctx([adopted()]))

      expect(result.success).toBe(false)
      expect(mentionsSecret(result.message)).toBe(false)
      for (const call of calls) {
        expect(call.authToken).toBe(AUTH_TOKEN)
        expect(mentionsSecret(call.url)).toBe(false)
        expect(mentionsSecret(call.body)).toBe(false)
      }
    })
  })
})
