import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'sonarqube',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/sonarqube/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/sonarqube/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/sonarqube/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/sonarqube/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
