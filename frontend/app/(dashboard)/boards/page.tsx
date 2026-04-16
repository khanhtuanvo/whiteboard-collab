'use client';

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useUserStore } from "@/store/userStore";
import { boardService } from "@/lib/boardService";
import { Board } from "@/types/board";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, Search, MoreHorizontal, Trash2, Pencil, Copy, Share2, Clock, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import Link from "next/link";
import axios from "axios";
import { toast } from "sonner";

type Tab = 'mine' | 'shared';

export default function BoardsPage() {
  const router = useRouter();
  const user = useUserStore((state) => state.user);
  const _hasHydrated = useUserStore((state) => state._hasHydrated);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('mine');
  const [search, setSearch] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [shareDialogId, setShareDialogId] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'VIEWER' | 'EDITOR' | 'ADMIN'>('EDITOR');
  const [sharing, setSharing] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!_hasHydrated) return;
    if (!user) {
      router.push('/login');
      return;
    }
    loadBoards();
  }, [user, _hasHydrated, router]);

  // Close context menu on outside click
  useEffect(() => {
    const close = () => setOpenMenuId(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const loadBoards = async () => {
    try {
      const data = await boardService.getBoards();
      setBoards(data);
    } catch (error) {
      console.error('Failed to load boards', error);
    } finally {
      setLoading(false);
    }
  };

  const myBoards = useMemo(
    () => boards.filter(b => b.ownerId === user?.id),
    [boards, user]
  );
  const sharedBoards = useMemo(
    () => boards.filter(b => b.ownerId !== user?.id),
    [boards, user]
  );

  const visibleBoards = (tab === 'mine' ? myBoards : sharedBoards).filter(b =>
    b.title.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBoardTitle.trim()) return;
    setCreating(true);
    try {
      const newBoard = await boardService.createBoard({ title: newBoardTitle, isPublic: false });
      setBoards(prev => [newBoard, ...prev]);
      setNewBoardTitle('');
      setCreateDialogOpen(false);
      router.push(`/boards/${newBoard.id}`);
    } catch {
      toast.error('Failed to create board');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBoard = async (id: string) => {
    if (!confirm('Delete this board? This cannot be undone.')) return;
    try {
      await boardService.deleteBoard(id);
      setBoards(prev => prev.filter(b => b.id !== id));
      toast.success('Board deleted');
    } catch {
      toast.error('Failed to delete board');
    }
  };

  const handleRenameBoard = async (id: string) => {
    if (!renameTitle.trim()) return;
    try {
      const updated = await boardService.updateBoard(id, { title: renameTitle.trim() });
      setBoards(prev => prev.map(b => b.id === id ? { ...b, title: updated.title } : b));
      setRenamingId(null);
      toast.success('Board renamed');
    } catch {
      toast.error('Failed to rename board');
    }
  };

  const handleDuplicateBoard = async (board: Board) => {
    try {
      const copy = await boardService.createBoard({ title: `${board.title} (copy)`, isPublic: board.isPublic });
      setBoards(prev => [copy, ...prev]);
      toast.success('Board duplicated');
    } catch {
      toast.error('Failed to duplicate board');
    }
  };

  const handleShare = async () => {
    if (!shareDialogId || !shareEmail.trim()) return;
    setSharing(true);
    try {
      await boardService.addCollaborator(shareDialogId, shareEmail.trim(), shareRole);
      toast.success(`Invited ${shareEmail.trim()} as ${shareRole.toLowerCase()}`);
      setShareEmail('');
      setShareDialogId(null);
    } catch (err: unknown) {
      toast.error(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to add collaborator') : 'Failed to add collaborator');
    } finally {
      setSharing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading boards…</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header row */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Boards</h1>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1.5" />
              New Board
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New Board</DialogTitle>
              <DialogDescription>Give your board a name to get started.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleCreateBoard} className="space-y-4 mt-2">
              <div>
                <Label htmlFor="title">Board Title</Label>
                <Input
                  id="title"
                  placeholder="e.g., Q1 Planning, Design Sprint"
                  value={newBoardTitle}
                  onChange={(e) => setNewBoardTitle(e.target.value)}
                  required
                  className="mt-1"
                />
              </div>
              <Button type="submit" className="w-full" disabled={creating}>
                {creating ? 'Creating…' : 'Create Board'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Tabs + Search */}
      <div className="flex items-center gap-4 mb-6">
        <div className="flex border-b border-gray-200">
          <TabButton active={tab === 'mine'} onClick={() => setTab('mine')}>
            My Boards
            <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
              {myBoards.length}
            </span>
          </TabButton>
          <TabButton active={tab === 'shared'} onClick={() => setTab('shared')}>
            Shared with Me
            <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">
              {sharedBoards.length}
            </span>
          </TabButton>
        </div>
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search boards…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 pr-4 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 w-56"
          />
        </div>
      </div>

      {/* Board grid */}
      {visibleBoards.length === 0 ? (
        <div className="text-center py-24 text-gray-400">
          {search ? 'No boards match your search.' : tab === 'mine' ? "You don't have any boards yet." : "No boards have been shared with you."}
          {!search && tab === 'mine' && (
            <div className="mt-4">
              <Button onClick={() => setCreateDialogOpen(true)}>Create Your First Board</Button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {visibleBoards.map(board => (
            <BoardCard
              key={board.id}
              board={board}
              isOwner={board.ownerId === user?.id}
              menuOpen={openMenuId === board.id}
              onMenuToggle={(e) => {
                e.stopPropagation();
                setOpenMenuId(prev => prev === board.id ? null : board.id);
              }}
              onRename={() => { setRenamingId(board.id); setRenameTitle(board.title); setOpenMenuId(null); }}
              onDuplicate={() => { handleDuplicateBoard(board); setOpenMenuId(null); }}
              onDelete={() => { handleDeleteBoard(board.id); setOpenMenuId(null); }}
              onShare={() => { setShareDialogId(board.id); setShareEmail(''); setOpenMenuId(null); }}
            />
          ))}
        </div>
      )}

      {/* Rename dialog */}
      {renamingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-80">
            <h2 className="text-base font-semibold mb-3">Rename Board</h2>
            <input
              className="w-full border rounded px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={renameTitle}
              onChange={e => setRenameTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleRenameBoard(renamingId)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 text-sm rounded border hover:bg-gray-50" onClick={() => setRenamingId(null)}>Cancel</button>
              <button className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700" onClick={() => handleRenameBoard(renamingId)}>Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Share dialog */}
      {shareDialogId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h2 className="text-lg font-semibold mb-4">Share Board</h2>
            <label className="block text-sm font-medium mb-1">Email address</label>
            <input
              type="email"
              className="w-full border rounded px-3 py-2 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="colleague@example.com"
              value={shareEmail}
              onChange={e => setShareEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleShare()}
            />
            <label className="block text-sm font-medium mb-1">Role</label>
            <select
              className="w-full border rounded px-3 py-2 text-sm mb-4"
              value={shareRole}
              onChange={e => setShareRole(e.target.value as typeof shareRole)}
            >
              <option value="VIEWER">Viewer — can view only</option>
              <option value="EDITOR">Editor — can edit</option>
              <option value="ADMIN">Admin — full access</option>
            </select>
            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 text-sm rounded border hover:bg-gray-50" onClick={() => { setShareDialogId(null); setShareEmail(''); }}>Cancel</button>
              <button
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                onClick={handleShare}
                disabled={sharing || !shareEmail.trim()}
              >
                {sharing ? 'Inviting…' : 'Invite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        active ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

function BoardCard({
  board,
  isOwner,
  menuOpen,
  onMenuToggle,
  onRename,
  onDuplicate,
  onDelete,
  onShare,
}: {
  board: Board;
  isOwner: boolean;
  menuOpen: boolean;
  onMenuToggle: (e: React.MouseEvent) => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const collaboratorCount = board._count?.collaborators ?? 0;

  return (
    <div className="group relative bg-white rounded-xl border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
      {/* Thumbnail */}
      <Link href={`/boards/${board.id}`}>
        <div className="h-36 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-t-xl flex items-center justify-center text-4xl select-none">
          🖊
        </div>
      </Link>

      {/* Card body */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <Link href={`/boards/${board.id}`} className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate text-sm leading-snug">{board.title}</h3>
          </Link>

          {/* Context menu trigger */}
          <div className="relative flex-shrink-0">
            <button
              onClick={onMenuToggle}
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
              title="More options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-7 z-30 w-44 bg-white rounded-lg border border-gray-200 shadow-lg py-1">
                {isOwner && (
                  <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={onRename}>Rename</MenuItem>
                )}
                <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={onDuplicate}>Duplicate</MenuItem>
                {isOwner && (
                  <MenuItem icon={<Share2 className="h-3.5 w-3.5" />} onClick={onShare}>Share</MenuItem>
                )}
                {isOwner && (
                  <>
                    <div className="my-1 border-t border-gray-100" />
                    <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} onClick={onDelete} danger>Delete</MenuItem>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(board.updatedAt).toLocaleDateString()}
          </span>
          {collaboratorCount > 0 && (
            <span className="flex items-center gap-1">
              <Users className="h-3 w-3" />
              {collaboratorCount}
            </span>
          )}
          {!isOwner && board.userRole && (
            <span className="ml-auto text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full capitalize">
              {board.userRole.toLowerCase()}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  onClick,
  danger,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-gray-50'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
