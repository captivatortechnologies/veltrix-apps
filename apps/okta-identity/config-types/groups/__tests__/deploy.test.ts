// =============================================================================
// groups — deploy, driven against the fake Okta org.
//
// A group IS an access grant: everything downstream (app assignments, policy
// rules, admin roles) hangs off group membership. A deploy that quietly creates a
// duplicate, rewrites a BUILT_IN group or reconciles membership nobody asked it
// to touch either locks people out or hands out access. These tests assert the
// request sequence, the bodies sent, the failure contract and the rollback state
// recorded — not a restated happy path.
// =============================================================================

import deploy, { getCurrentMemberIds } from '../deploy'
import type { OktaClient } from '../../../lib/okta'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  EMPTY_LIST,
  leaksToken,
  notFound,
  ok,
  priorDeployment,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

/**
 * A member-read 404 must NOT throw — it signals a stale/unresolvable group id so
 * the deploy can skip membership for just that group instead of failing the whole
 * batch (the "Failed to list members … Resource not found (UserGroup)" case).
 */
function mockClient(status: number, body: unknown): OktaClient {
  return {
    request: async () => ({
      status,
      ok: status >= 200 && status < 300,
      body: JSON.stringify(body),
      nextUrl: null,
    }),
  } as unknown as OktaClient
}

describe('getCurrentMemberIds', () => {
  it('returns null on a 404 (group not found) instead of throwing', async () => {
    const result = await getCurrentMemberIds(mockClient(404, { errorSummary: 'Not found' }), '00gStale')
    expect(result).toBeNull()
  })

  it('returns the member ids on 200', async () => {
    const result = await getCurrentMemberIds(
      mockClient(200, [{ id: '00u1' }, { id: '00u2' }, { id: '' }, {}]),
      '00gLive',
    )
    expect(result).toEqual(['00u1', '00u2'])
  })

  it('throws on a non-404 error (real failure)', async () => {
    let message = ''
    try {
      await getCurrentMemberIds(mockClient(500, { errorSummary: 'boom' }), '00gLive')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('Failed to list members')
  })
})

function group(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Engineering section',
    fields: {
      name: 'Engineering',
      description: 'All engineers',
      manageMembership: false,
      memberUserIds: [],
      ...fields,
    },
  }
}

const LIVE_GROUP = {
  id: '00gLIVE',
  type: 'OKTA_GROUP',
  profile: { name: 'Engineering', description: 'All engineers' },
}

