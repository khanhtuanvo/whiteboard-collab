import { create } from 'zustand';
import { Element } from '@/types/element';

export interface ActiveUser {
  socketId: string;
  userId: string;
  userName: string;
  userColor: string;
  // null until the user has emitted at least one cursor:move event
  cursor: { x: number; y: number } | null;
  lastSeen: number;
}

interface BoardState {
  elements: Element[];
  activeUsers: ActiveUser[];
  setElements: (elements: Element[]) => void;
  addElement: (element: Element) => void;
  updateElement: (id: string, properties: Element['properties']) => void;
  removeElement: (id: string) => void;
  clearElements: () => void;
  // Upsert a full element from a remote WS event — does NOT trigger canvas re-emission
  applyRemoteChange: (element: Element) => void;
  setActiveUsers: (users: ActiveUser[]) => void;
  updateUserCursor: (userId: string, x: number, y: number) => void;
  addActiveUser: (user: Omit<ActiveUser, 'cursor' | 'lastSeen'>) => void;
  removeActiveUser: (userId: string) => void;
  reset: () => void;
}

export const useBoardStore = create<BoardState>((set) => ({
  elements: [],
  activeUsers: [],

  setElements: (elements) => set({ elements }),

  addElement: (element) =>
    set((state) => ({ elements: [...state.elements, element] })),

  // Replaces the full properties object (backend always returns merged props)
  updateElement: (id, properties) =>
    set((state) => ({
      elements: state.elements.map((el) =>
        el.id === id ? { ...el, properties } : el
      ),
    })),

  removeElement: (id) =>
    set((state) => ({ elements: state.elements.filter((el) => el.id !== id) })),

  clearElements: () => set({ elements: [] }),

  // Upsert: add if new, replace if already known (handles backend confirmation after optimistic update)
  applyRemoteChange: (element) =>
    set((state) => {
      const exists = state.elements.some((el) => el.id === element.id);
      if (exists) {
        return { elements: state.elements.map((el) => el.id === element.id ? element : el) };
      }
      return { elements: [...state.elements, element] };
    }),

  // Reset cursor to null so users don't appear at (0,0) before they move.
  // Cursors update at ~30fps via cursor:update events, so they appear almost immediately.
  setActiveUsers: (users) => set({
    activeUsers: users.map(u => ({ ...u, cursor: null })),
  }),

  updateUserCursor: (userId, x, y) =>
    set((state) => ({
      activeUsers: state.activeUsers.map((u) =>
        u.userId === userId ? { ...u, cursor: { x, y }, lastSeen: Date.now() } : u
      ),
    })),

  addActiveUser: (user) =>
    set((state) => {
      if (state.activeUsers.find((u) => u.userId === user.userId)) return state;
      return {
        activeUsers: [
          ...state.activeUsers,
          { ...user, cursor: null, lastSeen: Date.now() },
        ],
      };
    }),

  removeActiveUser: (userId) =>
    set((state) => ({
      activeUsers: state.activeUsers.filter((u) => u.userId !== userId),
    })),

  reset: () => set({ elements: [], activeUsers: [] }),
}));
