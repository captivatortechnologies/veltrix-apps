import deploy, { normalizeRoleRollbackEntry, type RoleRollbackEntry } from '../deploy'
import type { CanvasItemSnapshot, DeployContext } from '@veltrixsecops/app-sdk'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

function captureFetch(handler: (call: Captured) => { status: number; body: unknown }): {
  calls: Captured[]
  restore: () => void
} {
  const original = globalThis.fetch
  const calls: Captured[] = []

  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const call: Captured = {
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const { status, body } = handler(call)
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }
  }) as unknown as typeof fetch

  return { calls, restore: () => { globalThis.fetch = original } }
}

function makeCtx(items: CanvasItemSnapshot[]): DeployContext {
  return {
    appId: 'splunk-cloud',
    customerId: 'cust-1',
    configTypeId: 'roles',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Roles Canvas',
      toolType: 'splunk-cloud',
      entityType: 'roles',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: { getLatestDeployment: async () => null, listComponents: async () => [] },
    component: { id: 'comp-1', hostname: 'acme', port: '8089', type: ['splunk-cloud-stack'], toolId: 'splunk-cloud' },
    credential: {
      id: 'cred-1',
      name: 'Stack Credential',
      username: '',
      password: '',
      apiToken: 'STACK_JWT',
      certificate: null,
    },
    connectivity: null,
    connectivityProvider: null,
    previousConfig: null,
    strategy: 'DIRECT',
  }
}

describe('Splunk Cloud Roles deploy — REST transport (default, unchanged)', () => {
  it('creates a new role via REST when transport is omitted', async () => {
    const { calls, restore } = captureFetch((call) => {
      if (call.method === 'GET') return { status: 404, body: { messages: [{ text: 'Not Found' }] } }
      return { status: 200, body: { entry: [{ content: {} }] } }
    })

    try {
      const result = await deploy(makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'] } }]))
      expect(result.success).toBe(true)

      const posts = calls.filter((c) => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toBe('https://acme.splunkcloud.com:8089/services/authorization/roles')

      const rollback = (result.rollbackData as { previousState: RoleRollbackEntry[] }).previousState
      expect(rollback).toEqual([{ name: 'soc-analyst', transport: 'rest', targets: [{ existed: false }] }])
    } finally {
      restore()
    }
  })
})

describe('Splunk Cloud Roles deploy — ACS transport (opt-in)', () => {
  it('creates a role via ACS at the default (untargeted) search head when no targets are declared', async () => {
    const { calls, restore } = captureFetch((call) => {
      if (call.method === 'GET') return { status: 404, body: { code: '404-role-not-found', message: 'not found' } }
      return { status: 200, body: { name: 'soc-analyst', capabilities: ['search'] } }
    })

    try {
      const result = await deploy(
        makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], transport: 'acs' } }]),
      )
      expect(result.success).toBe(true)

      const posts = calls.filter((c) => c.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toBe('https://admin.splunk.com/acme/adminconfig/v2/roles')
      expect(posts[0].headers['Federated-Search-Manage-Ack']).toBe('Y')
      expect(JSON.parse(posts[0].body ?? '{}')).toEqual({ name: 'soc-analyst', capabilities: ['search'] })

      const rollback = (result.rollbackData as { previousState: RoleRollbackEntry[] }).previousState
      expect(rollback).toEqual([
        { name: 'soc-analyst', transport: 'acs', targets: [{ target: undefined, existed: false }] },
      ])
    } finally {
      restore()
    }
  })

  it('applies one write PER declared search-head target', async () => {
    const { calls, restore } = captureFetch((call) => {
      if (call.method === 'GET') return { status: 404, body: { code: '404-role-not-found', message: 'not found' } }
      return { status: 200, body: { name: 'soc-analyst' } }
    })

    try {
      const result = await deploy(
        makeCtx([
          {
            name: 'sec1',
            fields: {
              name: 'soc-analyst',
              capabilities: ['search'],
              transport: 'acs',
              searchHeadTargets: ['sh-i-aaa', 'sh-i-bbb'],
            },
          },
        ]),
      )
      expect(result.success).toBe(true)

      const posts = calls.filter((c) => c.method === 'POST')
      expect(posts.map((p) => p.url).sort()).toEqual([
        'https://admin.splunk.com/sh-i-aaa.acme/adminconfig/v2/roles',
        'https://admin.splunk.com/sh-i-bbb.acme/adminconfig/v2/roles',
      ])

      const rollback = (result.rollbackData as { previousState: RoleRollbackEntry[] }).previousState
      expect(rollback[0].targets).toEqual([
        { target: 'sh-i-aaa', existed: false },
        { target: 'sh-i-bbb', existed: false },
      ])
    } finally {
      restore()
    }
  })

  it('PATCHes an existing ACS role and records its prior state (from the nested `imported` object)', async () => {
    const { calls, restore } = captureFetch((call) => {
      if (call.method === 'GET') {
        return {
          status: 200,
          body: {
            name: 'soc-analyst',
            capabilities: ['search'],
            imported: { roles: ['user'] },
            srchTimeWin: -1,
          },
        }
      }
      return { status: 200, body: { name: 'soc-analyst' } }
    })

    try {
      const result = await deploy(
        makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search', 'schedule_search'], transport: 'acs' } }]),
      )
      expect(result.success).toBe(true)

      const patches = calls.filter((c) => c.method === 'PATCH')
      expect(patches).toHaveLength(1)
      expect(patches[0].headers['Federated-Search-Manage-Ack']).toBe('Y')

      const rollback = (result.rollbackData as { previousState: RoleRollbackEntry[] }).previousState
      expect(rollback[0].targets[0]).toEqual({
        target: undefined,
        existed: true,
        prior: { capabilities: ['search'], importedRoles: ['user'], srchTimeWin: -1 },
      })
    } finally {
      restore()
    }
  })

  it('fails clearly when no ACS token is available', async () => {
    const ctx = makeCtx([{ name: 'sec1', fields: { name: 'soc-analyst', capabilities: ['search'], transport: 'acs' } }])
    ctx.credential = { ...ctx.credential!, apiToken: null, password: '' }

    const result = await deploy(ctx)
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/ACS token/i)
  })
})

