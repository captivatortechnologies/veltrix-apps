// =============================================================================
// device-assurance-policies — deploy, driven against the fake Okta org.
//
// A device assurance policy is the posture gate an authentication policy leans
// on: weaken it and unmanaged laptops start passing. There is no upsert and no
// lifecycle, and `platform` is immutable — a mismatch has to fail loudly rather
// than silently rewrite the wrong policy. These tests assert the request
// sequence, the exact body, the rollback state and the failure contract.
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

const CONFIG_JSON =
  '{"diskEncryptionType":{"include":["FULL"]},"screenLockType":{"include":["BIOMETRIC"]}}'

function assurance(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Managed macOS',
    fields: { name: 'Managed macOS', platform: 'MACOS', configJson: CONFIG_JSON, ...fields },
  }
}

const LIVE = {
  id: 'dap-1',
  name: 'Managed macOS',
  platform: 'MACOS',
  createdBy: 'admin-1',
  createdDate: '2025-01-01T00:00:00.000Z',
  lastUpdate: '2025-06-01T00:00:00.000Z',
  lastUpdatedBy: 'admin-1',
  _links: { self: { href: 'https://example.test' } },
  diskEncryptionType: { include: ['FULL'] },
  screenLockType: { include: ['PASSCODE'] },
}

describe('device-assurance-policies deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [assurance()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [assurance()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance()] }))

      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('creates a policy the org does not have, with the modelled name and platform', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/device-assurances')

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/device-assurances')
      expect(writes[0].json).toEqual({
        diskEncryptionType: { include: ['FULL'] },
        screenLockType: { include: ['BIOMETRIC'] },
        platform: 'MACOS',
        name: 'Managed macOS',
      })
    })
  })

  it('lets the modelled name and platform win over anything inside the requirements JSON', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async (calls) => {
      await deploy(
        deployContext({
          sections: [
            assurance({ configJson: '{"name":"Impostor","platform":"WINDOWS","jailbreak":false}' }),
          ],
        }),
      )

      const body = writeCalls(calls)[0].json
      expect(body.name).toBe('Managed macOS')
      expect(body.platform).toBe('MACOS')
      expect(body.jailbreak).toBe(false)
    })
  })

  it('records the created policy so rollback can delete it', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async () =>
      deploy(deployContext({ sections: [assurance()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.createdIds).toEqual(['dap-NEW'])
    expect(rb.previousState).toEqual([{ name: 'Managed macOS', existed: false, id: 'dap-NEW' }])
  })

  it('updates a policy that already exists and captures its prior requirements', async () => {
    const result = await withFetch([ok([LIVE]), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [assurance()] }))

      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('PUT')
      expect(writes[0].path).toBe('/device-assurances/dap-1')
      expect(writes[0].json.screenLockType).toEqual({ include: ['BIOMETRIC'] })
      return res
    })

    expect(result.success).toBe(true)
    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    expect(entry.existed).toBe(true)
    expect(entry.id).toBe('dap-1')
    // Server-managed fields are stripped so the captured body is safe to PUT back.
    expect(entry.prior).toEqual({
      name: 'Managed macOS',
      platform: 'MACOS',
      diskEncryptionType: { include: ['FULL'] },
      screenLockType: { include: ['PASSCODE'] },
    })
  })

  it('REFUSES to rewrite a policy whose platform differs — the platform is immutable', async () => {
    const result = await withFetch([ok([{ ...LIVE, platform: 'IOS' }])], async (calls) => {
      const res = await deploy(deployContext({ sections: [assurance()] }))
      // Nothing is written: silently repointing a live posture gate at another
      // platform would disable it for every device it was protecting.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/platform is immutable/)
    expect(result.message).toMatch(/Delete and recreate/)
  })

  it('matches a policy by exact name and never adopts a differently named one', async () => {
    await withFetch([ok([{ ...LIVE, id: 'dap-OTHER', name: 'managed macos' }]), ok({ id: 'dap-NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance()] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].method).toBe('POST')
      expect(calls.some((c) => c.path === '/device-assurances/dap-OTHER')).toBe(false)
    })
  })

  it('follows pagination when the policy list spans pages', async () => {
    await withFetch(
      [
        {
          status: 200,
          body: [{ id: 'dap-x', name: 'Managed Windows', platform: 'WINDOWS' }],
          headers: { link: `<${API_BASE}/device-assurances?after=abc>; rel="next"` },
        },
        ok([LIVE]),
        ok({}),
      ],
      async (calls) => {
        const result = await deploy(deployContext({ sections: [assurance()] }))

        expect(result.success).toBe(true)
        expect(calls[1].query.after).toBe('abc')
        expect(writeCalls(calls)[0].path).toBe('/device-assurances/dap-1')
      },
    )
  })

  it('never deletes anything while deploying', async () => {
    await withFetch([ok([LIVE]), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [assurance()] }))
      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
    })
  })

  it('returns a FAILED result rather than throwing when the requirements JSON is unusable', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [assurance({ configJson: '[1,2]' })] }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/requirements \(configJson\) is not a valid JSON object/)
  })

  it('returns a FAILED result rather than throwing when the list is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [assurance()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list device assurance policies/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok([LIVE]), apiError('Api validation failed: screenLockType', 400, ['include: invalid'])],
      async () => deploy(deployContext({ sections: [assurance()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update device assurance policy "Managed macOS"/)
    expect(result.message).toMatch(/include: invalid/)
  })

  it('returns a FAILED result rather than throwing when the create is rejected', async () => {
    const result = await withFetch(
      [EMPTY_LIST, apiError('Device assurance is not enabled for this org', 403)],
      async () => deploy(deployContext({ sections: [assurance()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to create device assurance policy "Managed macOS"/)
  })

  it('fails loudly when a create succeeds but the API returns no id', async () => {
    const result = await withFetch([EMPTY_LIST, ok({ name: 'Managed macOS' })], async () =>
      deploy(deployContext({ sections: [assurance()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/returned no id/)
  })

  it('reports partial progress and keeps rollback state when a later policy fails', async () => {
    const result = await withFetch(
      [EMPTY_LIST, ok({ id: 'dap-ONE' }), EMPTY_LIST, apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [assurance(), assurance({ name: 'Managed Windows', platform: 'WINDOWS' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[]; createdIds: string[] }
    expect(rb.createdIds).toEqual(['dap-ONE'])
    expect(rb.previousState).toHaveLength(1)
  })

  it('does not depend on the platform handing back a prior deployment', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance()], platformThrows: true }))
      expect(result.success).toBe(true)
      expect(calls[0].path).toBe('/device-assurances')
    })
  })

  it('ignores a section missing a name, a platform or its requirements', async () => {
    for (const fields of [{ name: '' }, { platform: '' }, { configJson: '' }]) {
      await withFetch([], async (calls) => {
        const result = await deploy(deployContext({ sections: [assurance(fields)] }))
        expect(result.success).toBe(true)
        expect(calls).toHaveLength(0)
      })
    }
  })

  it('normalises a lower-case platform so it still deploys as the Okta enum', async () => {
    await withFetch([EMPTY_LIST, ok({ id: 'dap-NEW' })], async (calls) => {
      const result = await deploy(deployContext({ sections: [assurance({ platform: 'macos' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.platform).toBe('MACOS')
    })
  })
})
