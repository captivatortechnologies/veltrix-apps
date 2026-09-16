// =============================================================================
// profile-mappings — deploy, driven against the fake Okta org.
//
// A profile mapping is the wiring that feeds attributes into the claims an
// authorization server stamps into tokens: change the expression behind
// `department` and every downstream decision that reads it changes with it.
// Mappings are UPDATE-ONLY — the object is never created or deleted — and the
// update is a MERGE, so only the declared target-property names may ever be
// touched. These tests assert the resolve-then-merge sequence, the exact body,
// the prior state captured for rollback, and the failure contract.
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
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const PROPS = {
  department: { expression: 'appuser.department', pushStatus: 'PUSH' },
}

function mapping(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'HR to Okta',
    fields: {
      sourceId: '0oaHRAPP',
      targetId: 'otyDEFAULT',
      propertiesJson: JSON.stringify(PROPS),
      ...fields,
    },
  }
}

const RESOLVED = { id: 'prm1a2b3c', source: { id: '0oaHRAPP' }, target: { id: 'otyDEFAULT' } }

const FULL_MAPPING = {
  ...RESOLVED,
  properties: {
    department: { expression: 'appuser.oldDepartment', pushStatus: 'DONT_PUSH' },
    costCenter: { expression: 'appuser.costCenter', pushStatus: 'PUSH' },
  },
}

describe('profile-mappings deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [mapping()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [mapping()], credential: emptyCredential() }),
      )
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [mapping()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('sends the SSWS token on its first request and never echoes it back', async () => {
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [mapping()] }))

      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      expect(leaksToken(result)).toBe(false)
    })
  })

  it('resolves the mapping by the (source, target) pair before reading or writing it', async () => {
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [mapping()] }))

      expect(result.success).toBe(true)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/mappings')
      expect(calls[0].query.sourceId).toBe('0oaHRAPP')
      expect(calls[0].query.targetId).toBe('otyDEFAULT')
      expect(calls[1].method).toBe('GET')
      expect(calls[1].path).toBe('/mappings/prm1a2b3c')
    })
  })

  it('MERGES only the declared target properties — never the whole property set', async () => {
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [mapping()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/mappings/prm1a2b3c')
      expect(writes[0].json).toEqual({ properties: PROPS })
      // costCenter is live but unmanaged — it must not appear in the patch.
      const sent = writes[0].json.properties as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(sent, 'costCenter')).toBe(false)
    })
  })

  it('sends a null pair verbatim to REMOVE a property mapping', async () => {
    const removal = { department: { expression: null, pushStatus: null } }
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({ sections: [mapping({ propertiesJson: JSON.stringify(removal) })] }),
      )

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json).toEqual({ properties: removal })
    })
  })

  it('captures the prior value of every managed property for rollback', async () => {
    const result = await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async () =>
      deploy(deployContext({ sections: [mapping()] })),
    )

    const rb = result.rollbackData as {
      previousState: Array<Record<string, unknown>>
      createdIds: string[]
    }
    expect(rb.previousState).toHaveLength(1)
    expect(rb.previousState[0].mappingId).toBe('prm1a2b3c')
    expect(rb.previousState[0].sourceId).toBe('0oaHRAPP')
    expect(rb.previousState[0].targetId).toBe('otyDEFAULT')
    expect(rb.previousState[0].priorProperties).toEqual({
      department: { expression: 'appuser.oldDepartment', pushStatus: 'DONT_PUSH' },
    })
    // Mappings are never created, so there is never anything to delete.
    expect(rb.createdIds).toEqual([])
  })

  it('captures a null pair as the prior state of a property this deploy ADDS', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok({ ...FULL_MAPPING, properties: {} }), ok({})],
      async () => deploy(deployContext({ sections: [mapping()] })),
    )

    const entry = (result.rollbackData as { previousState: Array<Record<string, unknown>> })
      .previousState[0]
    // A null pair re-removes on rollback what this deploy added.
    expect(entry.priorProperties).toEqual({
      department: { expression: null, pushStatus: null },
    })
  })

  it('fails clearly when no mapping exists between the source and target', async () => {
    const result = await withFetch([EMPTY_LIST], async (calls) => {
      const res = await deploy(deployContext({ sections: [mapping()] }))
      // Nothing may be written when the mapping could not be resolved.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/No profile mapping exists between source "0oaHRAPP" and target "otyDEFAULT"/)
    expect(result.message).toMatch(/created implicitly/)
  })

  it('refuses to guess when the resolve is ambiguous', async () => {
    const result = await withFetch(
      [ok([RESOLVED, { ...RESOLVED, id: 'prmOTHER' }])],
      async (calls) => {
        const res = await deploy(deployContext({ sections: [mapping()] }))
        expect(writeCalls(calls)).toHaveLength(0)
        return res
      },
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Ambiguous: 2 profile mappings match/)
  })

  it('fails when the resolved mapping carries no id', async () => {
    const result = await withFetch([ok([{ source: { id: '0oaHRAPP' } }])], async (calls) => {
      const res = await deploy(deployContext({ sections: [mapping()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/has no id/)
  })

  it('fails — without writing — when the mapping vanishes between resolve and read', async () => {
    const result = await withFetch([ok([RESOLVED]), notFound()], async (calls) => {
      const res = await deploy(deployContext({ sections: [mapping()] }))
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Profile mapping prm1a2b3c .* no longer exists/)
  })

  it('returns a FAILED result rather than throwing when the resolve is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      deploy(deployContext({ sections: [mapping()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to list profile mappings/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [
        ok([RESOLVED]),
        ok(FULL_MAPPING),
        apiError('Api validation failed: properties', 400, ['expression: invalid']),
      ],
      async () => deploy(deployContext({ sections: [mapping()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update property mappings for source "0oaHRAPP"/)
    expect(result.message).toMatch(/expression: invalid/)
  })

  it('skips a section the validator would have rejected without calling the org', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [
            mapping({ sourceId: '' }),
            mapping({ targetId: '' }),
            mapping({ propertiesJson: '' }),
            mapping({ propertiesJson: '{}' }),
            mapping({ propertiesJson: '[not json' }),
          ],
        }),
      )

      expect(result.success).toBe(true)
      expect(calls).toHaveLength(0)
    })
  })

  it('does not depend on the platform data API to resolve a mapping', async () => {
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [mapping()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('reports partial progress and keeps rollback state when a later mapping fails', async () => {
    const result = await withFetch(
      [ok([RESOLVED]), ok(FULL_MAPPING), ok({}), apiError('Insufficient permissions', 403)],
      async () =>
        deploy(
          deployContext({
            sections: [mapping(), mapping({ targetId: 'otyCONTRACTOR' })],
          }),
        ),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/1 of 2/)
    const rb = result.rollbackData as { previousState: unknown[] }
    expect(rb.previousState).toHaveLength(1)
    expect((result.artifacts as { deployedMappings: string[] }).deployedMappings).toEqual([
      'source "0oaHRAPP" -> target "otyDEFAULT" (1 prop)',
    ])
  })

  it('never creates or deletes the mapping object itself', async () => {
    await withFetch([ok([RESOLVED]), ok(FULL_MAPPING), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [mapping()] }))

      expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
      expect(calls.some((c) => c.method === 'PUT')).toBe(false)
      // The only POST is against an EXISTING mapping id, never the collection.
      expect(calls.some((c) => c.method === 'POST' && c.path === '/mappings')).toBe(false)
    })
  })
})
