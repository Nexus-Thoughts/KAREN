import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { router } from '@/routes/router';

const App: React.FC = () => (
  <ToastProvider>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </ToastProvider>
);

export default App;
