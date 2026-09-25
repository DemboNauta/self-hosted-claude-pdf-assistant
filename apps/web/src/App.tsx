import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { useApplyTheme } from './lib/theme';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export function App() {
  useApplyTheme();
  return <RouterProvider router={router} />;
}
