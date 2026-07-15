import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Detection rules', 'Exception lists', 'ILM policies', 'Role mappings', 'Spaces']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-key',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Kibana, go to <strong>Stack Management &gt; API keys</strong> and create a key. The
              key inherits privileges, so scope it to what this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the <strong>Base64</strong> (encoded <code>id:api_key</code>) value — that is what
              the app sends as <code>Authorization: ApiKey …</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Base64 <code>id:api_key</code> value
              </li>
            </ul>
            <p>A username + password may be used instead for Basic auth.</p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & settings',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register an <strong>elastic-deployment</strong> component whose hostname is the{' '}
              <strong>Kibana</strong> base URL (e.g.{' '}
              <code>https://my-deployment.kb.us-central1.gcp.cloud.es.io:9243</code>) and attach the
              credential.
            </p>
            <p>
              Elastic Security config spans two endpoints: detection rules, exception lists and
              spaces go through Kibana (the component hostname), while ILM policies and role mappings
              go through <strong>Elasticsearch</strong> — set the <strong>Elasticsearch URL</strong>{' '}
              app setting for those. Optionally set a Kibana <strong>space</strong> to scope
              space-aware config.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
