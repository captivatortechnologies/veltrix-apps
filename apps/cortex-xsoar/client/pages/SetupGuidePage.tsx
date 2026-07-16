import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Lists', 'Incident Types', 'Jobs']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
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
              In Cortex XSOAR, go to <strong>Settings &gt; Integrations &gt; API Keys</strong> and
              create a new API key. This app uses it to manage:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the API key. It is sent in the <code>Authorization</code> header. For{' '}
              <strong>Cortex XSOAR 8</strong> / the Cortex platform, also copy the key's numeric{' '}
              <strong>API Key ID</strong> — it is sent as the <code>x-xdr-auth-id</code> header.
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
            <p>Store the API key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>API token</strong> → the Cortex XSOAR API key
              </li>
            </ul>
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
              Register an <strong>xsoar-server</strong> component whose hostname is your XSOAR server
              FQDN (e.g. <code>xsoar.acme.com</code>). For <strong>Cortex XSOAR 8</strong>, use the
              Cortex API gateway host (e.g.{' '}
              <code>api-acme.xdr.us.paloaltonetworks.com</code>) and attach the credential.
            </p>
            <p>
              For XSOAR 8, set the <strong>API Key ID</strong> (<code>auth_id</code>) app setting to
              the key's numeric id. The app then sends the <code>x-xdr-auth-id</code> header and routes
              requests through the <code>/xsoar</code> gateway path automatically.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
