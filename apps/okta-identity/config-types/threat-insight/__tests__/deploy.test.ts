// =============================================================================
// threat-insight — deploy, driven against the fake Okta org.
//
// ThreatInsight is the org-wide switch that decides whether Okta blocks, audits
// or ignores requests from IPs it has flagged as malicious — plus the zones that
// are exempt from it. It is a singleton and every update is a FULL REPLACE, so
// these tests pin the exact body sent, the prior config captured before it, and
// that a failure never silently drops a zone exemption.
// =============================================================================

import deploy from '../deploy'
import {
  API_BASE,
  API_TOKEN,
  apiError,
  deployContext,
  emptyCredential,
  leaksToken,
  ok,
  unauthorized,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

function config(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'ThreatInsight',
    fields: { action: 'block', excludeZones: ['nzoCORP'], ...fields },
  }
}

const LIVE_CONFIG = {
  action: 'audit',
  excludeZones: ['nzoLEGACY'],
  created: '2026-01-01T00:00:00.000Z',
  lastUpdated: '2026-01-02T00:00:00.000Z',
  _links: { self: { href: `${API_BASE}/threats/configuration` } },
}

describe('threat-insight deploy', () => {
  it('refuses before touching the org when no credential is configured', async () => {
    const result = await withFetch([], async (calls) => {
      const res = await deploy(deployContext({ sections: [config()], credential: null }))
      expect(calls).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/API token/i)
  })

  it('refuses when the credential exists but carries no SSWS token', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [config()], credential: emptyCredential() }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when no Okta org is registered on the component', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [config()], hostname: '' }))
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Okta org/i)
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses when the canvas declares no action rather than guessing one', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [config({ action: '' })] }))
      expect(result.success).toBe(false)
      expect(result.message).toBe('No ThreatInsight configuration provided')
      expect(calls).toHaveLength(0)
    })
  })

  it('refuses on an empty canvas', async () => {
    await withFetch([], async (calls) => {
      const result = await deploy(deployContext({ sections: [] }))
      expect(result.success).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the current configuration with the SSWS token before changing it', async () => {
    const result = await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      const res = await deploy(deployContext({ sections: [config()] }))

      expect(calls[0].method).toBe('GET')
      expect(calls[0].path).toBe('/threats/configuration')
      expect(calls[0].authorization).toBe(`SSWS ${API_TOKEN}`)
      expect(calls[0].url).toMatch(API_BASE)
      return res
    })

    expect(result.success).toBe(true)
    expect(leaksToken(result)).toBe(false)
  })

  it('sends a full replace of action and exempt zones', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [config()] }))

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].method).toBe('POST')
      expect(writes[0].path).toBe('/threats/configuration')
      expect(writes[0].json).toEqual({ action: 'block', excludeZones: ['nzoCORP'] })
    })
  })

  it('always sends excludeZones so clearing every exemption actually converges', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [config({ excludeZones: [] })] }))
      expect(writeCalls(calls)[0].json).toEqual({ action: 'block', excludeZones: [] })
    })
  })

  it('normalises an upper-case action rather than sending one Okta rejects', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      const result = await deploy(deployContext({ sections: [config({ action: 'BLOCK' })] }))

      expect(result.success).toBe(true)
      expect(writeCalls(calls)[0].json.action).toBe('block')
    })
  })

  it('de-duplicates exempt zones so the replace body is stable', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      await deploy(
        deployContext({ sections: [config({ excludeZones: ['nzoCORP', 'nzoCORP', 'nzoVPN'] })] }),
      )
      expect(writeCalls(calls)[0].json.excludeZones).toEqual(['nzoCORP', 'nzoVPN'])
    })
  })

  it('captures the org\'s prior configuration so rollback can put it back', async () => {
    const result = await withFetch([ok(LIVE_CONFIG), ok({})], async () =>
      deploy(deployContext({ sections: [config()] })),
    )

    const rb = result.rollbackData as { prior: { action: string; excludeZones: string[] } }
    expect(rb.prior.action).toBe('audit')
    expect(rb.prior.excludeZones).toEqual(['nzoLEGACY'])
  })

  it('records a safe prior when the org returns no action', async () => {
    const result = await withFetch([ok({}), ok({})], async () =>
      deploy(deployContext({ sections: [config()] })),
    )

    const rb = result.rollbackData as { prior: { action: string; excludeZones: string[] } }
    // Falls back to audit, not none — rollback must never quietly disable
    // ThreatInsight on an org whose prior state could not be read.
    expect(rb.prior.action).toBe('audit')
    expect(rb.prior.excludeZones).toEqual([])
  })

  it('records an empty exemption list when the org returns a malformed excludeZones', async () => {
    const result = await withFetch([ok({ action: 'block', excludeZones: 'nzoCORP' }), ok({})], async () =>
      deploy(deployContext({ sections: [config()] })),
    )

    const rb = result.rollbackData as { prior: { excludeZones: string[] } }
    expect(rb.prior.excludeZones).toEqual([])
  })

  it('deploys only the first configuration — ThreatInsight is an org singleton', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      const result = await deploy(
        deployContext({
          sections: [config(), { ...config({ action: 'none' }), name: 'Second' }],
        }),
      )

      expect(result.success).toBe(true)
      const writes = writeCalls(calls)
      expect(writes).toHaveLength(1)
      expect(writes[0].json.action).toBe('block')
    })
  })

  it('returns a FAILED result rather than throwing when the read is rejected', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async (calls) => {
      const res = await deploy(deployContext({ sections: [config()] }))
      // Without the prior config there would be nothing to roll back to, so the
      // deploy must not write.
      expect(writeCalls(calls)).toHaveLength(0)
      return res
    })

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to read ThreatInsight configuration/)
    expect(result.message).toMatch(/Insufficient permissions/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the token is rejected', async () => {
    const result = await withFetch([unauthorized()], async () =>
      deploy(deployContext({ sections: [config()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Invalid token provided/)
    expect(leaksToken(result)).toBe(false)
  })

  it('returns a FAILED result rather than throwing when the update is rejected', async () => {
    const result = await withFetch(
      [ok(LIVE_CONFIG), apiError('Api validation failed: excludeZones', 400, ['nzoCORP: no such zone'])],
      async () => deploy(deployContext({ sections: [config()] })),
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Failed to update ThreatInsight configuration/)
    expect(result.message).toMatch(/nzoCORP: no such zone/)
    // Nothing changed, so there is nothing to roll back.
    expect(result.rollbackData).toBeUndefined()
  })

  it('tolerates the platform failing to hand back the prior deploy', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async () => {
      const result = await deploy(deployContext({ sections: [config()], platformThrows: true }))
      expect(result.success).toBe(true)
    })
  })

  it('touches only the ThreatInsight singleton — no zone or policy is read or written', async () => {
    await withFetch([ok(LIVE_CONFIG), ok({})], async (calls) => {
      await deploy(deployContext({ sections: [config()] }))
      for (const call of calls) {
        expect(call.path).toBe('/threats/configuration')
      }
    })
  })
})
