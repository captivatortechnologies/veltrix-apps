import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'keycloak',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/keycloak/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/keycloak/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/keycloak/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/keycloak/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
