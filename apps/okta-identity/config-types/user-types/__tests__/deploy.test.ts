// =============================================================================
// user-types — deploy, driven against the fake Okta org.
//
// A user type is the container for a whole profile schema, and its `name` is
// IMMUTABLE once created. That makes the match on name the only safe identity:
// re-sending the name unchanged on an update, and creating rather than renaming
// when nothing matches. An org is capped at ten types, so a deploy that creates a
// duplicate instead of updating in place burns a slot permanently.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  EMPTY_LIST,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function userType(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Contractor section',
    fields: {
      name: 'contractor',
      displayName: 'Contractor',
      description: 'External contractors',
      ...fields,
    },
  }
}

const LIVE_TYPE = {
  id: 'otyLIVE',
  name: 'contractor',
  displayName: 'Contractor',
  description: 'External contractors',
  default: false,
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: {},
}

describe('user-types deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [userType()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [userType()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [userType()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'otyNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [userType()] }))

      expect(calls[0].path).toBe('/meta/types/user')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a user type that does not exist', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'otyNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [userType()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/meta/types/user')
      expect(writes[0].json).toEqual({
        name: 'contractor',
        displayName: 'Contractor',
        description: 'External contractors',
      })
    })
  })

  it('records the created type so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'otyNEW' })], async () =>
      deploy(deployContext({ sections: [userType()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toEqual([{ name: 'contractor', existed: false, id: 'otyNEW' }])
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.createdIds).toEqual(['otyNEW'])
  })

  it('fails rather than inventing an id when the create returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'contractor' })], async () =>
      deploy(deployContext({ sections: [userType()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('updates a matching type in place and re-sends its immutable name unchanged', async () => {
    const result = await withFetch([ok([LIVE_TYPE]), ok({})], async (calls) => {
      const res = await deploy(
        deployContext({
          sections: [userType({ displayName: 'Contract staff', description: 'Renamed' })],
        }),
      )

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/meta/types/user/otyLIVE')
      expect(writes[0].json).toEqual({
        name: 'contractor',
        displayName: 'Contract staff',
        description: 'Renamed',
      })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('otyLIVE')
    expect(entry.prior).toEqual({
      name: 'contractor',
      displayName: 'Contractor',
      description: 'External contractors',
    })
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('sends an empty description rather than leaving a stale one behind', async () => {
    await withFetch([ok([LIVE_TYPE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [userType({ description: '' })] }))
      expect(writeCalls(calls)[0].json.description).toBe('')
    })
  })

  it('captures an empty prior description when the live type had none', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE_TYPE, description: undefined }]), ok({})],
      async () => deploy(deployContext({ sections: [userType()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.prior).toEqual({ name: 'contractor', displayName: 'Contractor', description: '' })
  })

  it('matches the name exactly — a differently-cased type is a different type', async () => {
    await withFetch([ok([{ ...LIVE_TYPE, name: 'Contractor' }]), ok({ id: 'otyNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [userType()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].method).toBe('POST')
    })
  })

  it('never deletes a user type during a deploy', async () => {
    await withFetch([ok([LIVE_TYPE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [userType({ displayName: 'Changed' })] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('never touches a user type the canvas did not declare', async () => {
    await withFetch(
      [ok([{ ...LIVE_TYPE, id: 'otyDEFAULT', name: 'user_type', default: true }, LIVE_TYPE]), ok({})],
      async (calls) => {
        await deploy(deployContext({ sections: [userType({ displayName: 'Changed' })] }))
        expect(calls.some((c) => c.path.includes('otyDEFAULT'))).toBe(false)
      },
    )
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [userType()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list user types/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Api validation failed', 400, ['name: already in use'])],
      async () => deploy(deployContext({ sections: [userType()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/Failed to create user type "contractor"/)
    expect(result.message).toMatch(/already in use/)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch([ok([LIVE_TYPE]), apiError('Cannot modify', 403)], async () =>
      deploy(deployContext({ sections: [userType({ displayName: 'Changed' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update user type "contractor"/)
  })

  it('reports partial progress and keeps rollback state when a later type fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'otyONE' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [
              userType(),
              { ...userType({ name: 'vendor', displayName: 'Vendor' }), name: 'Vendor section' },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['otyONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('skips a section missing a name or a display name', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [userType({ name: '' }), userType({ displayName: '  ' })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve a user type', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'otyNEW' })], async () => {
      const result = await deploy(deployContext({ sections: [userType()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })
})
