import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Threat indicators (IOCs)']

/**
 * Step-by-step connection guide for Cortex XDR, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. API Key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Cortex XDR console, go to <strong>Settings → Configurations → API Keys</strong> and create
              a new key with the <strong>Standard</strong> security level, scoped to a role that can manage what
              this app deploys:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Note the <strong>API Key ID</strong> (the integer next to the key) and copy the{' '}
              <strong>API Key</strong> value. Store them as a Veltrix credential on the{' '}
              <strong>Connections</strong> page — API Key ID in the username field, API Key in the token field.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection whose endpoint is your tenant API FQDN — use{' '}
              <strong>Copy URL</strong> next to the key in the Cortex XDR console (e.g.{' '}
              <code>api-yourtenant.xdr.us.paloaltonetworks.com</code>) — and attach the API Key. Use{' '}
              <strong>Test</strong> to verify the tenant is reachable and the key authenticates (POST{' '}
              <code>/public_api/v1/endpoints/get_endpoint_groups/</code>). Saving the connection also registers
              the Cortex XDR tenant as a deploy target.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'author',
      label: '3. Author & deploy',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Open the <strong>Configuration Canvas</strong>, pick the Cortex XDR{' '}
              <strong>Threat Indicators (IOCs)</strong> configuration type, author your indicators (value, type,
              severity, reputation, reliability, comment), and deploy through the pipeline. Drift detection and
              rollback are handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
