import { create } from 'zustand';
import { User } from '@/types/user';

interface UserState {
    user: User | null;
    token: String | null;
    setUser: (user: User, token: string) => void;
    logout: () => void;
}

export const useUserStore = create <UserState>((set) => ({
    user: null,
    token: null,
    setUser: (user, token) => {
        localStorage.setItem('token', token);
        set({ user, token});

    },

    logout: () => {
        localStorage.removeItem('token');
        set({ user: null, token: null});
    },
}));