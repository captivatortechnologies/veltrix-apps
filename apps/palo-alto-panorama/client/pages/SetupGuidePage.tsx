import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Tags', 'Address objects', 'Service objects', 'Address groups', 'Service groups', 'Security rules']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'apikey',
      label: '1. API key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Generate a PAN-OS API key for a dedicated admin account whose role is scoped to what this
              app manages:
            </p>
            <pre>
              <code>curl -k -X POST 'https://&lt;panorama&gt;/api/?type=keygen' -d 'user=&lt;u&gt;&amp;password=&lt;p&gt;'</code>
            </pre>
            <p>The response contains a long-lived <code>&lt;key&gt;</code> — that key is the credential.</p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
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
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the generated PAN-OS API key
              </li>
            </ul>
            <p>
              The app sends it as <code>X-PAN-KEY: &lt;key&gt;</code> on every REST call to{' '}
              <code>https://&lt;panorama&gt;/restapi/&lt;version&gt;</code>. No username is required.
            </p>
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
              Register a <strong>panorama</strong> component whose hostname is your Panorama management
              host (e.g. <code>panorama.example.com</code>) and attach the credential. HTTPS is always
              used; Panorama's management certificate (often self-signed) must be trusted by the platform
              host.
            </p>
            <ul>
              <li>
                <strong>device_group</strong> — the target device group, or <code>shared</code> (default)
              </li>
              <li>
                <strong>rest_api_version</strong> — <code>v11.0</code> by default (PAN-OS 11.1 also serves
                v11.0)
              </li>
              <li>
                <strong>auto_commit</strong> — when on, deploy commits the candidate to Panorama and polls
                the job
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
