// =============================================================================
// profile-schemas — deploy, driven against the fake Okta org.
//
// A profile schema defines the attributes that later feed profile mappings and,
// through them, token claims. Schemas are UPDATE-ONLY — never created, never
// deleted — the update is a PARTIAL patch of the `#custom` subschema only, and
// Okta's immutable `#base` attributes must never appear in a request body.
// These tests assert the read-then-patch sequence, the exact body, the prior
// state captured for rollback, and the failure contract.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ATTRS = {
  clearanceLevel: { title: 'Clearance level', type: 'string', required: false },
}

function schema(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Default user schema',
    fields: {
      schemaType: 'user',
      userTypeId: 'default',
      attributesJson: JSON.stringify(ATTRS),
      ...fields,
    },
  }
}

const LIVE_SCHEMA = {
  id: 'https://dev-12345.okta.com/meta/schemas/user/default',
  definitions: {
    base: { properties: { login: { title: 'Username', type: 'string' } } },
    custom: {
      id: '#custom',
      type: 'object',
      properties: {
        clearanceLevel: { title: 'Old clearance', type: 'string', mutability: 'READ_WRITE' },
        badgeId: { title: 'Badge', type: 'string' },
      },
    },
  },
}

describe('profile-schemas deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [schema()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [schema()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [schema()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [schema()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('reads the schema before patching it', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [schema()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/meta/schemas/user/default')
      expect(calls[1].method).toBe('POST')
      expect(calls[1].path).toBe('/meta/schemas/user/default')
    })
  })

  it('patches ONLY the #custom subschema and never sends a base attribute', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [schema()] }))

      const body = writeCalls(calls)[0].json
      expect(body).toEqual({
        definitions: { custom: { id: '#custom', type: 'object', properties: ATTRS } },
      })
      const definitions = body.definitions as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(definitions, 'base')).toBe(false)
      // badgeId is live but unmanaged — it must not appear in the patch.
      const custom = definitions.custom as { properties: Record<string, unknown> }
      expect(Object.prototype.hasOwnProperty.call(custom.properties, 'badgeId')).toBe(false)
    })
  })

  it('sends an explicit null to REMOVE a custom attribute', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [schema({ attributesJson: '{"clearanceLevel":null}' })] }),
      )

      expect(result.success).toBe(true)
      const custom = (writeCalls(calls)[0].json.definitions as { custom: { properties: Record<string, unknown> } })
        .custom
      expect(custom.properties).toEqual({ clearanceLevel: null })
    })
  })

  it('targets the single group schema by its fixed path', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [schema({ schemaType: 'group', userTypeId: 'ignored' })] }),
      )

      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/meta/schemas/group/default')
      expect(calls[1].path).toBe('/meta/schemas/group/default')
    })
  })

  it('url-encodes a user type id so it cannot escape the schema path', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [schema({ userTypeId: 'oty/../group' })] }))

      expect(calls[0].path).toBe('/meta/schemas/user/oty%2F..%2Fgroup')
    })
  })

  it('captures the prior definition of every managed attribute for rollback', async () => {
    const result = await withFetch([ok(LIVE_SCHEMA), ok({})], async () =>
      deploy(deployContext({ sections: [schema()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].schemaType).toBe('user')
    expect(rb.previousState[0].userTypeId).toBe('default')
    expect(rb.previousState[0].priorAttributes).toEqual({
      clearanceLevel: { title: 'Old clearance', type: 'string', mutability: 'READ_WRITE' },
    })
    // Schemas are never created, so there is never anything to delete.
    expect(rb.createdIds).toEqual([])
  })

  it('captures null as the prior state of an attribute this deploy ADDS', async () => {
    const result = await withFetch(
      [ok({ definitions: { custom: { properties: {} } } }), ok({})],
      async () => deploy(deployContext({ sections: [schema()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    // A null re-removes on rollback what this deploy added.
    expect(entry.priorAttributes).toEqual({ clearanceLevel: null })
  })

  it('fails clearly — without writing — when the schema does not exist', async () => {
    const result = await withFetch([notFound()], async (calls) => {
      const res = await deploy(deployContext({ sections: [schema({ userTypeId: 'otyGONE' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Schema for user schema "otyGONE" does not exist/)
    expect(result.message).toMatch(/update-only/)
  })

  it('returns a FAILED result rather than throwing when the schema read is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [schema()] }))
      // A 403 on the read must never be mistaken for "no prior attributes".
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch user schema "default"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the patch is rejected', async () => {
    const result = await withFetch(
      [ok(LIVE_SCHEMA), apiError('Api validation failed: custom', 400, ['clearanceLevel: bad type'])],
      async () => deploy(deployContext({ sections: [schema()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update user schema "default" custom attributes/)
    expect(result.message).toMatch(/clearanceLevel: bad type/)
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            schema({ schemaType: '' }),
            schema({ schemaType: 'application' }),
            schema({ attributesJson: '' }),
            schema({ attributesJson: '{}' }),
            schema({ attributesJson: '[1,2]' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve a schema', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [schema()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('reports partial progress and keeps rollback state when a later schema fails', async () => {
    const result = await withFetch(
      [ok(LIVE_SCHEMA), ok({}), ok(LIVE_SCHEMA), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({ sections: [schema(), schema({ schemaType: 'group' })] }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[] }
    expect(rb.previousState).toHaveLength(2)
    expect((result.artifacts as { deployedSchemas: string[] }).deployedSchemas).toEqual([
      'user schema "default" (1 attr)',
    ])
  })

  it('never creates or deletes the schema object itself', async () => {
    await withFetch([ok(LIVE_SCHEMA), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [schema()] }))

      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    })
  })
})
