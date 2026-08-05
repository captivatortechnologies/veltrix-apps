import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Barracuda WAF-as-a-Service — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Barracuda authenticates with a Barracuda Cloud
 * Control admin email + password (exchanged for a short-lived session token
 * via POST /api_login/); the connection's paired component's hostname is the
 * WAF-as-a-Service Application name this connection reaches.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Barracuda WAF-as-a-Service"
      appId="barracuda-waf"
      usernameLabel="Admin email"
      passwordUsernamePlaceholder="e.g. admin@yourdomain.com"
      endpointPlaceholder="e.g. my-app.example.com"
      endpointHelper="The exact Application name shown under Applications in the WAF-as-a-Service console — also set as the paired component's hostname."
    />
  )
}
