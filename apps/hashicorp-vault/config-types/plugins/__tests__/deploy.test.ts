import deploy, { type PluginRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const SHA_A = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const SHA_B = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'

const PLUGIN = { type: 'secret', name: 'acme-kv', sha256: SHA_A, command: 'acme-kv' }

function canvasWith(plugins: Array<Record<string, unknown>>) {
  return makeCanvas(
    plugins.map((fields, i) => ({ name: `Plugin ${i + 1}`, fields })),
    'plugins',
  )
}

function entries(result: { rollbackData?: unknown }): PluginRollbackEntry[] {
  return (result.rollbackData as { previousState?: PluginRollbackEntry[] })?.previousState ?? []
}

function createdPlugins(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdPlugins?: string[] })?.createdPlugins ?? []
}

function artifacts(result: { artifacts?: unknown }) {
  return result.artifacts as { deployedPlugins: string[]; createdPlugins: string[] }
}

describe('Vault Plugin Catalog Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN]), { token: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('registers an absent plugin with the exact sha, command and empty args', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme-kv`)
      // args is always sent so clearing it on the canvas converges the entry.
      expect(JSON.parse(write.body)).toEqual({ sha256: SHA_A, command: 'acme-kv', args: [] })

      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(false)
      expect(entries(result)[0].type).toBe('secret')
      expect(entries(result)[0].name).toBe('acme-kv')
      expect(createdPlugins(result)).toEqual(['secret/acme-kv'])
      expect(artifacts(result).deployedPlugins).toEqual(['secret/acme-kv (registered)'])
    } finally {
      fetchStub.restore()
    }
  })

  it('registers the version and parsed args when they are authored', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            { ...PLUGIN, version: 'v1.2.0', argsJson: '["--log-level","debug"]' },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        sha256: SHA_A,
        command: 'acme-kv',
        args: ['--log-level', 'debug'],
        version: 'v1.2.0',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('sends env only when it is authored and non-empty', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            { ...PLUGIN, name: 'with-env', envJson: '["API_HOST=example.com"]' },
            { ...PLUGIN, name: 'empty-env', envJson: '[]' },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body).env).toEqual(['API_HOST=example.com'])
      expect(Object.keys(JSON.parse(fetchStub.calls[3].body)).includes('env')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('normalizes the sha256 to lower-case hex before registering', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ ...PLUGIN, sha256: SHA_A.toUpperCase() }])))

      // A digest that does not match Vault's byte-for-byte comparison fails the
      // plugin load at mount time, not at registration.
      expect(JSON.parse(fetchStub.calls[1].body).sha256).toBe(SHA_A)
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a plugin that is already registered and captures its prior metadata', async () => {
    const fetchStub = recordFetch([
      {
        status: 200,
        body: {
          data: {
            name: 'acme-kv',
            sha256: SHA_B,
            command: 'acme-kv-old',
            args: ['--legacy'],
            version: 'v1.0.0',
            builtin: false,
          },
        },
      },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(true)
      const entry = entries(result)[0]
      expect(entry.existed).toBe(true)
      expect(entry.prior?.sha256).toBe(SHA_B)
      expect(entry.prior?.command).toBe('acme-kv-old')
      expect(entry.prior?.args).toEqual(['--legacy'])
      expect(entry.prior?.version).toBe('v1.0.0')
      expect(createdPlugins(result)).toEqual([])
      expect(artifacts(result).deployedPlugins).toEqual(['secret/acme-kv (updated)'])
      expect(JSON.parse(fetchStub.calls[1].body).sha256).toBe(SHA_A)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses to write over a Vault built-in of the same name', async () => {
    const fetchStub = recordFetch([
      { status: 200, body: { data: { name: 'acme-kv', builtin: true, version: 'v1.15.0+builtin' } } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/BUILT-IN/)
      // The refusal happens before any write.
      expect(fetchStub.calls).toHaveLength(1)
      expect(entries(result)).toHaveLength(0)
      expect(createdPlugins(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the registration', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to register plugin/)
      expect(result.message).toMatch(/permission denied/)
      expect(artifacts(result).deployedPlugins).toEqual([])
      // A registration that never happened must not be claimed as rollbackable.
      expect(entries(result)).toHaveLength(0)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the captured prior metadata when an update write is rejected', async () => {
    const fetchStub = recordFetch([
      { status: 200, body: { data: { name: 'acme-kv', sha256: SHA_B, command: 'acme-kv-old' } } },
      FORBIDDEN,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to update plugin/)
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].prior?.sha256).toBe(SHA_B)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the catalog read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([PLUGIN])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read plugin/)
      expect(artifacts(result).deployedPlugins).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later plugin fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { ...PLUGIN, name: 'first' },
            { ...PLUGIN, name: 'second' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 2/)
      // The first plugin really was registered — rollback must deregister it.
      expect(artifacts(result).deployedPlugins).toEqual(['secret/first (registered)'])
      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].name).toBe('first')
      expect(createdPlugins(result)).toEqual(['secret/first'])
    } finally {
      fetchStub.restore()
    }
  })

  it('keys a plugin on its type as well as its name', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { ...PLUGIN, type: 'secret', name: 'acme' },
            { ...PLUGIN, type: 'auth', name: 'acme' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/secret/acme`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/plugins/catalog/auth/acme`)
      expect(createdPlugins(result)).toEqual(['secret/acme', 'auth/acme'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips plugins missing a sha256 or a command before touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { type: 'secret', name: 'no-sha', command: 'acme-kv' },
            { type: 'secret', name: 'no-command', sha256: SHA_A },
            { type: '', name: 'no-type', sha256: SHA_A, command: 'acme-kv' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
