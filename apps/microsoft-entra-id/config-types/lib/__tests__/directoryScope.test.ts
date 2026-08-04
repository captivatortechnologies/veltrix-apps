import { directoryScopeOptions, resolveDirectoryScope, buildDirectoryScopeNameMaps } from '../directoryScope'
import { buildGraphClient } from '../../../lib/graph'

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
  source: 'directoryScope',
  component: null,
  settings: { tenant_id: 'tenant-1' } as Record<string, unknown>,
  credential: { id: 'c1', name: 'Prod tenant', username: 'client-id', password: 'secret', apiToken: null, certificate: null },
}

describe('directoryScopeOptions', () => {
  it('offers the tenant sentinel, then AU-scoped, then application-scoped options', async () => {
    mockGraphFetch((u) => {
      if (u.includes('administrativeUnits')) return { status: 200, body: { value: [{ id: 'au-1', displayName: 'West Region' }] } }
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: 'app-obj-1', appId: 'app-client-1', displayName: 'Contoso Portal' }] } }
      return { status: 404, body: {} }
    })
    const opts = await directoryScopeOptions(baseCtx)
    expect(opts).toEqual([
      { value: '/', label: 'Tenant-wide (/)', description: 'Applies across the entire directory' },
      { value: '/administrativeUnits/au-1', label: 'West Region (administrative unit)', description: 'au-1' },
      { value: '/app-obj-1', label: 'Contoso Portal (application)', description: 'app-client-1' },
    ])
  })

  it('the application option value is the OBJECT id, never the appId', async () => {
    mockGraphFetch((u) => {
      if (u.includes('administrativeUnits')) return { status: 200, body: { value: [] } }
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: 'obj-1', appId: 'app-1', displayName: 'X' }] } }
      return { status: 404, body: {} }
    })
    const opts = await directoryScopeOptions(baseCtx)
    const appOpt = opts.find((o) => o.label.includes('(application)'))
    expect(appOpt?.value).toBe('/obj-1')
  })

  it('filters the tenant sentinel out when the query does not match it', async () => {
    mockGraphFetch(() => ({ status: 200, body: { value: [] } }))
    const opts = await directoryScopeOptions({ ...baseCtx, query: 'west' })
    expect(opts.some((o) => o.value === '/')).toBe(false)
  })
})

describe('resolveDirectoryScope', () => {
  const maps = {
    administrativeUnit: new Map([['west region', 'au-1']]),
    application: new Map([['contoso portal', 'app-obj-1']]),
  }

  it('treats an empty value as tenant-wide "/"', () => {
    expect(resolveDirectoryScope('', maps)).toEqual({ scope: '/' })
  })

  it('passes the bare tenant sentinel through', () => {
    expect(resolveDirectoryScope('/', maps)).toEqual({ scope: '/' })
  })

  it('passes an already Graph-shaped AU scope through unchanged', () => {
    expect(resolveDirectoryScope('/administrativeUnits/au-1', maps)).toEqual({ scope: '/administrativeUnits/au-1' })
  })

  it('passes an already Graph-shaped application scope through unchanged', () => {
    expect(resolveDirectoryScope('/app-obj-1', maps)).toEqual({ scope: '/app-obj-1' })
  })

  it('resolves a hand-typed administrative-unit name', () => {
    expect(resolveDirectoryScope('West Region', maps)).toEqual({ scope: '/administrativeUnits/au-1' })
  })

  it('resolves a hand-typed application name when it is not an administrative unit', () => {
    expect(resolveDirectoryScope('Contoso Portal', maps)).toEqual({ scope: '/app-obj-1' })
  })

  it('reports an unresolved name as missing', () => {
    expect(resolveDirectoryScope('Ghost Scope', maps)).toEqual({ scope: '', missing: 'Ghost Scope' })
  })
})

describe('buildDirectoryScopeNameMaps', () => {
  it('builds both maps from the live directory in one call', async () => {
    mockGraphFetch((u) => {
      if (u.includes('administrativeUnits')) return { status: 200, body: { value: [{ id: 'au-1', displayName: 'West Region' }] } }
      if (u.includes('/applications')) return { status: 200, body: { value: [{ id: 'app-obj-1', displayName: 'Contoso Portal' }] } }
      return { status: 404, body: {} }
    })
    const client = buildGraphClient(
      { tenantId: 'tenant-1', clientId: 'client-id', clientSecret: 'secret' },
      { timeoutMs: 5000, tenantId: 'tenant-1' }
    )
    const maps = await buildDirectoryScopeNameMaps(client)
    expect(maps.administrativeUnit.get('west region')).toBe('au-1')
    expect(maps.application.get('contoso portal')).toBe('app-obj-1')
  })
})
