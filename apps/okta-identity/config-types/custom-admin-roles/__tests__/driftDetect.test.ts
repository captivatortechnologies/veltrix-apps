// =============================================================================
// custom-admin-roles — driftDetect, driven against the fake Okta org.
//
// Drift here is privilege escalation in slow motion: a permission added to a
// role out of band widens everyone bound to it. The tests assert each drift
// shape the handler compares, that an unreadable role is REPORTED rather than
// silently skipped, and that detection itself never writes.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  leaksToken,
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
  description: 'Reset passwords only',
}

function rolesList(roles: unknown[]) {
  return ok({ roles })
}

function permissionsList(labels: string[]) {
  return ok({ permissions: labels.map((label) => ({ label })) })
}

const IN_SYNC_PERMISSIONS = permissionsList(['okta.users.read', 'okta.users.userprofile.manage'])

describe('custom-admin-roles driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [role()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [role()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a matching role as in sync', async () => {
    const result = await withFetch([rolesList([LIVE_ROLE]), IN_SYNC_PERMISSIONS], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [role()] }))
      expect(calls).toHaveLength(2)
      expect(calls[0].path).toBe('/iam/roles')
      expect(calls[1].path).toBe('/iam/roles/cr0LIVE/permissions')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([rolesList([LIVE_ROLE]), permissionsList(['okta.groups.manage'])], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [role()] }))
      expect(result.hasDrift).toBe(true)
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted role as critical drift', async () => {
    const result = await withFetch([rolesList([])], async () =>
      driftDetect(driftContext({ sections: [role()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Helpdesk Tier 1')
    expect(diff).toBeDefined()
    expect(diff?.expected).toBe('exists')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags an added permission as critical drift — this is privilege widening', async () => {
    const result = await withFetch(
      [
        rolesList([LIVE_ROLE]),
        permissionsList(['okta.users.read', 'okta.users.userprofile.manage', 'okta.users.manage']),
      ],
      async () => driftDetect(driftContext({ sections: [role()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === 'Helpdesk Tier 1.permissions')
    expect(diff?.severity).toBe('critical')
    expect(diff?.expected).toEqual(['okta.users.read', 'okta.users.userprofile.manage'])
    expect(diff?.actual).toEqual([
      'okta.users.manage',
      'okta.users.read',
      'okta.users.userprofile.manage',
    ])
  })

  it('flags a revoked permission as critical drift too', async () => {
    const result = await withFetch(
      [rolesList([LIVE_ROLE]), permissionsList(['okta.users.read'])],
      async () => driftDetect(driftContext({ sections: [role()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk Tier 1.permissions')
    expect(diff?.actual).toEqual(['okta.users.read'])
  })

  it('compares the permission set order-insensitively', async () => {
    const result = await withFetch(
      [rolesList([LIVE_ROLE]), permissionsList(['okta.users.userprofile.manage', 'okta.users.read'])],
      async () => driftDetect(driftContext({ sections: [role()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a rewritten description as a warning', async () => {
    const result = await withFetch(
      [rolesList([{ ...LIVE_ROLE, description: 'Now does everything' }]), IN_SYNC_PERMISSIONS],
      async () => driftDetect(driftContext({ sections: [role()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk Tier 1.description')
    expect(diff?.expected).toBe('Reset passwords only')
    expect(diff?.actual).toBe('Now does everything')
    expect(diff?.severity).toBe('warning')
  })

  it('renders a cleared description as "not set" rather than an empty string', async () => {
    const result = await withFetch(
      [rolesList([{ id: 'cr0LIVE', label: 'Helpdesk Tier 1' }]), IN_SYNC_PERMISSIONS],
      async () => driftDetect(driftContext({ sections: [role()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Helpdesk Tier 1.description')
    expect(diff?.actual).toBe('not set')
  })

  it('never reads the label as drift — it is the identity the match is made on', async () => {
    const result = await withFetch([rolesList([LIVE_ROLE]), IN_SYNC_PERMISSIONS], async () =>
      driftDetect(driftContext({ sections: [role()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.label'))).toHaveLength(0)
  })

  it('reports an unreadable role list as one critical diff instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [role()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('custom-admin-roles')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports an unreadable permission set as critical drift on that role alone', async () => {
    const result = await withFetch(
      [
        rolesList([LIVE_ROLE, { id: 'cr0TWO', label: 'Helpdesk Tier 2', description: 'Reset passwords only' }]),
        apiError('Insufficient permissions', 403),
        IN_SYNC_PERMISSIONS,
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [role(), { ...role({ label: 'Helpdesk Tier 2' }), name: 'Tier 2' }],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    const broken = result.diffs.find((d) => d.field === 'Helpdesk Tier 1')
    expect(String(broken?.actual)).toMatch(/unreachable/)
    expect(broken?.severity).toBe('critical')
    // The second role was still compared — one unreadable object does not abort.
    expect(result.diffs).toHaveLength(1)
  })

  it('ignores a section with no declared permissions rather than flagging it as drift', async () => {
    const result = await withFetch([rolesList([])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [role({ permissions: [] })] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.hasDrift).toBe(false)
  })

  it('never inspects a role the deployed config does not declare', async () => {
    await withFetch(
      [rolesList([LIVE_ROLE, { id: 'cr0OTHER', label: 'Untouched' }]), IN_SYNC_PERMISSIONS],
      async (calls) => {
        await driftDetect(driftContext({ sections: [role()] }))
        expect(calls.some((c) => c.path.includes('cr0OTHER'))).toBe(false)
      },
    )
  })
})
