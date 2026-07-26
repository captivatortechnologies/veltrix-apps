import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cloudflare — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. One connection represents a Cloudflare ACCOUNT (API
 * token + Account ID). Zone-scoped config types (DNS, WAF, rate-limiting,
 * redirect, transform, managed rulesets, zone settings) pick their target
 * domain in the form, from the account's live zone list — so a single account
 * connection covers every domain. The endpoint is a zone in that account: it
 * registers the deploy-target component and is the fallback zone when a config
 * selects none.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cloudflare"
      appId="cloudflare"
      componentType="cloudflare-zone"
      tokenLabel="API token"
      usernameLabel="Account ID"
      tokenUsernamePlaceholder="e.g. f9fa6ce8b0f2b91f8635eedde085b094 — scopes the account's zone list + account-scoped types"
      endpointPlaceholder="e.g. example.com"
      endpointHelper="Any zone (apex) domain in this Cloudflare account. The account is set by Account ID; zone-scoped configs choose their target domain in the form."
    />
  )
}
