// =============================================================================
// resource-set-bindings — deploy, driven against the fake Okta org.
//
// A binding IS the admin grant: it hands a role, inside a resource set, to a list
// of people. One extra member here is one extra administrator. These tests pin
// the request sequence, the member reconciliation (add BEFORE remove, because
// Okta deletes a binding that loses its last member), and the prior membership
// deploy must capture before it changes anything.
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

const RESOURCE_SET = 'Helpdesk scope'
const ROLE = 'cr0HELPDESK'
const BINDINGS_PATH = '/iam/resource-sets/Helpdesk%20scope/bindings'
const BINDING_PATH = `${BINDINGS_PATH}/cr0HELPDESK`
const MEMBERS_PATH = `${BINDING_PATH}/members`

const GROUP = `${API_BASE}/groups/00g1`
const USER = `${API_BASE}/users/00u1`
const CONTRACTOR = `${API_BASE}/users/00uCONTRACTOR`

function binding(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Tier 1 grant',
    fields: { resourceSet: RESOURCE_SET, role: ROLE, members: [GROUP, USER], ...fields },
  }
}

function member(id: string, href: string) {
  return { id, _links: { self: { href } } }
}

function membersList(items: unknown[]) {
  return ok({ members: items })
}

describe('resource-set-bindings deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [binding()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [binding()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [binding()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([notFound(), ok({ id: 'bnd1' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [binding()] }))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe(BINDING_PATH)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('URL-encodes a resource set label that contains spaces', async () => {
    await withFetch([notFound(), ok({ id: 'bnd1' })], async (calls) => {
      await deploy(deployContext({ sections: [binding()] }))
      expect(calls[0].url).toContain('Helpdesk%20scope')
    })
  })

  it('creates a binding that does not exist, granting exactly the declared members', async () => {
    await withFetch([notFound(), ok({ id: 'bnd1' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [binding()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe(BINDINGS_PATH)
      expect(writes[0].json).toEqual({ role: ROLE, members: [GROUP, USER] })
    })
  })

  it('de-duplicates the declared member list before granting it', async () => {
    await withFetch([notFound(), ok({ id: 'bnd1' })], async (calls) => {
      await deploy(deployContext({ sections: [binding({ members: [GROUP, GROUP, USER] })] }))
      expect(writeCalls(calls)[0].json.members).toEqual([GROUP, USER])
    })
  })

  it('records a created binding by its (resourceSet, role) pair so rollback can delete it', async () => {
    const result = await withFetch([notFound(), ok({ id: 'bnd1' })], async () =>
      deploy(deployContext({ sections: [binding()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].resourceSet).toBe(RESOURCE_SET)
    expect(rb.previousState[0].role).toBe(ROLE)
    expect(rb.previousState[0].priorMembers).toBeUndefined()
    expect(rb.createdIds).toEqual([`${RESOURCE_SET}:${ROLE}`])
  })

  it('reconciles an existing binding instead of creating a second one', async () => {
    const result = await withFetch(
      [
        ok({ id: 'bnd1' }),
        membersList([member('mem-1', GROUP), member('mem-2', CONTRACTOR)]),
        ok({}), // PATCH additions
        ok({}), // DELETE the contractor
      ],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [binding()] }))

        // Members are read BEFORE anything is changed.
        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe(MEMBERS_PATH)
        expect(calls[1].query.limit).toBe('200')
        expect(writeCalls(calls).some((c) => c.path === BINDINGS_PATH && c.method === 'POST')).toBe(false)
        return res
      },
    )

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.priorMembers).toEqual([GROUP, CONTRACTOR])
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('adds every missing member in ONE patch and revokes each member the canvas dropped', async () => {
    await withFetch(
      [
        ok({ id: 'bnd1' }),
        membersList([member('mem-1', GROUP), member('mem-2', CONTRACTOR)]),
        ok({}),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [binding()] }))
        expect(result.success).toBe(true)

        const writes = writeCalls(calls)
        expect(writes).toHaveLength(2)
        expect(writes[0].method).toBe('PATCH')
        expect(writes[0].path).toBe(MEMBERS_PATH)
        expect(writes[0].json).toEqual({ additions: [USER] })

        // Keyed on the MEMBERSHIP id, not the principal's own id.
        expect(writes[1].method).toBe('DELETE')
        expect(writes[1].path).toBe(`${MEMBERS_PATH}/mem-2`)
      },
    )
  })

  it('adds before it removes so Okta never sees the binding lose its last member', async () => {
    await withFetch(
      [ok({ id: 'bnd1' }), membersList([member('mem-2', CONTRACTOR)]), ok({}), ok({})],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [binding()] }))

        expect(result.success).toBe(true)
        const writes = writeCalls(calls)
        // The only member live is the one being revoked — the additions must land first.
        expect(writes[0].method).toBe('PATCH')
        expect(writes[0].json).toEqual({ additions: [GROUP, USER] })
        expect(writes[1].method).toBe('DELETE')
      },
    )
  })

  it('leaves an already-correct membership entirely alone', async () => {
    await withFetch(
      [ok({ id: 'bnd1' }), membersList([member('mem-1', GROUP), member('mem-2', USER)])],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [binding()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)).toHaveLength(0)
      },
    )
  })

  it('matches a member Okta reports in ORN form against the declared reference', async () => {
    const orn = 'orn:okta:directory:00o1:groups:00g1'
    await withFetch([ok({ id: 'bnd1' }), membersList([{ id: 'mem-1', orn }])], async (calls) => {
      const result = await deploy(deployContext({ sections: [binding({ members: [orn] })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('tolerates a 404 when revoking a member that is already gone', async () => {
    await withFetch(
      [
        ok({ id: 'bnd1' }),
        membersList([member('mem-1', GROUP), member('mem-2', USER), member('mem-3', CONTRACTOR)]),
        notFound(),
      ],
      async () => {
        const result = await deploy(deployContext({ sections: [binding()] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('skips an incomplete section rather than creating a grant with no members', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [binding({ members: [] })] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('skips a section that names no resource set — a grant with no scope is not a grant', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [binding({ resourceSet: '' })] }))

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the binding lookup is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [binding()] }))
      // A 403 on the read must never be mistaken for "absent" and turned into a
      // create that re-grants a binding somebody deliberately narrowed.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to fetch binding/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [notFound(), apiError('Api validation failed: role', 400, ['role: not found'])],
      async () => deploy(deployContext({ sections: [binding()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create binding/)
    expect(result.message).toMatch(/role: not found/)
  })

  it('returns a FAILED result when the member list is rejected, before any write', async () => {
    const result = await withFetch(
      [ok({ id: 'bnd1' }), apiError('Insufficient permissions', 403)],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [binding()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list members for binding/)
  })

  it('returns a FAILED result when adding members is rejected, keeping the prior membership', async () => {
    const result = await withFetch(
      [ok({ id: 'bnd1' }), membersList([member('mem-1', GROUP)]), apiError('Invalid member', 400)],
      async () => deploy(deployContext({ sections: [binding()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to add members to binding/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].priorMembers).toEqual([GROUP])
  })

  it('reports how far it got when a later binding fails', async () => {
    const result = await withFetch(
      [notFound(), ok({ id: 'bnd1' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [binding(), { ...binding({ role: 'cr0TIER2' }), name: 'Tier 2 grant' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { createdIds: string[]; previousState: unknown[] }
    expect(rb.createdIds).toEqual([`${RESOURCE_SET}:${ROLE}`])
    expect(rb.previousState).toHaveLength(1)
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([notFound(), ok({ id: 'bnd1' })], async () => {
      const result = await deploy(deployContext({ sections: [binding()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never enumerates or touches a binding the canvas does not declare', async () => {
    await withFetch([ok({ id: 'bnd1' }), membersList([member('mem-1', GROUP), member('mem-2', USER)])], async (calls) => {
      await deploy(deployContext({ sections: [binding()] }))

      for (const call of calls) {
        expect(call.path.startsWith(BINDING_PATH)).toBe(true)
      }
      expect(calls.some((c) => c.path === BINDINGS_PATH)).toBe(false)
    })
  })
})
