import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * pfSense — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * The pfSense REST API package supports two auth methods this app uses, chosen
 * automatically by which secret is stored (no separate "auth method" setting):
 * an API key (the token field) OR a local webConfigurator administrator
 * username + password (used to mint a short-lived JWT on every deploy).
 * Saving a connection also registers the `pfsense` deploy target, so Deploy is
 * enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="pfSense"
      appId="pfsense"
      componentType="pfsense"
      usernameLabel="webConfigurator username"
      usernameOptionalForToken={true}
      tokenLabel="API key"
      tokenUsernamePlaceholder="not required for an API key"
      passwordUsernamePlaceholder="a local (non-LDAP/RADIUS) webConfigurator admin username"
      endpointPlaceholder="e.g. fw.example.com or fw.example.com:8443"
      endpointHelper="The pfSense firewall's hostname and HTTPS port (default 443). Install the pfSense REST API package first — see the Setup Guide."
    />
  )
}
