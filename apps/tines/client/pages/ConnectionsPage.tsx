import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Tines — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * One connection represents a Tines TENANT (API key). Unlike PagerDuty, the
 * API base is per-tenant, so the endpoint is a real host to resolve, not just
 * a label — the app builds `https://<endpoint>/api/v1/...` from it.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Tines"
      appId="tines"
      componentType="tines-tenant"
      tokenLabel="API token"
      tokenUsernamePlaceholder="Optional label for this key"
      endpointPlaceholder="e.g. acme.tines.com"
      endpointHelper="Your Tines tenant domain — used as the API base (https://<endpoint>/api/v1). The app authenticates with the API key as a Bearer token."
    />
  )
}
