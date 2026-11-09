import type { CredentialRef } from '@veltrixsecops/app-sdk'

export const ACCOUNT_ID_PATTERN = /^\d{12}$/
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
