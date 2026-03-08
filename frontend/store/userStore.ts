import { create } from 'zustand';
import { User } from '@/types/user';

interface UserState {
    user: User | null;
    token: string | null;
    _hasHydrated: boolean;
    setUser: (user: User, token: string) => void;
    logout: () => void;
    setHydrated: () => void;
}

export const useUserStore = create<UserState>((set) => ({
    user: null,
    token: null,
    _hasHydrated: false,
    setUser: (user, token) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
        }
        set({ user, token });
    },
    logout: () => {
        if (typeof window !== 'undefined') {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
        }
        set({ user: null, token: null });
    },
    setHydrated: () => set({ _hasHydrated: true }),
}));
