'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useUserStore } from '@/store/userStore';
import { LayoutGrid, Settings, LogOut } from 'lucide-react';

function userIdToColor(id: string): string {
  const palette = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useUserStore((state) => state.user);
  const logout = useUserStore((state) => state.logout);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleLogout = () => {
    localStorage.removeItem('cursorColor');
    logout();
    router.push('/login');
  };

  const defaultColor = user ? userIdToColor(user.id) : '#3b82f6';
  const [avatarColor, setAvatarColor] = useState(defaultColor);

  useEffect(() => {
    const stored = localStorage.getItem('cursorColor');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvatarColor(stored ?? defaultColor);
  }, [pathname, defaultColor]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Avatar fixed to bottom-left */}
      <div className="fixed bottom-5 left-5 z-20" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="rounded-full focus:outline-none shadow-md"
        >
          {user?.avatarUrl ? (
            <Image
              src={user.avatarUrl}
              alt={user.name}
              width={36}
              height={36}
              unoptimized
              className="w-9 h-9 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-bold"
              style={{ backgroundColor: avatarColor }}
            >
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
          )}
        </button>

        {menuOpen && (
          <div className="absolute bottom-12 left-0 w-44 bg-white border border-gray-100 rounded-lg shadow-lg overflow-hidden">
            <Link
              href="/boards"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <LayoutGrid className="h-4 w-4" />
              My Boards
            </Link>
            <Link
              href="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <Settings className="h-4 w-4" />
              Settings
            </Link>
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        )}
      </div>

      {/* Main content */}
      <main className="min-h-screen">
        {children}
      </main>
    </div>
  );
}
