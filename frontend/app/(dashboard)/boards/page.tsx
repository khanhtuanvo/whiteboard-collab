'use client';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useUserStore } from "@/store/userStore";
import { boardService } from "@/lib/boardService";
import { Board } from "@/types/board";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";


export default function BoardsPage(){
  const router = useRouter()
  const user = useUserStore((state) => state.user);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!user) {
      router.push('/login');
      return;
    }
    loadBoards();
  }, [user, router]);

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

  const handleCreateBoard = async (e: React.FormEvent) => {
    e.preventDefault();
    if(!newBoardTitle.trim()) return;

    setCreating(true);
    try {
      const newBoard = await boardService.createBoard({
        title: newBoardTitle,
        isPublic: false,
      });
      setBoards([newBoard, ...boards]);
      setNewBoardTitle('');
      setCreateDialogOpen(false);

      //Navigate to the new board
      router.push(`/boards/${newBoard.id}`);
    } catch (error) {
      console.error('Failed to create board', error);
      alert('Failed to create board');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBoard = async (id: string) => {
    if (!confirm('Are you sure you want to delete this board')) return;

    try {
      await boardService.deleteBoard(id);
      setBoards(boards.filter((b) => b.id !== id));
    } catch (error) {
      console.error('Failed to delete board', error);
      alert('Failed to delete board');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Loading boards ...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">My Boards</h1>
            <p className="text-gray-600 mt-1">
              Welcome back, {user?.name}
            </p>
          </div>

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Board
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Board</DialogTitle>
                <DialogDescription>
                  Give your board a name to get started
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleCreateBoard} className="space-y-4">
                <div>
                  <Label htmlFor="title">Board Title</Label>
                  <Input
                    id="title"
                    placeholder="e.g., Q1 Planning, Design Sprint"
                    value={newBoardTitle}
                    onChange={(e) => setNewBoardTitle(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" className="w-full" disabled={creating}>
                  {creating ? 'Creating...' : 'Create Board'}
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {boards.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <p className="text-gray-500 mb-4">
                You don't have any boards yet
              </p>
              <Button onClick={() => setCreateDialogOpen(true)}>
                Create Your First Board
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {boards.map((board) => (
              <Card
                key={board.id}
                className="hover:shadow-lg transition-shadow cursor-pointer"
              >
                <Link href={`/boards/${board.id}`}>
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      <span className="truncate">{board.title}</span>
                    </CardTitle>
                    <CardDescription>
                      Updated {new Date(board.updatedAt).toLocaleDateString()}
                    </CardDescription>
                  </CardHeader>
                </Link>
                <CardContent>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        handleDeleteBoard(board.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
} 