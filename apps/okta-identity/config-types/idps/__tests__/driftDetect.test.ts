// =============================================================================
// idps — driftDetect, driven against the fake Okta org.
//
// Drift on an IdP is somebody re-pointing federated sign-in: a swapped
// authorization endpoint, a changed account-link policy, a provider switched off.
// The subtlety that matters: the OAuth client secret is write-only, so comparing
// it would report drift forever — it has to be stripped from BOTH sides. And
// detection must never write.
// =============================================================================

import driftDetect from '../driftDetect'
import {
  apiError,
  driftContext,
  EMPTY_LIST,
  leaksToken,
  ok,
  withFetch,
  writeCalls,
  type CanvasItemInput,
} from '../../../lib/__tests__/fakeOkta'

const PROTOCOL_JSON =
  '{"type":"OIDC","endpoints":{"authorization":{"url":"https://partner.test/auth"}},"scopes":["openid"],"credentials":{"client":{"client_id":"cid-1","client_secret":"super-secret-value"}}}'
const POLICY_JSON = '{"provisioning":{"action":"AUTO"}}'

function idp(fields: Record<string, unknown> = {}): CanvasItemInput {
  return {
    name: 'Partner OIDC',
    fields: {
      type: 'OIDC',
      name: 'Partner OIDC',
      status: 'ACTIVE',
      protocolJson: PROTOCOL_JSON,
      policyJson: POLICY_JSON,
      ...fields,
    },
  }
}

const IN_SYNC = {
  id: 'idp-1',
  name: 'Partner OIDC',
  type: 'OIDC',
  status: 'ACTIVE',
  protocol: {
    type: 'OIDC',
    endpoints: { authorization: { url: 'https://partner.test/auth' } },
    scopes: ['openid'],
    // Okta returns the client id but NEVER the secret.
    credentials: { client: { client_id: 'cid-1' } },
  },
  policy: { provisioning: { action: 'AUTO' } },
}

describe('idps driftDetect', () => {
  it('reports no drift without touching the org when no credential is configured', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [idp()], credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift without touching the org when no org is registered', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(driftContext({ sections: [idp()], hostname: '' }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('reads the deployed config and reports a clean IdP as in sync', async () => {
    const result = await withFetch([ok([IN_SYNC])], async (calls) => {
      const res = await driftDetect(driftContext({ sections: [idp()] }))
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe('/idps')
      return res
    })

    expect(result.hasDrift).toBe(false)
    expect(result.diffs).toHaveLength(0)
  })

  it('never compares the write-only client secret, which Okta cannot return', async () => {
    const result = await withFetch([ok([IN_SYNC])], async () =>
      driftDetect(driftContext({ sections: [idp()] })),
    )

    // The authored protocol carries a secret, the live one cannot — that must
    // never read as permanent drift, and the secret must not reach the result.
    expect(result.hasDrift).toBe(false)
    expect(JSON.stringify(result).includes('super-secret-value')).toBe(false)
  })

  it('never writes anything — drift detection is read-only', async () => {
    await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async (calls) => {
      await driftDetect(driftContext({ sections: [idp()] }))
      expect(writeCalls(calls)).toHaveLength(0)
    })
  })

  it('flags a deleted IdP as critical drift', async () => {
    const result = await withFetch([EMPTY_LIST], async () =>
      driftDetect(driftContext({ sections: [idp()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Partner OIDC')
    expect(result.diffs[0].expected).toBe('exists')
    expect(result.diffs[0].actual).toBe('missing')
    expect(result.diffs[0].severity).toBe('critical')
  })

  it('flags a changed IdP kind as critical drift', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, type: 'SAML2' }])], async () =>
      driftDetect(driftContext({ sections: [idp()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner OIDC.type')
    expect(diff?.expected).toBe('OIDC')
    expect(diff?.actual).toBe('SAML2')
    expect(diff?.severity).toBe('critical')
  })

  it('flags a re-pointed authorization endpoint — the sign-in hijack shape', async () => {
    const result = await withFetch(
      [
        ok([
          {
            ...IN_SYNC,
            protocol: {
              ...IN_SYNC.protocol,
              endpoints: { authorization: { url: 'https://attacker.test/auth' } },
            },
          },
        ]),
      ],
      async () => driftDetect(driftContext({ sections: [idp()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner OIDC.protocol')
    expect(diff?.severity).toBe('critical')
    expect(String(diff?.actual)).toMatch(/attacker.test/)
  })

  it('lets Okta server defaults through — only the declared protocol keys are compared', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, protocol: { ...IN_SYNC.protocol, issuer: { url: 'https://partner.test' } } }])],
      async () => driftDetect(driftContext({ sections: [idp()] })),
    )

    expect(result.hasDrift).toBe(false)
  })

  it('flags a loosened provisioning policy as critical drift', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, policy: { provisioning: { action: 'DISABLED' } } }])],
      async () => driftDetect(driftContext({ sections: [idp()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner OIDC.policy')
    expect(diff?.severity).toBe('critical')
    expect(String(diff?.actual)).toMatch(/DISABLED/)
  })

  it('flags an IdP switched off out of band as a warning', async () => {
    const result = await withFetch([ok([{ ...IN_SYNC, status: 'INACTIVE' }])], async () =>
      driftDetect(driftContext({ sections: [idp()] })),
    )

    const diff = result.diffs.find((d) => d.field === 'Partner OIDC.status')
    expect(diff?.expected).toBe('ACTIVE')
    expect(diff?.actual).toBe('INACTIVE')
    expect(diff?.severity).toBe('warning')
  })

  it('does not fabricate status drift when the live object reports no status', async () => {
    const result = await withFetch(
      [ok([{ id: 'idp-1', name: 'Partner OIDC', type: 'OIDC', protocol: IN_SYNC.protocol, policy: IN_SYNC.policy }])],
      async () => driftDetect(driftContext({ sections: [idp()] })),
    )

    expect(result.diffs.filter((d) => d.field.endsWith('.status'))).toHaveLength(0)
  })

  it('reports an unreadable org as critical drift instead of throwing', async () => {
    const result = await withFetch([apiError('Insufficient permissions', 403)], async () =>
      driftDetect(driftContext({ sections: [idp()] })),
    )

    expect(result.hasDrift).toBe(true)
    expect(result.diffs[0].field).toBe('Partner OIDC')
    expect(result.diffs[0].severity).toBe('critical')
    expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
    expect(leaksToken(result)).toBe(false)
  })

  it('keeps checking the remaining IdPs after one read fails', async () => {
    const result = await withFetch(
      [apiError('Insufficient permissions', 403), ok([{ ...IN_SYNC, status: 'INACTIVE' }])],
      async () => driftDetect(driftContext({ sections: [idp({ name: 'Corp SAML' })], })),
    )

    expect(result.diffs).toHaveLength(1)
    expect(result.diffs[0].field).toBe('Corp SAML')
  })

  it('reports every declared IdP independently', async () => {
    const result = await withFetch(
      [ok([{ ...IN_SYNC, status: 'INACTIVE' }]), EMPTY_LIST],
      async () =>
        driftDetect(driftContext({ sections: [idp(), idp({ name: 'Corp SAML' })] })),
    )

    expect(result.diffs).toHaveLength(2)
    expect(result.diffs[0].field).toBe('Partner OIDC.status')
    expect(result.diffs[1].field).toBe('Corp SAML')
  })

  it('ignores a section with no name or type', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(
        driftContext({ sections: [{ name: 'Blank', fields: { type: '', name: '' } }] }),
      )
      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })
})
