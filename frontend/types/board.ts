export type UserRole = 'OWNER' | 'EDITOR' | 'VIEWER' | 'ADMIN';

export interface Board {
  id: string;
  title: string;
  ownerId: string;
  thumbnailUrl?: string;
  isPublic: boolean;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  userRole?: UserRole;
  _count?: { collaborators: number };
}

export interface CreateBoardInput {
  title: string;
  isPublic?: boolean;
}

export interface UpdateBoardInput {
  title?: string;
  isPublic?: boolean;
  settings?: Record<string, unknown>;
}
