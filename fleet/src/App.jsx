import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useApp } from './store.jsx';
import Shell from './Shell.jsx';
import LoginPage from './pages/LoginPage.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TasksPage from './pages/TasksPage.jsx';
import LoadsPage from './pages/LoadsPage.jsx';
import UpdateBoard from './pages/UpdateBoard.jsx';
import DispatchBoard from './pages/DispatchBoard.jsx';
import DispatchMap from './pages/DispatchMap.jsx';
import EmailsPage from './pages/EmailsPage.jsx';
import RateSavings from './pages/RateSavings.jsx';
import Statistics from './pages/Statistics.jsx';
import UsersPage from './pages/UsersPage.jsx';
import BrokersPage from './pages/BrokersPage.jsx';
import DriversPage from './pages/DriversPage.jsx';
import EquipmentPage from './pages/EquipmentPage.jsx';
import FuelTolls from './pages/FuelTolls.jsx';
import CompaniesPage from './pages/CompaniesPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SupportPage from './pages/SupportPage.jsx';
import HelpPage from './pages/HelpPage.jsx';

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>{t.type === 'error' ? '⚠' : '✓'} {t.message}</div>
      ))}
    </div>
  );
}

function Protected({ children }) {
  const { me, loadingMe } = useApp();
  const loc = useLocation();
  if (loadingMe) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
        <Route path="/dashboard/tasks" element={<Protected><TasksPage /></Protected>} />
        <Route path="/dashboard/loads" element={<Protected><LoadsPage /></Protected>} />
        <Route path="/dashboard/update-board" element={<Protected><UpdateBoard /></Protected>} />
        <Route path="/dashboard/dispatch-board" element={<Protected><DispatchBoard /></Protected>} />
        <Route path="/dashboard/dispatch-map" element={<Protected><DispatchMap /></Protected>} />
        <Route path="/dashboard/emails" element={<Protected><EmailsPage /></Protected>} />
        <Route path="/dashboard/rate-savings" element={<Protected><RateSavings /></Protected>} />
        <Route path="/dashboard/statistics" element={<Protected><Statistics /></Protected>} />
        <Route path="/dashboard/users" element={<Protected><UsersPage /></Protected>} />
        <Route path="/dashboard/brokers" element={<Protected><BrokersPage /></Protected>} />
        <Route path="/dashboard/drivers" element={<Protected><DriversPage /></Protected>} />
        <Route path="/dashboard/equipments" element={<Protected><EquipmentPage /></Protected>} />
        <Route path="/dashboard/fuel-tolls" element={<Protected><FuelTolls /></Protected>} />
        <Route path="/dashboard/companies" element={<Protected><CompaniesPage /></Protected>} />
        <Route path="/dashboard/settings" element={<Protected><SettingsPage /></Protected>} />
        <Route path="/support" element={<Protected><SupportPage /></Protected>} />
        <Route path="/help" element={<Protected><HelpPage /></Protected>} />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
