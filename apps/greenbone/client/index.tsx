import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))

export default {
  id: 'greenbone',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage, BYOLPage },
  sidebarItems: [
    { path: '/apps/greenbone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/greenbone/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/greenbone/connections', label: 'Connections', icon: 'link' },
    { path: '/apps/greenbone/byol', label: 'Infrastructure', icon: 'server' },
  ],
}
