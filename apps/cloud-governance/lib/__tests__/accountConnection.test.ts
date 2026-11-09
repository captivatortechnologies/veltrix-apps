import { readAccountConnection } from '../accountConnection'

const cred = (username: string, apiToken: string) => ({ id: 'c', name: 'n', username, password: '', apiToken, certificate: null }) as any

describe('readAccountConnection', () => {
  it('accepts a matching account id, role ARN and external id', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::123456789012:role/VeltrixGovernance', 'ext-id-12345'))
    expect(r.errors).toEqual([])
    expect(r.value).toEqual({ accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/VeltrixGovernance', externalId: 'ext-id-12345' })
  })

  it('rejects a role from a different account', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::999999999999:role/x', 'ext-id-12345'))
    expect(r.value).toBeNull()
    expect(r.errors.join(' ')).toMatch(/belongs to account 999999999999/)
  })

  it('requires an external id of at least 8 characters', () => {
    const r = readAccountConnection('123456789012', cred('arn:aws:iam::123456789012:role/x', 'short'))
    expect(r.value).toBeNull()
    expect(r.errors.join(' ')).toMatch(/External ID is required/)
  })

  it('rejects a non-numeric account id and a malformed ARN', () => {
    const r = readAccountConnection('acme', cred('role/x', 'ext-id-12345'))
    expect(r.errors).toHaveLength(2)
  })

  it('falls back to the password field for the external id', () => {
    const r = readAccountConnection('123456789012', { username: 'arn:aws:iam::123456789012:role/x', password: 'ext-id-12345' } as any)
    expect(r.value?.externalId).toBe('ext-id-12345')
  })
})

import { readSubscriptionConnection, targetKindOf } from '../accountConnection'

const SUB = '2f2a1b3c-0000-4000-8000-000000000001'

describe('readSubscriptionConnection', () => {
  it('accepts a subscription GUID with the connector recorded as the username', () => {
    const r = readSubscriptionConnection(SUB, cred('connector-client-id', ''))
    expect(r.errors).toEqual([])
    expect(r.value).toEqual({ subscriptionId: SUB, connectorClientId: 'connector-client-id' })
  })

  it('rejects a non-GUID subscription id and a connection without the connector', () => {
    expect(readSubscriptionConnection('123456789012', cred('connector-client-id', '')).errors.join(' ')).toMatch(/subscription GUID/)
    expect(readSubscriptionConnection(SUB, cred('', '')).errors.join(' ')).toMatch(/Connect Azure subscription/)
  })
})

describe('targetKindOf', () => {
  it('trusts the component type first and falls back to the endpoint shape', () => {
    expect(targetKindOf(['azure-subscription'], '123456789012')).toBe('azure-subscription')
    expect(targetKindOf(['aws-account'], SUB)).toBe('aws-account')
    expect(targetKindOf(null, SUB)).toBe('azure-subscription')
    expect(targetKindOf(undefined, '123456789012')).toBe('aws-account')
  })
})
