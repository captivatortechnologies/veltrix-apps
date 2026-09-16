import deploy, { type TransitKeyRollbackEntry } from '../deploy'
import type { LiveTransitKey } from '../validate'
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

const AES = 'aes256-gcm96'

function liveKey(data: LiveTransitKey) {
  return { status: 200, body: { data } }
}

function canvasWith(keys: Array<Record<string, unknown>>) {
  return makeCanvas(
    keys.map((fields, i) => ({ name: `Key ${i + 1}`, fields })),
    'transit-keys',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): TransitKeyRollbackEntry[] {
  return (result.rollbackData as { previousState?: TransitKeyRollbackEntry[] })?.previousState ?? []
}

function createdKeys(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdKeys?: string[] })?.createdKeys ?? []
}

describe('Vault Transit Keys Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }]), {
          token: null,
        }),
      )

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
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }]), {
          hostname: '',
        }),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }])),
      )

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

  it('creates a key that does not exist and applies its tunables in a second call', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            {
              mount: 'transit',
              name: 'app',
              type: AES,
              derived: true,
              convergentEncryption: true,
              deletionAllowed: true,
              minDecryptionVersion: 2,
              autoRotatePeriod: '24h',
            },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(3)

      const [read, create, config] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/transit/keys/app`)
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${VAULT_BASE}/transit/keys/app`)
      // The create body carries only the immutable cryptographic shape.
      expect(JSON.parse(create.body)).toEqual({
        type: AES,
        convergent_encryption: true,
        derived: true,
        auto_rotate_period: '24h',
      })

      expect(config.method).toBe('POST')
      expect(config.url).toBe(`${VAULT_BASE}/transit/keys/app/config`)
      expect(JSON.parse(config.body)).toEqual({
        deletion_allowed: true,
        min_decryption_version: 2,
        auto_rotate_period: '24h',
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      expect(entries[0].mount).toBe('transit')
      expect(entries[0].name).toBe('app')
      expect(entries[0].priorConfig).toBeUndefined()
      expect(createdKeys(result)).toEqual(['transit/app'])
    } finally {
      fetchStub.restore()
    }
  })

  it('configures an existing key without ever re-creating it, capturing its prior tunables', async () => {
    const fetchStub = recordFetch([
      liveKey({
        type: AES,
        deletion_allowed: false,
        min_decryption_version: 1,
        min_encryption_version: 0,
        auto_rotate_period: 0,
      }),
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { mount: 'transit', name: 'app', type: AES, deletionAllowed: true, minDecryptionVersion: 3 },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/transit/keys/app/config`)
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        deletion_allowed: true,
        min_decryption_version: 3,
      })

      // A POST to the bare key path would mint new key material.
      const creates = fetchStub.calls.filter(
        (c) => c.method === 'POST' && c.url === `${VAULT_BASE}/transit/keys/app`,
      )
      expect(creates).toHaveLength(0)

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].priorConfig).toEqual({
        deletion_allowed: false,
        min_decryption_version: 1,
        min_encryption_version: 0,
        auto_rotate_period: 0,
      })
      expect(createdKeys(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses an immutable type change and never deletes or recreates the key', async () => {
    const fetchStub = recordFetch([liveKey({ type: 'rsa-4096' })])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/immutable/)
      expect(result.message).toMatch(/permanently losing the ability to decrypt/)
      expect(fetchStub.calls).toHaveLength(1)
      expect(fetchStub.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)
      expect(createdKeys(result)).toEqual([])
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('never sends a write-once flag back to false and warns that it cannot be reverted', async () => {
    const fetchStub = recordFetch([
      liveKey({ type: AES, exportable: true, allow_plaintext_backup: true }),
      NO_CONTENT,
    ])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { mount: 'transit', name: 'app', type: AES, exportable: false, allowPlaintextBackup: false },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      const body = JSON.parse(fetchStub.calls[1].body)
      expect(body.exportable).toBeUndefined()
      expect(body.allow_plaintext_backup).toBeUndefined()
      expect(result.message).toMatch(/WARNING/)
      expect(result.message).toMatch(/exportable=true and cannot be reverted to false/)
      expect(result.message).toMatch(/allow_plaintext_backup=true and cannot be reverted to false/)
    } finally {
      fetchStub.restore()
    }
  })

  it('escalates a write-once flag only when the live key does not already have it', async () => {
    const fetchStub = recordFetch([liveKey({ type: AES, exportable: false }), NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([{ mount: 'transit', name: 'app', type: AES, exportable: true }]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body).exportable).toBe(true)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the create', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to create transit key/)
      expect(result.message).toMatch(/permission denied/)
      // Nothing was created, so rollback must not be told to destroy anything.
      expect(createdKeys(result)).toEqual([])
      expect(rollbackEntries(result)).toHaveLength(0)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('records a created key for rollback even when its follow-up config fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/failed to apply its configuration/)
      // The key material exists now — rollback has to know it may remove it.
      expect(createdKeys(result)).toEqual(['transit/app'])
      expect(rollbackEntries(result)[0].existed).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the key read errors', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ mount: 'transit', name: 'app', type: AES }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read transit key/)
      expect((result.artifacts as { deployedKeys: string[] }).deployedKeys).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later key fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { mount: 'transit', name: 'one', type: AES },
            { mount: 'transit', name: 'two', type: AES },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2/)
      expect((result.artifacts as { deployedKeys: string[] }).deployedKeys).toEqual([
        'transit/one (created)',
      ])
      expect(createdKeys(result)).toEqual(['transit/one'])
      expect(rollbackEntries(result)).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections missing a mount, a name or a type without touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { mount: '', name: 'app', type: AES },
            { mount: 'transit', name: '', type: AES },
            { mount: 'transit', name: 'app' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
      expect(rollbackEntries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
