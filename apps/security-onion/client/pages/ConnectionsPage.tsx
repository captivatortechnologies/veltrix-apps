import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Security Onion — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is the Security Onion Console (SOC) manager over HTTPS (443);
 * `componentType="manager"` so saving a connection also registers a deploy-target
 * component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Security Onion"
      appId="security-onion"
      componentType="manager"
      usernameLabel="SOC username"
      passwordUsernamePlaceholder="the Security Onion Console username"
      endpointPlaceholder="e.g. manager.example.com"
      endpointHelper="The Security Onion Console (SOC) manager host — its HTTPS address (443). Salt/CLI config operations additionally require managed connectivity (ZTNA) to this manager."
    />
  )
}
