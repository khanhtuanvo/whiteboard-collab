'use client';

import { useState, useEffect } from 'react';
import { useUserStore } from '@/store/userStore';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const CURSOR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6',
];

const CURSOR_COLOR_KEY = 'cursorColor';

function userIdToColor(id: string): string {
  const palette = CURSOR_COLORS;
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = id.charCodeAt(i) + ((hash << 5) - hash);
  }
  return palette[Math.abs(hash) % palette.length];
}

export default function SettingsPage() {
  const router = useRouter();
  const user = useUserStore((state) => state.user);
  const setUser = useUserStore((state) => state.setUser);
  const _hasHydrated = useUserStore((state) => state._hasHydrated);

  const [name, setName] = useState(user?.name ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? '');
  const [saving, setSaving] = useState(false);

  const storedColor = typeof window !== 'undefined' ? localStorage.getItem(CURSOR_COLOR_KEY) : null;
  const defaultColor = user ? userIdToColor(user.id) : '#3b82f6';
  const [cursorColor, setCursorColor] = useState(storedColor ?? defaultColor);

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!user) {
      router.push('/login');
    }
  }, [user, _hasHydrated, router]);

  // 2. Safely initialize LocalStorage/Color logic after mount
  useEffect(() => {
    if (user) {
      const storedColor = localStorage.getItem(CURSOR_COLOR_KEY);
      setCursorColor(storedColor ?? userIdToColor(user.id));
    }
  }, [user]);

  // If no user, show nothing (useEffect handles the push)
  if (!_hasHydrated || !user) {
    return null;
  }

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body: Record<string, string> = { name: name.trim() };
      if (avatarUrl.trim()) body.avatarUrl = avatarUrl.trim();
      const res = await api.patch('/api/auth/profile', body);
      setUser(res.data);
      toast.success('Profile updated');
    } catch {
      toast.error('Failed to update profile');
    } finally {
      setSaving(false);
    }
  };

  const handleCursorColorChange = (color: string) => {
    setCursorColor(color);
    if (typeof window !== 'undefined') {
      localStorage.setItem(CURSOR_COLOR_KEY, color);
    }
    toast.success('Cursor color saved');
  };

  const avatarInitial = (user.name ?? 'U').charAt(0).toUpperCase();

  return (
    <div className="p-8 max-w-xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-8">Settings</h1>

      {/* Profile section */}
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-5">Profile</h2>

        {/* Avatar preview */}
        <div className="flex items-center gap-4 mb-6">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={user.name}
              className="w-16 h-16 rounded-full object-cover border"
            />
          ) : (
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-bold"
              style={{ backgroundColor: cursorColor }}
            >
              {avatarInitial}
            </div>
          )}
          <div>
            <p className="font-medium text-gray-900">{user.name}</p>
            <p className="text-sm text-gray-400">{user.email}</p>
          </div>
        </div>

        <form onSubmit={handleSaveProfile} className="space-y-4">
          <div>
            <Label htmlFor="name">Display Name</Label>
            <Input
              id="name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Your name"
              className="mt-1"
              required
            />
          </div>
          <div>
            <Label htmlFor="avatarUrl">Avatar URL</Label>
            <Input
              id="avatarUrl"
              type="url"
              value={avatarUrl}
              onChange={e => setAvatarUrl(e.target.value)}
              placeholder="https://example.com/avatar.png"
              className="mt-1"
            />
            <p className="text-xs text-gray-400 mt-1">Paste a URL to an image to use as your avatar.</p>
          </div>
          <Button type="submit" disabled={saving} className="w-full">
            {saving ? 'Saving…' : 'Save Profile'}
          </Button>
        </form>
      </section>

      {/* Cursor color section */}
      <section className="bg-white rounded-xl border border-gray-100 shadow-sm p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-2">Cursor Color</h2>
        <p className="text-sm text-gray-400 mb-4">
          This color is shown on your cursor when collaborating in real time.
        </p>
        <div className="flex gap-3 flex-wrap">
          {CURSOR_COLORS.map(color => (
            <button
              key={color}
              onClick={() => handleCursorColorChange(color)}
              className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 ${
                cursorColor === color ? 'border-gray-800 scale-110' : 'border-transparent'
              }`}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
