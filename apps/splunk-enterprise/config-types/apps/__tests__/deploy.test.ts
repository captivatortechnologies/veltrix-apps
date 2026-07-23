import deploy from '../deploy'
import { __setSplunkTransport } from '../../../lib/splunkApi'
import type { CanvasItemSnapshot, DeployContext } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Apps deploy — the ONE way configuration reaches Splunk.
//
// Splunk ships configuration AS AN APP, so an authored .conf file is packaged
// into the app's default/ and installed as a real .spl. These tests pin that
// contract, and in particular that nothing is written over the REST configs API
// (/servicesNS/nobody/<app>/configs/conf-<file>) — that endpoint lands config in
// the target app's user-owned local/, which shadows default/ and survives every
// upgrade, and it can carry nothing but .conf stanzas.
// =============================================================================

interface RecordedCall {
  url: string
  method: string
  contentType: string
  body: string
}

let calls: RecordedCall[] = []

/**
 * Stub splunkd: every GET 404s (the app does not exist yet, so getEntityContent
 * yields null) and every write succeeds.
 */
function stubSplunk(): void {
  calls = []
  __setSplunkTransport(async (url, init) => {
    const method = init.method ?? 'GET'
    const headers = init.headers ?? {}
    calls.push({
      url,
      method,
      contentType: headers['Content-Type'] ?? '',
      body: typeof init.body === 'string' ? init.body : '',
    })
    if (method === 'GET') return { ok: false, status: 404, text: async () => 'not found' }
    return { ok: true, status: 200, text: async () => '{}' }
  })
}

function makeCtx(item: CanvasItemSnapshot, overrides: Partial<DeployContext> = {}): DeployContext {
  const sections = [item]
  return {
    appId: 'splunk-enterprise',
    customerId: 'cust-1',
    configTypeId: 'apps',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 7,
      name: 'Apps',
      toolType: 'splunk-enterprise',
      entityType: 'apps',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'splunk.test', port: '8089', type: ['search-head'], toolId: 'splunk' },
    credential: { id: 'cred-1', name: 'svc', username: 'admin', password: 'pw', apiToken: null, certificate: null },
    connectivity: {
      id: 'conn-1',
      status: 'CONNECTED',
      sshCommand: null,
      httpsUrl: 'https://splunk.test:8089',
      tailscaleDeviceIP: null,
    },
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
    ...overrides,
  }
}

/** One app carrying everything the retired Config Files type could — and more. */
const inlineApp: CanvasItemSnapshot = {
  name: 'item-1',
  fields: {
    name: 'my_ta',
    label: 'My Custom TA',
    version: '1.0.0',
    description: 'Ticket OPS-42 — syslog parsing for the app tier',
    source: 'inline',
    visibility: 'app',
    state: 'enabled',
    upgradePolicy: 'manual',
    appFiles: [
      { path: 'default/props.conf', content: '[example]\nSHOULD_LINEMERGE = false' },
      { path: 'default/inputs.conf', content: '[monitor:///var/log/app.log]\nindex = main' },
      { path: 'bin/collect.py', content: 'print("collect")' },
      { path: 'lookups/hosts.csv', content: 'host,role\na,web' },
      { path: 'README/inputs.conf.spec', content: '[my_input://<name>]\ninterval = <integer>' },
    ],
  },
}

const splunkbaseApp: CanvasItemSnapshot = {
  name: 'item-1',
  fields: {
    name: 'Splunk_TA_nix',
    source: 'splunkbase',
    sourceRef: '833',
    version: '9.1.0',
    visibility: 'global',
    state: 'disabled',
    upgradePolicy: 'auto',
  },
}

const urlApp: CanvasItemSnapshot = {
  name: 'item-2',
  fields: {
    name: 'my_url_ta',
    source: 'url',
    sourceRef: 'https://example.com/my_url_ta-1.0.0.tgz',
    version: '1.0.0',
    visibility: 'app',
    state: 'enabled',
    upgradePolicy: 'auto',
  },
}

