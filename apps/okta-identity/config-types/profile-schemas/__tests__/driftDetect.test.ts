// =============================================================================
// profile-schemas — driftDetect, driven against the fake Okta org.
//
// Drift here is a custom attribute quietly deleted, retyped or made writable by
// the end user — the attribute that later feeds a mapping and a token claim. The
// handler compares ONLY the managed custom attributes, and compares them as a
// SUBSET so Okta's own injected defaults (master/mutability/scope/permissions)
// never read as drift. Base attributes are never inspected, and detection writes
// NOTHING.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  leaksToken,
  notFound,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const ATTRS = {
  clearanceLevel: { title: 'Clearance level', type: 'string' },
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

const LABEL = 'user schema "default"'

const IN_SYNC = {
  id: 'schema-1',
  definitions: {
    base: { properties: { login: { title: 'Username', type: 'string' } } },
    custom: {
      properties: {
        clearanceLevel: {
          title: 'Clearance level',
          type: 'string',
          // Okta injects these on every custom attribute.
          master: { type: 'PROFILE_MASTER' },
          mutability: 'READ_WRITE',
          scope: 'NONE',
          permissions: [{ principal: 'SELF', action: 'READ_ONLY' }],
        },
        badgeId: { title: 'Badge', type: 'string' },
      },
    },
  },
}

describe('profile-schemas driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [schema()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no hostname is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [schema()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and accepts Okta-injected defaults as in sync', async () => {
    const result = await withFetch([ok(IN_SYNC)], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [schema()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/meta/schemas/user/default')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok({ definitions: { custom: { properties: {} } } })], async (calls) => {
      await driftDetect(driftContext({ sections: [schema()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('never inspects a base attribute or an unmanaged custom attribute', async () => {
    const result = await withFetch(
      [
        ok({
          definitions: {
            base: { properties: { login: { title: 'CHANGED', type: 'string' } } },
            custom: {
              properties: {
                ...IN_SYNC.definitions.custom.properties,
                badgeId: { title: 'Edited by hand', type: 'integer' },
              },
            },
          },
        }),
      ],
      async () => driftDetect(driftContext({ sections: [schema()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a managed attribute that was deleted out of band as critical drift', async () => {
    const result = await withFetch(
      [ok({ definitions: { custom: { properties: { badgeId: { type: 'string' } } } } })],
      async () => driftDetect(driftContext({ sections: [schema()] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.clearanceLevel`)
    expect(diff?.expected).toBe('present')
    expect(diff?.actual).toBe('missing')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a retyped attribute, reporting both definitions', async () => {
    const result = await withFetch(
      [
        ok({
          definitions: {
            custom: {
              properties: { clearanceLevel: { title: 'Clearance level', type: 'integer' } },
            },
          },
        }),
      ],
      async () => driftDetect(driftContext({ sections: [schema()] })),
    )

    const diff = result.diffs.find((d) => d.field === `${LABEL}.clearanceLevel`)
    expect(diff?.severity).toBe('warning')
    expect(String(diff?.expected)).toMatch(/"type":"string"/)
    expect(String(diff?.actual)).toMatch(/"type":"integer"/)
  })

  it('flags an attribute made end-user writable', async () => {
    const result = await withFetch(
      [
        ok({
          definitions: {
            custom: {
              properties: {
                clearanceLevel: {
                  title: 'Clearance level',
                  type: 'string',
                  permissions: [{ principal: 'SELF', action: 'READ_WRITE' }],
                },
              },
            },
          },
        }),
      ],
      async () =>
        driftDetect(
          driftContext({
            sections: [
              schema({
                attributesJson: JSON.stringify({
                  clearanceLevel: {
                    title: 'Clearance level',
                    type: 'string',
                    permissions: [{ principal: 'SELF', action: 'READ_ONLY' }],
                  },
                }),
              }),
            ],
          }),
        ),
    )

    expect(result.hasDrift).toBe(true)
    expect(String(result.diffs[0].actual)).toMatch(/READ_WRITE/)
  })

  it('flags an attribute declared for REMOVAL that is still live — as a warning', async () => {
    const result = await withFetch([ok(IN_SYNC)], async () =>
      driftDetect(driftContext({ sections: [schema({ attributesJson: '{"clearanceLevel":null}' })] })),
    )

    expect(result.hasDrift).toBe(true)
    const diff = result.diffs.find((d) => d.field === `${LABEL}.clearanceLevel`)
    expect(diff?.expected).toBe('absent')
    expect(diff?.actual).toBe('present')
    expect(diff?.severity).toBe('warning')
  })

  it('reports no drift for a removal that really is absent', async () => {
    const result = await withFetch(
      [ok({ definitions: { custom: { properties: {} } } })],
      async () =>
        driftDetect(driftContext({ sections: [schema({ attributesJson: '{"clearanceLevel":null}' })] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a schema whose user type no longer exists as critical drift', async () => {
    const result = await withFetch([notFound()], async () =>
      driftDetect(driftContext({ sections: [schema({ userTypeId: 'otyGONE' })] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('user schema "otyGONE"')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('reports an unreadable schema as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [schema()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].expected).toBe('reachable')
    expect(String(result.diffs[0].actual)).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining schemas after one is unreadable', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok(IN_SYNC)],
      async () =>
        driftDetect(driftContext({ sections: [schema(), schema({ schemaType: 'group' })] })),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe(LABEL)
  })

  it('ignores a section with no parsable attributes', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({
          sections: [
            schema({ attributesJson: '' }),
            schema({ schemaType: 'application' }),
            schema({ attributesJson: '[1,2]' }),
          ],
        }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
