import deploy, { type QuotaRollbackEntry } from '../deploy'
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

const KV_READS = { name: 'kv-reads', path: 'secret/', rate: 1000, interval: '1s', blockInterval: '0s' }

function canvasWith(quotas: Array<Record<string, unknown>>) {
  return makeCanvas(
    quotas.map((fields, i) => ({ name: `Quota ${i + 1}`, fields })),
    'rate-limit-quotas',
  )
}

function entries(result: { rollbackData?: unknown }): QuotaRollbackEntry[] {
  return (result.rollbackData as { previousState?: QuotaRollbackEntry[] })?.previousState ?? []
}

function createdNames(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdNames?: string[] })?.createdNames ?? []
}

function artifacts(result: { artifacts?: unknown }) {
  return result.artifacts as { deployedQuotas: string[]; createdQuotas: string[] }
}

describe('Vault Rate Limit Quotas Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([KV_READS]), { token: null }))

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
      const result = await deploy(makeDeployContext(canvasWith([KV_READS]), { hostname: '' }))

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
      const result = await deploy(makeDeployContext(canvasWith([KV_READS])))

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

  it('creates a quota that does not exist yet with the exact authored limits', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([KV_READS])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [read, write] = fetchStub.calls
      expect(read.method).toBe('GET')
      expect(read.url).toBe(`${VAULT_BASE}/sys/quotas/rate-limit/kv-reads`)
      expect(write.method).toBe('POST')
      expect(write.url).toBe(`${VAULT_BASE}/sys/quotas/rate-limit/kv-reads`)
      expect(JSON.parse(write.body)).toEqual({
        rate: 1000,
        path: 'secret/',
        interval: '1s',
        block_interval: '0s',
      })

      expect(entries(result)).toHaveLength(1)
      expect(entries(result)[0].existed).toBe(false)
      expect(entries(result)[0].path).toBe('secret/')
      expect(entries(result)[0].prior).toBeUndefined()
      expect(createdNames(result)).toEqual(['kv-reads'])
    } finally {
      fetchStub.restore()
    }
  })

  it('sends the rate as a number even when the canvas supplies it as a string', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(makeDeployContext(canvasWith([{ ...KV_READS, rate: '2500' }])))

      const body = JSON.parse(fetchStub.calls[1].body)
      // A rate that arrives as a string would make Vault reject or mis-parse the limit.
      expect(typeof body.rate).toBe('number')
      expect(body.rate).toBe(2500)
    } finally {
      fetchStub.restore()
    }
  })

  it('sends the role only when it is authored', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([{ name: 'login-limit', path: 'auth/approle/login', rate: 60, role: 'ci' }]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({
        rate: 60,
        path: 'auth/approle/login',
        role: 'ci',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a quota that already exists and captures its prior limits verbatim', async () => {
    const fetchStub = recordFetch([
      {
        status: 200,
        body: {
          data: {
            type: 'rate-limit',
            name: 'kv-reads',
            path: 'secret/data/old',
            rate: 100,
            interval: 60,
            block_interval: 30,
          },
        },
      },
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([KV_READS])))

      expect(result.success).toBe(true)
      const entry = entries(result)[0]
      expect(entry.existed).toBe(true)
      // Verbatim numerics — a rollback that rounds these restores the wrong limit.
      expect(entry.prior?.rate).toBe(100)
      expect(entry.prior?.path).toBe('secret/data/old')
      expect(entry.prior?.interval).toBe(60)
      expect(entry.prior?.block_interval).toBe(30)
      expect(entry.prior?.role).toBeUndefined()
      expect(createdNames(result)).toEqual([])
      expect(JSON.parse(fetchStub.calls[1].body).rate).toBe(1000)
    } finally {
      fetchStub.restore()
    }
  })

  it('always sends the empty path of a global limiter and warns about it', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ name: 'cluster-wide', path: '', rate: 5000 }])),
      )

      expect(result.success).toBe(true)
      // "" must be sent, not omitted — it is the deliberate cluster-wide choice.
      expect(JSON.parse(fetchStub.calls[1].body)).toEqual({ rate: 5000, path: '' })
      expect(result.message).toMatch(/GLOBAL rate limiter/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when Vault rejects the write', async () => {
    const fetchStub = recordFetch([NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([KV_READS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/permission denied/)
      expect(result.message).toMatch(/0 of 1/)
      expect(artifacts(result).deployedQuotas).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the prior-state read fails', async () => {
    const fetchStub = recordFetch([{ status: 500, body: { errors: ['internal error'] } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([KV_READS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read rate limit quota/)
      expect(result.message).toMatch(/internal error/)
      expect(artifacts(result).deployedQuotas).toEqual([])
      expect(entries(result)).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later quota fails', async () => {
    const fetchStub = recordFetch([NOT_FOUND, NO_CONTENT, NOT_FOUND, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: 'first', path: 'secret/', rate: 10 },
            { name: 'second', path: 'secret/', rate: 20 },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/1 of 2/)
      // The first quota really was written — rollback must know about it.
      expect(artifacts(result).deployedQuotas).toEqual(['first'])
      expect(entries(result)).toHaveLength(2)
      expect(createdNames(result)).toEqual(['first', 'second'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips quotas with no name or a non-positive rate before touching Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { name: '', path: 'secret/', rate: 100 },
            { name: 'zero-rate', path: 'secret/', rate: 0 },
            { name: 'no-rate', path: 'secret/' },
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