describe('groups deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [group()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [group()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [group()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ id: '00gNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [group()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(result.success).toBe(true)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('scopes the org-wide list to OKTA_GROUP — the only type it may manage', async () => {
    await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ id: '00gNEW' })], async (calls) => {
      await deploy(deployContext({ sections: [group()] }))

      expect(calls[0].path).toBe('/groups')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].query.filter).toBe('type eq "OKTA_GROUP"')
    })
  })

  it('follows rel="next" so a group on the second page is updated, not duplicated', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: '00gOTHER', type: 'OKTA_GROUP', profile: { name: 'Sales' } }],
          headers: { link: `<${API_BASE}/groups?after=00gOTHER>; rel="next"` },
        },
        ok([LIVE_GROUP]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [group()] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(1)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/groups/00gLIVE')
      },
    )
  })

  it('creates a group that does not exist, after checking nothing else owns the name', async () => {
    await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ id: '00gNEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [group()] }))

      expect(result.success).toBe(true)

      // The name-conflict probe is a read, scoped to this name.
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe('/groups')
      expect(calls[1].query.q).toBe('Engineering')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/groups')
      expect(writes[0].json.profile).toEqual({ name: 'Engineering', description: 'All engineers' })
    })
  })

  it('records the created group in rollback state so rollback can remove it', async () => {
    const result = await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ id: '00gNEW' })], async () =>
      deploy(deployContext({ sections: [group()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
      resourceIds: Record<string, string>
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('00gNEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.previousState[0].managedMembership).toBe(false)
    expect(rb.createdIds).toEqual(['00gNEW'])
    expect(rb.resourceIds).toEqual({ 'item-1': '00gNEW' })
  })

  it('fails rather than inventing an id when the create returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ profile: { name: 'Engineering' } })], async () =>
      deploy(deployContext({ sections: [group()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('updates a group that already exists and captures its prior profile', async () => {
    const result = await withFetch([ok([LIVE_GROUP]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [group({ description: 'Rewritten' })] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/groups/00gLIVE')
      expect(writes[0].json.profile).toEqual({ name: 'Engineering', description: 'Rewritten' })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('00gLIVE')
    expect(entry.prior).toEqual({ name: 'Engineering', description: 'All engineers' })
  })

  it('sends an empty description rather than leaving a stale one behind', async () => {
    await withFetch([ok([LIVE_GROUP]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [group({ description: '' })] }))

      const profile = writeCalls(calls)[0].json.profile as Record<string, unknown>
      expect(profile.description).toBe('')
    })
  })

  it('refuses to manage a reserved built-in name and writes nothing', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [group({ name: 'Everyone' })] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/reserved built-in group "Everyone"/)
  })

  it('refuses to create when a non-OKTA_GROUP already owns the name', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok([{ id: '00gAPP', type: 'APP_GROUP', profile: { name: 'Engineering' } }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [group()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/APP_GROUP/)
    expect(result.message).toMatch(/only OKTA_GROUP groups can be managed/)
  })

  it('creates when the name-probe only turns up a same-named OKTA_GROUP miss', async () => {
    await withFetch(
      [EMPTY_LIST, ok([{ id: '00gOTHER', type: 'OKTA_GROUP', profile: { name: 'Engineering-ish' } }]), ok({ id: '00gNEW' })],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [group()] }))
        expect(result.success).toBe(true)
        expect(writeCalls(calls)[0].method).toBe('POST')
      },
    )
  })

  it('fails rather than creating blind when the name-conflict probe is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [group()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/name conflict/)
    expect(result.message).toMatch(/Insufficient permissions/)
  })

  it('matches by the id stored on the last successful deploy so a rename renames', async () => {
    await withFetch(
      [EMPTY_LIST, ok({ id: '00gSTORED', type: 'OKTA_GROUP', profile: { name: 'Old name' } }), ok({})],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [group({ name: 'Renamed' })],
            latestDeployment: priorDeployment({ 'item-1': '00gSTORED' }),
          }),
        )

        expect(result.success).toBe(true)
        // The first per-item lookup is by stored id — otherwise the rename would
        // create a SECOND group and silently split the access grant.
        expect(calls[1].path).toBe('/groups/00gSTORED')
        const writes = writeCalls(calls)
        expect(writes).toHaveLength(1)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/groups/00gSTORED')
        expect(writes[0].json.profile).toEqual({ name: 'Renamed', description: 'All engineers' })
      },
    )
  })

  it('falls back to the name when the stored id no longer resolves', async () => {
    await withFetch([ok([LIVE_GROUP]), notFound(), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [group()],
          latestDeployment: priorDeployment({ 'item-1': '00gGONE' }),
        }),
      )

      expect(result.success).toBe(true)
      expect(calls[1].path).toBe('/groups/00gGONE')
      expect(writeCalls(calls)[0].path).toBe('/groups/00gLIVE')
    })
  })

  it('never rewrites a stored id that now points at a non-OKTA_GROUP', async () => {
    await withFetch(
      [
        EMPTY_LIST,
        ok({ id: '00gSTORED', type: 'APP_GROUP', profile: { name: 'Engineering' } }),
        EMPTY_LIST,
        ok({ id: '00gNEW' }),
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [group()],
            latestDeployment: priorDeployment({ 'item-1': '00gSTORED' }),
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.some((c) => c.method === 'PUT' && c.path === '/groups/00gSTORED')).toBe(false)
        expect(writeCalls(calls)[0].path).toBe('/groups')
      },
    )
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([EMPTY_LIST, EMPTY_LIST, ok({ id: '00gNEW' })], async () => {
      const result = await deploy(deployContext({ sections: [group()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('returns a FAILED result rather than throwing when the org list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [group()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list OKTA_GROUP groups/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, EMPTY_LIST, apiError('Api validation failed: name', 400, ['name: already in use'])],
      async () => deploy(deployContext({ sections: [group()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/0 of 1/)
    expect(result.message).toMatch(/Api validation failed/)
    expect(result.message).toMatch(/already in use/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports partial progress and keeps rollback state when a later group fails', async () => {
    const result = await withFetch(
      [
        EMPTY_LIST, // list
        EMPTY_LIST, // conflict probe for the first group
        ok({ id: '00gONE' }), // created
        EMPTY_LIST, // conflict probe for the second group
        apiError('Insufficient permissions', 403), // its create is rejected
      ],
      async () =>
        deploy(
          deployContext({
            sections: [group(), { ...group({ name: 'Sales' }), name: 'Sales section' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['00gONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('carries the prior id map forward on failure so a retry stays rename-safe', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      deploy(
        deployContext({
          sections: [group()],
          latestDeployment: priorDeployment({ 'item-9': '00gKEEP' }),
        }),
      ),
    )

    const rb = result.rollbackData as { resourceIds: Record<string, string> }
    expect(rb.resourceIds).toEqual({ 'item-9': '00gKEEP' })
  })

  it('never reads or writes membership when Manage Membership is off', async () => {
    await withFetch([ok([LIVE_GROUP]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [group({ memberUserIds: ['00u1', '00u2'] })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.path.includes('/users'))).toBe(false)
    })
  })

  it('reconciles static membership to exactly the declared set when opted in', async () => {
    await withFetch(
      [
        ok([LIVE_GROUP]),
        ok({}), // PUT profile
        ok([{ id: '00uKEEP' }, { id: '00uDROP' }]), // current members
        ok({}), // PUT add
        ok({}), // DELETE remove
      ],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [group({ manageMembership: true, memberUserIds: ['00uKEEP', '00uADD'] })],
          }),
        )

        expect(result.success).toBe(true)
        const read = calls.find((c) => c.path === '/groups/00gLIVE/users')
        expect(read?.query.limit).toBe('200')

        const writes = writeCalls(calls)
        expect(writes).toHaveLength(3)
        expect(writes[1].method).toBe('PUT')
        expect(writes[1].path).toBe('/groups/00gLIVE/users/00uADD')
        expect(writes[2].method).toBe('DELETE')
        expect(writes[2].path).toBe('/groups/00gLIVE/users/00uDROP')
        // The member it already had is left alone, not re-added.
        expect(calls.some((c) => c.path === '/groups/00gLIVE/users/00uKEEP')).toBe(false)

        const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
          .previousState[0]
        expect(entry.managedMembership).toBe(true)
        expect(entry.priorMembers).toEqual(['00uKEEP', '00uDROP'])
      },
    )
  })

  it('clears every static member when membership is managed with an empty list', async () => {
    await withFetch([ok([LIVE_GROUP]), ok({}), ok([{ id: '00uDROP' }]), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [group({ manageMembership: true, memberUserIds: [] })] }),
      )

      expect(result.success).toBe(true)
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/groups/00gLIVE/users/00uDROP')).toBe(
        true,
      )
    })
  })

  it('tolerates a 404 when removing a member that is already gone', async () => {
    await withFetch([ok([LIVE_GROUP]), ok({}), ok([{ id: '00uDROP' }]), notFound()], async () => {
      const result = await deploy(
        deployContext({ sections: [group({ manageMembership: true, memberUserIds: [] })] }),
      )
      expect(result.success).toBe(true)
    })
  })

  it('warns and drops the stale id when the group cannot be read for membership', async () => {
    const result = await withFetch(
      [ok([LIVE_GROUP]), ok({}), notFound()],
      async () =>
        deploy(
          deployContext({
            sections: [group({ manageMembership: true, memberUserIds: ['00u1'] })],
          }),
        ),
    )

    expect(result.success).toBe(true)
    expect(result.message).toMatch(/1 warning/)
    expect((result.artifacts as { warnings: string[] }).warnings).toHaveLength(1)
    // The stale id must NOT be carried forward, or the next deploy re-matches it.
    expect((result.rollbackData as { resourceIds: Record<string, string> }).resourceIds).toEqual({})
  })

  it('fails the deploy when a membership write is rejected outright', async () => {
    const result = await withFetch(
      [ok([LIVE_GROUP]), ok({}), ok([]), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({ sections: [group({ manageMembership: true, memberUserIds: ['00u1'] })] }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to add user 00u1/)
  })

  it('never deletes a group during a deploy', async () => {
    await withFetch([ok([LIVE_GROUP]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [group({ description: 'Rewritten' })] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('skips a section that declares no group name instead of creating a nameless group', async () => {
    await withFetch([EMPTY_LIST], async (calls) => {
      const result = await deploy(deployContext({ sections: [group({ name: '   ' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
