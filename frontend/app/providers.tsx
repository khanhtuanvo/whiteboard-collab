'use client';

import { useEffect } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { useUserStore } from '@/store/userStore';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      try {
        const user = JSON.parse(userStr);
        useUserStore.getState().setUser(user);
      } catch {
        // corrupted data — clear it
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
