// =============================================================================
// linked-objects — healthCheck, driven against the fake Okta org.
//
// A definition that has been deleted out of band took every user link with it,
// and nothing else reports that. The check must land it as a failed check rather
// than throwing, and must never print the SSWS token into a check message.
// =============================================================================

import healthCheck from '../healthCheck'
import {
  API_TOKEN,
  apiError,
  emptyCredential,
  EMPTY_LIST,
  healthContext,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function linkedObject(primaryName: string, associatedName = 'reports'): CanvasItemInput {
  return {
    name: `${primaryName} relationship`,
    fields: {
      primaryName,
      primaryTitle: 'Title',
      associatedName,
      associatedTitle: 'Associated title',
    },
  }
}

const live = (primaryName: string): Record<string, unknown> => ({
  primary: { name: primaryName, title: 'Title', type: 'USER' },
  associated: { name: 'reports', title: 'Associated title', type: 'USER' },
})

describe('linked-objects healthCheck', () => {
  it('fails closed with a single credential check when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [linkedObject('manager')], credential: null }),
      )

      expect(result.healthy).toBe(false)
      expect(result.score).toBe(0)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe('okta_credential')
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when the credential carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [linkedObject('manager')], credential: emptyCredential() }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/API token/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('fails closed when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await healthCheck(
        healthContext({ sections: [linkedObject('manager')], hostname: '' }),
      )
      expect(result.healthy).toBe(false)
      expect(result.checks[0].message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('probes the org with the SSWS token before checking any definition', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('manager')])], async (calls) => {
      await healthCheck(healthContext({ sections: [linkedObject('manager')] }))

      expect(calls[0].path).toBe('/org')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[1].path).toBe('/meta/schemas/user/linkedObjects')
    })
  })

  it('reports a revoked or under-scoped token as an unhealthy check, not a crash', async () => {
    const result = await withFetch([unauthorized()], async (calls) => {
      const res = await healthCheck(healthContext({ sections: [linkedObject('manager')] }))
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(0)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0].name).toBe('okta_reachable')
    expect(result.checks[0].message).toMatch(/SSWS/)
    expect(leaksToken(result)).toBe(false)
  })

  it('reports a non-auth API failure as an unhealthy check too', async () => {
    const result = await withFetch([apiError('Okta is down', 503)], async () =>
      healthCheck(healthContext({ sections: [linkedObject('manager')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.checks[0].message).toMatch(/Okta is down/)
  })

  it('passes a check per declared definition and scores 100 when all are present', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('manager')]), ok([live('mentor')])],
      async () =>
        healthCheck(
          healthContext({ sections: [linkedObject('manager'), linkedObject('mentor', 'mentees')] }),
        ),
    )

    expect(result.healthy).toBe(true)
    expect(result.score).toBe(100)
    expect(result.checks).toHaveLength(3)
    expect(result.checks[1].name).toBe('linkedObject:manager')
    expect(result.checks[1].passed).toBe(true)
  })

  it('fails the check for a declared definition that no longer exists', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), ok([live('manager')]), EMPTY_LIST],
      async () =>
        healthCheck(
          healthContext({ sections: [linkedObject('manager'), linkedObject('gone', 'goners')] }),
        ),
    )

    expect(result.healthy).toBe(false)
    // 2 of 3 checks passed.
    expect(result.score).toBe(67)
    const missing = result.checks.find((c) => c.name === 'linkedObject:gone')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toMatch(/does not exist in the Okta org/)
  })

  it('turns a per-definition lookup error into a failed check instead of throwing', async () => {
    const result = await withFetch(
      [ok({ id: 'org1' }), apiError('Insufficient permissions', 403)],
      async () => healthCheck(healthContext({ sections: [linkedObject('manager')] })),
    )

    expect(result.healthy).toBe(false)
    expect(result.score).toBe(50)
    expect(result.checks[1].passed).toBe(false)
    expect(result.checks[1].message).toMatch(/Failed to list linked-object definitions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('skips a section missing either relationship name', async () => {
    const result = await withFetch([ok({ id: 'org1' })], async (calls) => {
      const res = await healthCheck(
        healthContext({
          sections: [{ name: 'incomplete', fields: { primaryName: 'manager', primaryTitle: 'M' } }],
        }),
      )
      expect(calls).toHaveLength(1)
      return res
    })

    expect(result.checks).toHaveLength(1)
    expect(result.score).toBe(100)
  })

  it('writes nothing — a health check must never change the org', async () => {
    await withFetch([ok({ id: 'org1' }), ok([live('manager')])], async (calls) => {
      await healthCheck(healthContext({ sections: [linkedObject('manager')] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })
})
