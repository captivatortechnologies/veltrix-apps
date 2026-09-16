// =============================================================================
// custom-admin-roles — deploy, driven against the fake Okta org.
//
// A custom admin role IS a privilege grant. Getting this wrong hands an operator
// permissions nobody declared, or quietly drops the ones that were, so the tests
// below assert the exact request sequence, the permission set actually sent, the
// refusal to touch Okta's built-in roles, and the rollback state recorded when a
// live role is rewritten.
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

function role(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Helpdesk Tier 1',
    fields: {
      label: 'Helpdesk Tier 1',
      description: 'Reset passwords only',
      permissions: ['okta.users.read', 'okta.users.userprofile.manage'],
      ...fields,
    },
  }
}

const LIVE_ROLE = {
  id: 'cr0LIVE',
  label: 'Helpdesk Tier 1',
  description: 'Old description',
}

function rolesList(roles: unknown[]) {
  return ok({ roles })
}

function permissionsList(labels: string[]) {
  return ok({ permissions: labels.map((label) => ({ label })) })
}

describe('custom-admin-roles deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [role()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [role()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [role()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    const result = await withFetch([rolesList([]), ok({ id: 'cr0NEW' })], async (calls) => {
      const res = await deploy(deployContext({ sections: [role()] }))

      expect(calls[0].path).toBe('/iam/roles')
      expect(calls[0].method).toBe('GET')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('creates a role that does not exist, granting exactly the declared permissions', async () => {
    await withFetch([rolesList([]), ok({ id: 'cr0NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [role()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/iam/roles')
      expect(writes[0].json).toEqual({
        label: 'Helpdesk Tier 1',
        description: 'Reset passwords only',
        permissions: ['okta.users.read', 'okta.users.userprofile.manage'],
      })
    })
  })

  it('de-duplicates the declared permission set before granting it', async () => {
    await withFetch([rolesList([]), ok({ id: 'cr0NEW' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [role({ permissions: ['okta.users.read', 'okta.users.read', 'okta.groups.read'] })],
        }),
      )

      expect(writeCalls(calls)[0].json.permissions).toEqual(['okta.users.read', 'okta.groups.read'])
    })
  })

  it('records the created role so rollback can delete it', async () => {
    const result = await withFetch([rolesList([]), ok({ id: 'cr0NEW' })], async () =>
      deploy(deployContext({ sections: [role()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].existed).toBe(false)
    expect(rb.previousState[0].id).toBe('cr0NEW')
    expect(rb.previousState[0].prior).toBeUndefined()
    expect(rb.previousState[0].priorPermissions).toBeUndefined()
    expect(rb.createdIds).toEqual(['cr0NEW'])
  })

  it('fails rather than losing track of a role Okta created without returning an id', async () => {
    const result = await withFetch([rolesList([]), ok({ label: 'Helpdesk Tier 1' })], async () =>
      deploy(deployContext({ sections: [role()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
    expect((result.rollbackData as { createdIds: string[] }).createdIds).toEqual([])
  })

  it('updates a role that already exists and captures its prior label, description and permissions', async () => {
    const result = await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read', 'okta.apps.read']),
        ok({ id: 'cr0LIVE' }),
        ok({}), // POST the one missing permission
        ok({}), // DELETE the one extra permission
      ],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [role()] }))

        // The prior permission set is read BEFORE anything is changed.
        expect(calls[1].method).toBe('GET')
        expect(calls[1].path).toBe('/iam/roles/cr0LIVE/permissions')

        const writes = writeCalls(calls)
        expect(writes[0].method).toBe('PUT')
        expect(writes[0].path).toBe('/iam/roles/cr0LIVE')
        // PUT carries label/description only — Okta ignores permissions here.
        expect(writes[0].json).toEqual({
          label: 'Helpdesk Tier 1',
          description: 'Reset passwords only',
        })
        return res
      },
    )

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('cr0LIVE')
    expect(entry.prior).toEqual({ label: 'Helpdesk Tier 1', description: 'Old description' })
    expect(entry.priorPermissions).toEqual(['okta.users.read', 'okta.apps.read'])
  })

  it('reconciles the permission set one at a time, adding what is missing and revoking what is extra', async () => {
    await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read', 'okta.apps.read']),
        ok({ id: 'cr0LIVE' }),
        ok({}),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [role()] }))
        expect(result.success).toBe(true)

        const adds = writeCalls(calls).filter((c) => c.method === 'POST')
        expect(adds).toHaveLength(1)
        expect(adds[0].path).toBe('/iam/roles/cr0LIVE/permissions/okta.users.userprofile.manage')

        // The permission the canvas no longer declares is REVOKED, not left live.
        const removes = writeCalls(calls).filter((c) => c.method === 'DELETE')
        expect(removes).toHaveLength(1)
        expect(removes[0].path).toBe('/iam/roles/cr0LIVE/permissions/okta.apps.read')
      },
    )
  })

  it('leaves an already-correct permission set entirely alone', async () => {
    await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read', 'okta.users.userprofile.manage']),
        ok({ id: 'cr0LIVE' }),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [role()] }))

        expect(result.success).toBe(true)
        expect(writeCalls(calls)).toHaveLength(1)
        expect(calls.some((c) => c.path.includes('/permissions/'))).toBe(false)
      },
    )
  })

  it('tolerates a 404 when revoking a permission that is already gone', async () => {
    await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read', 'okta.users.userprofile.manage', 'okta.apps.read']),
        ok({ id: 'cr0LIVE' }),
        notFound(),
      ],
      async () => {
        const result = await deploy(deployContext({ sections: [role()] }))
        expect(result.success).toBe(true)
      },
    )
  })

  it('refuses to manage an Okta standard/built-in admin role', async () => {
    const result = await withFetch([rolesList([])], async (calls) => {
      const res = await deploy(
        deployContext({ sections: [role({ label: 'SUPER_ADMIN' })] }),
      )
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/standard\/built-in role/)
    expect(result.message).toMatch(/SUPER_ADMIN/)
  })

  it('refuses a built-in role written in the human spelling too', async () => {
    const result = await withFetch([rolesList([])], async () =>
      deploy(deployContext({ sections: [role({ label: 'Super Admin' })] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/standard\/built-in role/)
  })

  it('skips an incomplete section rather than creating a role with no permissions', async () => {
    await withFetch([rolesList([])], async (calls) => {
      const result = await deploy(deployContext({ sections: [role({ permissions: [] })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('returns a FAILED result rather than throwing when the role list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [role()] }))
      // A 403 on the read must never be mistaken for "no roles exist" and
      // turned into a create of a role that is already live.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list custom admin roles/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [rolesList([]), apiError('Api validation failed: permissions', 400, ['okta.bogus: unknown'])],
      async () => deploy(deployContext({ sections: [role()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create role/)
    expect(result.message).toMatch(/okta.bogus: unknown/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result when granting a permission is rejected, keeping the rollback state', async () => {
    const result = await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read']),
        ok({ id: 'cr0LIVE' }),
        apiError('Permission not found', 400),
      ],
      async () => deploy(deployContext({ sections: [role()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to add permission/)
    const rb = result.rollbackData as { previousState: Array<Record<string, unknown>> }
    // The PUT already landed — rollback must still know the prior state.
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].priorPermissions).toEqual(['okta.users.read'])
  })

  it('reports how far it got when a later role fails', async () => {
    const result = await withFetch(
      [rolesList([]), ok({ id: 'cr0ONE' }), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [role(), { ...role({ label: 'Helpdesk Tier 2' }), name: 'Tier 2' }],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { createdIds: string[]; previousState: unknown[] }
    expect(rb.createdIds).toEqual(['cr0ONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('lists the org roles once, not once per declared role', async () => {
    await withFetch(
      [rolesList([]), ok({ id: 'cr0ONE' }), ok({ id: 'cr0TWO' })],
      async (calls) => {
        const result = await deploy(
          deployContext({
            sections: [role(), { ...role({ label: 'Helpdesk Tier 2' }), name: 'Tier 2' }],
          }),
        )

        expect(result.success).toBe(true)
        expect(calls.filter((c) => c.path === '/iam/roles' && c.method === 'GET')).toHaveLength(1)
      },
    )
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([rolesList([]), ok({ id: 'cr0NEW' })], async () => {
      const result = await deploy(deployContext({ sections: [role()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('never touches a role the canvas does not declare', async () => {
    await withFetch(
      [rolesList([LIVE_ROLE, { id: 'cr0OTHER', label: 'Untouched', description: 'Someone else' }]), ok({ id: 'x' })],
      async (calls) => {
        await deploy(deployContext({ sections: [role({ label: 'Brand New' })] }))
        expect(calls.some((c) => c.path.includes('cr0OTHER'))).toBe(false)
        expect(calls.some((c) => c.path.includes('cr0LIVE'))).toBe(false)
      },
    )
  })
})
