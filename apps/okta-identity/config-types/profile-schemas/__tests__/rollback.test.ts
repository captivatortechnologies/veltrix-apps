// =============================================================================
// profile-schemas — rollback, driven against the fake Okta org.
//
// Rollback here restores attribute definitions, not an object: the schema is
// never created or deleted, so every rollback is a partial `#custom` patch that
// replays the captured prior definition of each managed attribute — including a
// null, which re-removes an attribute this deploy added. Base attributes and
// unmanaged custom attributes must stay untouched, and the work unwinds in
// reverse.
// =============================================================================

import rollback from '../rollback'
import type { ProfileSchemaRollbackEntry } from '../deploy'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  rollbackContext,
  withFetch,
  writeCalls,
} from '../../../lib/__tests__/fakeOkta'

const PRIOR_ATTRS = {
  clearanceLevel: { title: 'Old clearance', type: 'string', mutability: 'READ_WRITE' },
}

function entry(overrides: Partial<ProfileSchemaRollbackEntry> = {}): ProfileSchemaRollbackEntry {
  return {
    schemaType: 'user',
    userTypeId: 'default',
    priorAttributes: { ...PRIOR_ATTRS },
    ...overrides,
  }
}

describe('profile-schemas rollback', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry()] }, { credential: null }),
      )
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry()] }, { credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }, { hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports there is nothing to roll back rather than guessing', async () => {
    for (const data of [undefined, {}, { previousState: [] }, { previousState: undefined }]) {
      await withFetch([], async (calls) => {
        const result = await rollback(rollbackContext(data))
        expect(result.success).toBe(false)
        expect(result.message).toBe('No previous state available for rollback')
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('replays the captured prior attributes as a #custom patch', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(rollbackContext({ previousState: [entry()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/meta/schemas/user/default')
      expect(writes[0].json).toEqual({
        definitions: { custom: { id: '#custom', type: 'object', properties: PRIOR_ATTRS } },
      })
    })
  })

  it('re-removes an attribute this deploy added by replaying its null', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry({ priorAttributes: { clearanceLevel: null } })] }),
      )

      expect(result.success).toBe(true)
      const custom = (writeCalls(calls)[0].json.definitions as { custom: { properties: Record<string, unknown> } })
        .custom
      expect(custom.properties).toEqual({ clearanceLevel: null })
    })
  })

  it('never touches a base attribute or the schema object itself', async () => {
    await withFetch([ok({})], async (calls) => {
      await rollback(rollbackContext({ previousState: [entry()] }))

      const definitions = writeCalls(calls)[0].json.definitions as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(definitions, 'base')).toBe(false)
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    })
  })

  it('restores the group schema at its fixed path', async () => {
    await withFetch([ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({ previousState: [entry({ schemaType: 'group', userTypeId: 'default' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/meta/schemas/group/default')
      expect(result.message).toMatch(/the group schema/)
    })
  })

  it('unwinds in reverse so later changes are reverted first', async () => {
    await withFetch([ok({}), ok({})], async (calls) => {
      const result = await rollback(
        rollbackContext({
          previousState: [entry({ userTypeId: 'otyFIRST' }), entry({ userTypeId: 'otySECOND' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/meta/schemas/user/otySECOND')
      expect(calls[1].path).toBe('/meta/schemas/user/otyFIRST')
    })
  })

  it('returns a FAILED result rather than throwing when the restore is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore user schema "default" custom attributes/)
    expect(leaksToken(result)).toBe(false)
  })

  it('treats a schema that no longer exists as a failure, not a silent success', async () => {
    const result = await withFetch([notFound()], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to restore user schema "default"/)
  })

  it('reports how far it got when a later entry fails', async () => {
    const result = await withFetch([ok({}), apiError('Insufficient permissions', 403)], async () =>
      rollback(
        rollbackContext({
          previousState: [entry({ userTypeId: 'otyFIRST' }), entry({ userTypeId: 'otySECOND' })],
        }),
      ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
  })

  it('never puts the SSWS token in its success message', async () => {
    const result = await withFetch([ok({})], async () =>
      rollback(rollbackContext({ previousState: [entry()] })),
    )
    expect(result.success).toBe(true)
    expect(String(result.message).includes(API_TOKEN)).toBe(false)
  })
})
