'use client';

import { useEffect } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { useUserStore } from '@/store/userStore';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const token = localStorage.getItem('token');
    const userStr = localStorage.getItem('user');
    if (token && userStr) {
      try {
        const user = JSON.parse(userStr);
        useUserStore.getState().setUser(user, token);
      } catch {
        // corrupted data — clear it
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      }
    }
    useUserStore.getState().setHydrated();
  }, []);

  return (
    <>
      {children}
      <Toaster richColors position="top-right" />
    </>
  );
}
