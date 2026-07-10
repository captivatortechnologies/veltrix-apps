import React from 'react'
import { Badge, Button, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const SCOPES = ['Host groups', 'Prevention policies', 'IOC Management']
const REGIONS = ['us-1', 'us-2', 'eu-1', 'us-gov-1', 'us-gov-2']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge /
 * Button the built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-client',
      label: '1. API client',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Falcon console (requires the <em>Falcon Administrator</em> role), go to{' '}
              <strong>Support and resources &gt; Resources and tools &gt; API clients and keys</strong>{' '}
              and create an API client with these scopes (Read &amp; Write):
            </p>
            <div>
              {SCOPES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>Copy the client secret immediately — it is shown only once.</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                window.open('https://falcon.crowdstrike.com/api-clients-and-keys', '_blank', 'noopener')
              }
            >
              Open Falcon API clients
            </Button>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '2. Tenant',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Add a component of type <code>falcon-tenant</code>. Set its hostname to your Falcon
              cloud region — or the API hostname (e.g. <code>api.us-2.crowdstrike.com</code>).
              Commercial clouds are auto-discovered if unsure; GovCloud tenants must set the region
              explicitly.
            </p>
            <div>
              {REGIONS.map((region) => (
                <Badge key={region} variant="secondary" size="sm">
                  {region}
                </Badge>
              ))}
            </div>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '3. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a credential attached to the component's tool: put the API{' '}
              <strong>client ID</strong> in the <em>username</em> field and the{' '}
              <strong>client secret</strong> in the <em>API token</em> field.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'deploy',
      label: '4. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Create a configuration in the Configuration Canvas (host groups, prevention policies,
              or custom IOCs) and run it through the pipeline. Validation, health checks, drift
              detection, and rollback are handled per configuration type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return (
    <div>
      <h2>CrowdStrike Falcon — Setup Guide</h2>
      <Tabs tabs={tabs} />
    </div>
  )
}
