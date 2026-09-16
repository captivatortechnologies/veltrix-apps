// =============================================================================
// resource-set-bindings — driftDetect, driven against the fake Okta org.
//
// A member added to a live binding out of band is a new administrator nobody
// declared; a member removed is an operator who silently lost access. Both are
// CRITICAL, and both must be reported without the detector ever writing.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  API_BASE,
  apiError,
  driftContext,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const RESOURCE_SET = 'Helpdesk scope'
const ROLE = 'cr0HELPDESK'
const LABEL = `${RESOURCE_SET}:${ROLE}`
const BINDING_PATH = '/iam/resource-sets/Helpdesk%20scope/bindings/cr0HELPDESK'
const MEMBERS_PATH = `${BINDING_PATH}/members`

const GROUP = `${API_BASE}/groups/00g1`
const USER = `${API_BASE}/users/00u1`
const INTRUDER = `${API_BASE}/users/00uINTRUDER`

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

const IN_SYNC_MEMBERS = membersList([member('mem-1', GROUP), member('mem-2', USER)])

describe('resource-set-bindings driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [binding()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [binding()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching binding as in sync', async () => {
    const result = await withFetch([ok({ id: 'bnd1' }), IN_SYNC_MEMBERS], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [binding()] }))
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe(BINDING_PATH)
      expect(calls[1].path).toBe(MEMBERS_PATH)
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok({ id: 'bnd1' }), membersList([member('mem-9', INTRUDER)])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [binding()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a binding that no longer exists as critical drift', async () => {
    const result = await withFetch([notFound()], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [binding()] }))
      // No point asking for members of a binding that is gone.
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === LABEL)
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags an added member as critical drift — this is an undeclared administrator', async () => {
    const result = await withFetch(
      [
        ok({ id: 'bnd1' }),
        membersList([member('mem-1', GROUP), member('mem-2', USER), member('mem-3', INTRUDER)]),
      ],
      async () => driftDetect(driftContext({ sections: [binding()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.members`)
    expect(diff?.severity).toBe('critical')
    expect(diff?.expected).toEqual([GROUP, USER])
    expect(diff?.actual).toEqual([GROUP, USER, INTRUDER])
  })

  it('flags a removed member as critical drift too', async () => {
    const result = await withFetch(
      [ok({ id: 'bnd1' }), membersList([member('mem-1', GROUP)])],
      async () => driftDetect(driftContext({ sections: [binding()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.members`)
    expect(diff?.severity).toBe('critical')
    expect(diff?.actual).toEqual([GROUP])
  })

  it('compares the member set order-insensitively', async () => {
    const result = await withFetch(
      [ok({ id: 'bnd1' }), membersList([member('mem-2', USER), member('mem-1', GROUP)])],
      async () => driftDetect(driftContext({ sections: [binding()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('accepts a member Okta reports in ORN form against the declared reference', async () => {
    const orn = 'orn:okta:directory:00o1:groups:00g1'
    const result = await withFetch(
      [ok({ id: 'bnd1' }), membersList([{ id: 'mem-1', orn }])],
      async () => driftDetect(driftContext({ sections: [binding({ members: [orn] })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('never reads the resource set or role as drift — together they are the identity', async () => {
    const result = await withFetch([ok({ id: 'bnd1' }), IN_SYNC_MEMBERS], async () =>
      driftDetect(driftContext({ sections: [binding()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.role'))).toHaveLength(0)
    expect(result.diffs.filter((d) => d.field.endsWith('.resourceSet'))).toHaveLength(0)
  })

  it('reports an unreadable binding as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [binding()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(LABEL)
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable member list as critical drift on that binding alone', async () => {
    const result = await withFetch(
      [
        ok({ id: 'bnd1' }),
        apiError('Insufficient permissions', 403),
        ok({ id: 'bnd2' }),
        IN_SYNC_MEMBERS,
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [binding(), { ...binding({ role: 'cr0TIER2' }), name: 'Tier 2 grant' }],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const broken = result.diffs.find((d) => d.field === LABEL)
    expect(String(broken?.actual)).toMatch(/unreachable/)
    // The second binding was still compared — one unreadable object does not abort.
    expect(result.diffs).toHaveLength(1)
  })

  it('ignores a section with no declared members rather than flagging it as drift', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [binding({ members: [] })] }))
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('never inspects a binding the deployed config does not declare', async () => {
    await withFetch([ok({ id: 'bnd1' }), IN_SYNC_MEMBERS], async (calls) => {
      await driftDetect(driftContext({ sections: [binding()] }))

      for (const call of calls) {
        expect(call.path.startsWith(BINDING_PATH)).toBe(true)
      }
    })
  })
})
