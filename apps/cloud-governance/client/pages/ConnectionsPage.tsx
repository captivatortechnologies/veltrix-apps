import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * One connection is one governed account. AWS: the account id as the
 * endpoint, the IAM role the platform runner assumes as the username and the
 * provider-generated External ID as the secret (manual add, or "Connect AWS
 * account"). Azure: a subscription connected through "Connect Azure
 * subscription" (Entra admin consent; brokered, no secret), registered as an
 * azure-subscription component by the manifest's onboarding descriptor. The
 * app itself never uses these values; the runner resolves a scoped session
 * through the platform credential broker.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Veltrix Cloud Governance"
      appId="cloud-governance"
      componentType="aws-account"
      usernameLabel="Role ARN"
      tokenLabel="External ID"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="arn:aws:iam::123456789012:role/VeltrixGovernance"
      endpointPlaceholder="123456789012"
      endpointHelper="The 12-digit AWS account id. The role must trust the Veltrix runner principal and require the External ID shown when the connection is created. Azure subscriptions are added with Connect Azure subscription, not here."
    />
  )
}
