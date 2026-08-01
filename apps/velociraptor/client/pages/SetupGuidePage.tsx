import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Custom VQL artifacts']

/**
 * Step-by-step connection guide for Velociraptor, rendered with the platform
 * design-system components themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'credential',
      label: '1. api-client config',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Velociraptor's programmatic API is <strong>gRPC over mutual TLS</strong>. Generate an api-client config
              on the Velociraptor server:
            </p>
            <pre>
              <code>velociraptor --config server.config.yaml config api_client --name veltrix veltrix.api.yaml</code>
            </pre>
            <p>
              This emits a YAML bundle containing <code>ca_certificate</code>, <code>client_cert</code>,{' '}
              <code>client_private_key</code> and <code>api_connection_string</code>. Make sure the client name is
              added to the server's API allow-list. This app manages:
            </p>
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
      key: 'connection',
      label: '2. Connection',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On <strong>Connections</strong>, add a connection pointing at the Velociraptor API server address (the{' '}
              <code>api_connection_string</code>, e.g. <code>velociraptor.example.com:8001</code>) and paste the whole
              api-client YAML into the <strong>API client config</strong> field. Use <strong>Test</strong> to verify
              the server is reachable and the client cert authenticates (runs <code>SELECT * FROM info()</code>). Saving
              the connection also registers the Velociraptor server as a deploy target.
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
              Open the <strong>Configuration Canvas</strong>, pick the Velociraptor <strong>Custom Artifacts</strong>
              configuration type, author your artifacts (name, type and the artifact YAML/VQL), and deploy through the
              pipeline. Deploy upserts each artifact with <code>artifact_set()</code>; drift detection and rollback are
              handled per type.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
