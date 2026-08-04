import { directoryPrincipalOptions, resolvePrincipal, resolvePrincipals, buildPrincipalNameMaps } from '../principals'
import { buildGraphClient } from '../../../lib/graph'

// --- Fetch mock ----------------------------------------------------------------
// Same harness as config-types/lib/__tests__/entraOptions.test.ts.

function mockGraphFetch(responder: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url)
    if (u.includes('login.microsoftonline.com')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ access_token: 'test-token', expires_in: 3600 }),
      }
    }
    const { status, body } = responder(u)
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }
  }) as unknown as typeof fetch
}

const baseCtx = {
  appId: 'microsoft-entra-id',
  customerId: 'cust-1',
  configTypeId: 'directory-role-assignments',
  source: 'directoryPrincipals',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('directoryPrincipalOptions', () => {
  it('merges users + groups + servicePrincipals, labelling each option by kind', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/users')) return { status: 200, body: { value: [{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] } }
      if (u.includes('/groups')) return { status: 200, body: { value: [{ id: 'g-1', displayName: 'Engineering' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: 'sp-1', appId: 'app-1', displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const opts = await directoryPrincipalOptions(baseCtx)
    expect(opts).toEqual([
      { value: 'u-1', label: 'Ada Lovelace (ada@contoso.com) (user)', description: 'ada@contoso.com' },
      { value: 'g-1', label: 'Engineering (group)', description: 'g-1' },
      { value: 'sp-1', label: 'Deploy Bot (service principal)', description: 'app-1' },
    ])
  })

  it('returns an empty list when all three collections are empty', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await directoryPrincipalOptions(baseCtx)
    expect(opts).toEqual([])
  })
})

describe('resolvePrincipal / resolvePrincipals — priority order user -> group -> service principal', () => {
  const maps = {
    user: new Map([['ada lovelace', 'u-1']]),
    group: new Map([['engineering', 'g-1']]),
    servicePrincipal: new Map([['deploy bot', 'sp-1']]),
  }

  it('passes a picker-stored GUID through unchanged', () => {
    const GUID = '11111111-1111-1111-1111-111111111111'
    expect(resolvePrincipal(GUID, maps)).toEqual({ id: GUID, missing: false })
  })

  it('resolves a hand-typed name against each kind in turn', () => {
    expect(resolvePrincipal('Ada Lovelace', maps)).toEqual({ id: 'u-1', missing: false })
    expect(resolvePrincipal('Engineering', maps)).toEqual({ id: 'g-1', missing: false })
    expect(resolvePrincipal('Deploy Bot', maps)).toEqual({ id: 'sp-1', missing: false })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolvePrincipal('Ghost', maps)).toEqual({ id: '', missing: true })
  })

  it('resolves a batch, collecting missing names separately', () => {
    const r = resolvePrincipals(['Ada Lovelace', 'Ghost'], maps)
    expect(r.ids).toEqual(['u-1'])
    expect(r.missing).toEqual(['Ghost'])
  })
})

describe('buildPrincipalNameMaps', () => {
  it('builds all three maps from the live directory in one call', async () => {
    mockGraphFetch((u) => {
      if (u.includes('/users')) return { status: 200, body: { value: [{ id: 'u-1', displayName: 'Ada Lovelace', userPrincipalName: 'ada@contoso.com' }] } }
      if (u.includes('/groups')) return { status: 200, body: { value: [{ id: 'g-1', displayName: 'Engineering' }] } }
      if (u.includes('/servicePrincipals')) return { status: 200, body: { value: [{ id: 'sp-1', displayName: 'Deploy Bot' }] } }
      return { status: 404, body: {} }
    })
    const client = buildGraphClient(
      { tenantId: 'tenant-1', clientId: 'client-id', clientSecret: 'secret' },
      { timeoutMs: 5000, tenantId: 'tenant-1' }
    )
    const maps = await buildPrincipalNameMaps(client)
    expect(maps.user.get('ada@contoso.com')).toBe('u-1')
    expect(maps.group.get('engineering')).toBe('g-1')
    expect(maps.servicePrincipal.get('deploy bot')).toBe('sp-1')
  })
})