describe('Splunk Cloud Roles deploy — mixed transports in one canvas', () => {
  it('deploys a REST role and an ACS role in the same pass', async () => {
    const { calls, restore } = captureFetch((call) => {
      if (call.method === 'GET') {
        if (call.url.includes('admin.splunk.com')) {
          return { status: 404, body: { code: '404-role-not-found', message: 'not found' } }
        }
        return { status: 404, body: { messages: [{ text: 'Not Found' }] } }
      }
      return { status: 200, body: call.url.includes('admin.splunk.com') ? { name: 'ok' } : { entry: [{ content: {} }] } }
    })

    try {
      const result = await deploy(
        makeCtx([
          { name: 'sec1', fields: { name: 'legacy-role', capabilities: ['search'] } },
          { name: 'sec2', fields: { name: 'modern-role', capabilities: ['search'], transport: 'acs' } },
        ]),
      )
      expect(result.success).toBe(true)

      const rollback = (result.rollbackData as { previousState: RoleRollbackEntry[] }).previousState
      expect(rollback.map((e) => e.transport)).toEqual(['rest', 'acs'])
      expect(calls.some((c) => c.url.includes(':8089'))).toBe(true)
      expect(calls.some((c) => c.url.includes('admin.splunk.com'))).toBe(true)
    } finally {
      restore()
    }
  })
})

describe('normalizeRoleRollbackEntry — shape tolerance', () => {
  it('normalizes a pre-v1.12.0 flat REST entry (created role)', () => {
    const normalized = normalizeRoleRollbackEntry({ name: 'old-role', existed: false })
    expect(normalized).toEqual({
      name: 'old-role',
      transport: 'rest',
      targets: [{ target: undefined, existed: false, prior: undefined }],
    })
  })

  it('normalizes a pre-v1.12.0 flat REST entry (updated role, with prior)', () => {
    const normalized = normalizeRoleRollbackEntry({ name: 'old-role', existed: true, prior: { capabilities: ['search'] } })
    expect(normalized).toEqual({
      name: 'old-role',
      transport: 'rest',
      targets: [{ target: undefined, existed: true, prior: { capabilities: ['search'] } }],
    })
  })

  it('passes a current-shape entry through unchanged', () => {
    const current: RoleRollbackEntry = {
      name: 'new-role',
      transport: 'acs',
      targets: [{ target: 'sh-i-aaa', existed: true, prior: { srchTimeWin: -1 } }],
    }
    expect(normalizeRoleRollbackEntry(current)).toEqual(current)
  })

  it('returns null for an unrecognized shape', () => {
    expect(normalizeRoleRollbackEntry({ nope: true })).toBeNull()
    expect(normalizeRoleRollbackEntry(null)).toBeNull()
    expect(normalizeRoleRollbackEntry('a string')).toBeNull()
  })
})