function packagedFiles(result: { artifacts?: Record<string, unknown> }): string[] {
  const packages = (result.artifacts?.installedPackages ?? []) as Array<{ files?: string[] }>
  return packages.flatMap((p) => p.files ?? [])
}

describe('Splunk Apps deploy — inline (.conf authored in the app)', () => {
  it('builds a .spl and uploads it to /services/apps/local', async () => {
    stubSplunk()
    const result = await deploy(makeCtx(inlineApp))

    expect(result.success).toBe(true)
    const upload = calls.find((c) => c.method === 'POST' && c.url === 'https://splunk.test:8089/services/apps/local')
    expect(upload?.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(result.message).toContain('Packaged my_ta as my_ta-1.0.0.tar.gz')
  })

  it('ships the authored .conf files in the app default/, never local/', async () => {
    stubSplunk()
    const files = packagedFiles(await deploy(makeCtx(inlineApp)))

    expect(files).toContain('my_ta/default/props.conf')
    expect(files).toContain('my_ta/default/inputs.conf')
    // app.conf and metadata/default.meta are generated from the item's identity.
    expect(files).toContain('my_ta/default/app.conf')
    expect(files).toContain('my_ta/metadata/default.meta')
    expect(files.filter((f) => f.startsWith('my_ta/local/'))).toHaveLength(0)
  })

  it('carries what a REST config write never could — bin/, lookups/, a README spec', async () => {
    stubSplunk()
    const files = packagedFiles(await deploy(makeCtx(inlineApp)))

    expect(files).toContain('my_ta/bin/collect.py')
    expect(files).toContain('my_ta/lookups/hosts.csv')
    expect(files).toContain('my_ta/README/inputs.conf.spec')
  })

  it('writes no stanza over the REST configs API', async () => {
    stubSplunk()
    await deploy(makeCtx(inlineApp))

    expect(calls.filter((c) => c.url.includes('/configs/conf-'))).toHaveLength(0)
    expect(calls.filter((c) => c.url.includes('/servicesNS/'))).toHaveLength(0)
  })

  it('applies sharing and enabled state after the install', async () => {
    stubSplunk()
    await deploy(makeCtx(inlineApp))

    const acl = calls.find((c) => c.url.endsWith('/services/apps/local/my_ta/acl'))
    expect(acl?.body).toContain('sharing=app')
    expect(acl?.body).toContain('owner=nobody')
    expect(calls.some((c) => c.url.endsWith('/services/apps/local/my_ta/enable'))).toBe(true)
  })
})

describe('Splunk Apps deploy — packaged sources', () => {
  it('installs a Splunkbase app by numeric id and applies global sharing + disabled state', async () => {
    stubSplunk()
    const result = await deploy(makeCtx(splunkbaseApp))

    expect(result.success).toBe(true)
    const install = calls.find((c) => c.url.endsWith('/services/apps/appinstall'))
    expect(install?.body).toContain('name=833')
    const acl = calls.find((c) => c.url.endsWith('/services/apps/local/Splunk_TA_nix/acl'))
    expect(acl?.body).toContain('sharing=global')
    expect(calls.some((c) => c.url.endsWith('/services/apps/local/Splunk_TA_nix/disable'))).toBe(true)
    expect(packagedFiles(result)).toHaveLength(0)
  })

  it('installs a URL package via the modern apps/local endpoint, not deprecated appinstall', async () => {
    stubSplunk()
    const result = await deploy(makeCtx(urlApp))

    expect(result.success).toBe(true)
    // apps/appinstall is deprecated (6.6.0): a URL source must not use it.
    expect(calls.some((c) => c.url.endsWith('/services/apps/appinstall'))).toBe(false)
    const install = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/services/apps/local') && (c.body ?? '').includes('filename=1'),
    )
    expect(install?.body).toContain('filename=1')
    expect(install?.body).toContain('explicit_appname=my_url_ta')
    expect(install?.body).toContain('update=0')
  })

  it('fails cleanly without a credential', async () => {
    stubSplunk()
    const result = await deploy(makeCtx(inlineApp, { credential: null }))

    expect(result.success).toBe(false)
    expect(result.message).toContain('Missing credential')
    expect(calls).toHaveLength(0)
  })
})
