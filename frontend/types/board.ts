export interface Board {
  id: string;
  title: string;
  ownerId: string;
  thumbnailUrl?: string;
  isPublic: boolean;
  settings?: any;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBoardInput {
  title: string;
  isPublic?: boolean;
}

export interface UpdateBoardInput {
  title?: string;
  isPublic?: boolean;
  settings?: any;
}