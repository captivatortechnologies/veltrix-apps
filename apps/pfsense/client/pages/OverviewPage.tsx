import React, { useEffect, useState } from 'react'
import { authFetch } from '@veltrixsecops/app-sdk/client'
import { Badge, Card, CardBody, EmptyState, Spinner } from '@veltrixsecops/app-sdk/ui'

interface ConfigTypeSummary {
  id: string
  name: string
  description?: string
  componentTypes: string[]
}

interface AppMeta {
  appId: string
  name: string
  version: string
  configurationTypes: ConfigTypeSummary[]
}

/**
 * Shows what this app manages on a pfSense firewall, using the platform
 * design-system components from @veltrixsecops/app-sdk/ui — so the page
 * matches the platform look and picks up the app's brand color. Authoring
 * happens in the platform's Configuration Canvas.
 */
export default function OverviewPage() {
  const [meta, setMeta] = useState<AppMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    authFetch('/api/apps/pfsense/meta')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(setMeta)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner label="Loading pfSense app details…" />
  if (error) {
    return <EmptyState title="Failed to load app details" description={error} />
  }
  if (!meta) return <EmptyState title="No app details available" />

  return (
    <Card>
      <CardBody>
        <p>
          Manages pfSense firewall configuration as code. pfSense CE ships no REST API of its own — this
          app talks to the third-party <strong>pfSense REST API package</strong> (pfSense-pkg-RESTAPI),
          which must be installed on the firewall first (see the Setup Guide). Create a configuration in
          the Configuration Canvas and deploy it through the pipeline — validate, deploy, health check,
          drift detection and rollback are all handled per configuration type. Pending changes are applied
          in one batch per deploy via each subsystem's own apply endpoint: firewall/NAT config types share{' '}
          <code>/firewall/apply</code>, virtual IPs use <code>/firewall/virtual_ip/apply</code>, gateways
          and static routes use <code>/routing/apply</code>, and DNS Resolver overrides use{' '}
          <code>/services/dns_resolver/apply</code> — local users and groups apply immediately and use no
          separate endpoint at all. See the README's Coverage section for the full list.
        </p>

        <h3>Configuration Types</h3>
        {meta.configurationTypes.map((ct) => (
          <Card key={ct.id} variant="bordered" padding="md">
            <CardBody>
              <strong>{ct.name}</strong>
              {ct.description ? <p>{ct.description}</p> : null}
              <div>
                {ct.componentTypes.map((type) => (
                  <Badge key={type} variant="secondary" size="sm">
                    {type}
                  </Badge>
                ))}
              </div>
            </CardBody>
          </Card>
        ))}
      </CardBody>
    </Card>
  )
}
