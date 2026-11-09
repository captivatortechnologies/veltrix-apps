import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const ACCOUNT_ID_PATTERN = /^\d{12}$/
export const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ROLE_ARN_PATTERN = /^arn:aws(?:-us-gov|-cn)?:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/

export interface AccountConnection {
  accountId: string
  roleArn: string
  externalId: string
}

export interface AccountConnectionCheck {
  value: AccountConnection | null
  errors: string[]
}

/** Shape-check an AWS account connection without contacting AWS. */
export function readAccountConnection(endpoint: string | null | undefined, credential: CredentialRef | null | undefined): AccountConnectionCheck {
  const errors: string[] = []
  const accountId = (endpoint ?? '').trim()
  const roleArn = (credential?.username ?? '').trim()
  const externalId = (credential?.apiToken ?? credential?.password ?? '').trim()

  if (!ACCOUNT_ID_PATTERN.test(accountId)) errors.push('Account id must be the 12-digit AWS account number.')
  const arnAccount = ROLE_ARN_PATTERN.exec(roleArn)?.[1]
  if (!arnAccount) errors.push('Role ARN must look like arn:aws:iam::<account>:role/<name>.')
  else if (ACCOUNT_ID_PATTERN.test(accountId) && arnAccount !== accountId) errors.push(`Role ARN belongs to account ${arnAccount}, not ${accountId}.`)
  if (externalId.length < 8) errors.push('External ID is required (at least 8 characters) so the role cannot be assumed by a confused deputy.')

  return { value: errors.length ? null : { accountId, roleArn, externalId }, errors }
}

export interface SubscriptionConnection {
  subscriptionId: string
  /** The platform connector app's client id the brokered connection names. */
  connectorClientId: string
}

export interface SubscriptionConnectionCheck {
  value: SubscriptionConnection | null
  errors: string[]
}

/**
 * Shape-check an Azure subscription connection. It is brokered (no secret
 * here): the platform minted it through Entra admin consent, and the runner
 * obtains a token per run with the platform connector app.
 */
export function readSubscriptionConnection(endpoint: string | null | undefined, credential: CredentialRef | null | undefined): SubscriptionConnectionCheck {
  const errors: string[] = []
  const subscriptionId = (endpoint ?? '').trim()
  const connectorClientId = (credential?.username ?? '').trim()
  if (!SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) errors.push('Subscription id must be the subscription GUID.')
  if (!connectorClientId) errors.push('Connect the subscription with "Connect Azure subscription" so the platform connector is recorded on it.')
  return { value: errors.length ? null : { subscriptionId, connectorClientId }, errors }
}

export type TargetKind = 'aws-account' | 'azure-subscription'

/** Which kind of target a component is, from its type list or, failing that, the endpoint's shape. */
export function targetKindOf(types: readonly string[] | null | undefined, endpoint: string | null | undefined): TargetKind {
  if (types?.includes('azure-subscription')) return 'azure-subscription'
  if (types?.includes('aws-account')) return 'aws-account'
  return SUBSCRIPTION_ID_PATTERN.test((endpoint ?? '').trim()) ? 'azure-subscription' : 'aws-account'
}
