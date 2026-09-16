// =============================================================================
// linked-objects — deploy, driven against the fake Okta org.
//
// A linked-object definition is IMMUTABLE: Okta offers no update, and deleting a
// definition removes every user link that used it. So the one thing this deploy
// must never do is "fix" a definition that already exists and differs — it
// creates what is missing, leaves a matching definition alone, and refuses
// anything else with an explanation. These tests pin that refusal.
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

function linkedObject(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Manager relationship',
    fields: {
      primaryName: 'manager',
      primaryTitle: 'Manager',
      associatedName: 'reports',
      associatedTitle: 'Direct reports',
      ...fields,
    },
  }
}

const LIVE = {
  primary: { name: 'manager', title: 'Manager', type: 'USER' },
  associated: { name: 'reports', title: 'Direct reports', type: 'USER' },
  _links: { self: { href: 'https://example.test' } },
}

describe('linked-objects deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [linkedObject()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [linkedObject()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [linkedObject()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [linkedObject()] }))

      expect(calls[0].path).toBe('/meta/schemas/user/linkedObjects')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a definition that does not exist, with both sides typed USER', async () => {
    await withFetch([EMPTY_LIST, ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            linkedObject({
              primaryDescription: 'Who this user reports to',
              associatedDescription: 'Who reports to this user',
            }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/meta/schemas/user/linkedObjects')
      expect(writes[0].json).toEqual({
        primary: {
          name: 'manager',
          title: 'Manager',
          type: 'USER',
          description: 'Who this user reports to',
        },
        associated: {
          name: 'reports',
          title: 'Direct reports',
          type: 'USER',
          description: 'Who reports to this user',
        },
      })
    })
  })

  it('omits a description that was never authored rather than sending an empty one', async () => {
    await withFetch([EMPTY_LIST, ok({})], async (calls) => {
      await deploy(deployContext({ sections: [linkedObject()] }))

      const body = writeCalls(calls)[0].json as {
        primary: Record<string, unknown>
        associated: Record<string, unknown>
      }
      expect(body.primary.description).toBeUndefined()
      expect(body.associated.description).toBeUndefined()
    })
  })

  it('records the created definition so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({})], async () =>
      deploy(deployContext({ sections: [linkedObject()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toEqual([{ primaryName: 'manager', existed: false }])
    expect(rb.createdIds).toEqual(['manager'])
  })

  it('leaves a definition that already matches completely untouched', async () => {
    const result = await withFetch([ok([LIVE])], async (calls) => {
      const res = await deploy(deployContext({ sections: [linkedObject()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/1 unchanged: manager/)
    expect((result.artifacts as { skipped: string[] }).skipped).toEqual(['manager'])
    // Nothing was created, so rollback has nothing to undo for it.
    expect((result.rollbackData as { previousState: unknown[] }).previousState).toHaveLength(0)
  })

  it('matches an existing definition case-insensitively on the primary name', async () => {
    await withFetch([ok([{ ...LIVE, primary: { ...LIVE.primary, name: 'Manager' } }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [linkedObject()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('refuses to touch a definition that exists but differs — they are immutable', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE, associated: { name: 'subordinates', title: 'Direct reports', type: 'USER' } }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [linkedObject()] }))
        // No create, and above all no DELETE — deleting drops every user link.
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/cannot be updated in place/)
    expect(result.message).toMatch(/removes all existing user links/)
  })

  it('treats a changed title as an immutable conflict, not a silent no-op', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE, primary: { ...LIVE.primary, title: 'Line manager' } }])],
      async () => deploy(deployContext({ sections: [linkedObject()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/already exists with a different definition/)
  })

  it('treats a description added out of band as an immutable conflict', async () => {
    const result = await withFetch(
      [ok([{ ...LIVE, primary: { ...LIVE.primary, description: 'Added by hand' } }])],
      async () => deploy(deployContext({ sections: [linkedObject()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/immutable/)
  })

  it('never deletes a definition during a deploy', async () => {
    await withFetch([EMPTY_LIST, ok({})], async (calls) => {
      await deploy(deployContext({ sections: [linkedObject()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [linkedObject()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list linked-object definitions while resolving "manager"/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('surfaces a 409 from a concurrent create rather than swallowing it', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('An object with this field already exists', 409)],
      async () => deploy(deployContext({ sections: [linkedObject()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/Failed to create linked-object definition "manager"/)
    expect(result.message).toMatch(/already exists/)
  })

  it('reports partial progress when a later definition fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST,
        ok({}),
        EMPTY_LIST,
        apiError('Insufficient permissions', 403),
      ],
      async () =>
        deploy(
          deployContext({
            sections: [
              linkedObject(),
              {
                ...linkedObject({
                  primaryName: 'mentor',
                  primaryTitle: 'Mentor',
                  associatedName: 'mentees',
                  associatedTitle: 'Mentees',
                }),
                name: 'Mentor relationship',
              },
            ],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['manager'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('skips a section missing either relationship name', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [linkedObject({ primaryName: '' }), linkedObject({ associatedName: '  ' })],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve a definition', async () => {
    await withFetch([EMPTY_LIST, ok({})], async () => {
      const result = await deploy(
        deployContext({ sections: [linkedObject()], platformThrows: true }),
      )
      expect(result.success).toBe(true)
    })
  })
})
