import { create } from 'zustand';
import { User } from '@/types/user';
import api from '@/lib/api';

interface UserState {
    user: User | null;
    _hasHydrated: boolean;
    setUser: (user: User) => void;
    logout: () => Promise<void>;
    setHydrated: () => void;
}

export const useUserStore = create<UserState>((set) => ({
    user: null,
    _hasHydrated: false,
    setUser: (user) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('user', JSON.stringify(user));
        }
        set({ user });
    },
    logout: async () => {
        try {
            await api.post('/api/auth/logout');
        } catch {
            // ignore — clear local state regardless
        }
        if (typeof window !== 'undefined') {
            localStorage.removeItem('user');
        }
        set({ user: null });
    },
    setHydrated: () => set({ _hasHydrated: true }),
}));
