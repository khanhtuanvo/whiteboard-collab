# Whiteboard Collab

Real-time collaborative whiteboard with AI-assisted sticky note organization.

Whiteboard Collab combines a modern canvas UI, low-latency multi-user synchronization, and an ML microservice that groups sticky notes by semantic similarity.

## Why this project

Teams need a fast way to brainstorm together without losing structure. This project provides:

- Real-time board collaboration with live presence and cursor sharing
- Role-based board access and collaborator management
- Undo/redo history with Redis-backed snapshots
- AI Auto-Organize for sticky notes (semantic clustering)
- Docker-first local and production workflows

## Features

### Collaboration and board UX

- Create, update, delete, and share boards
- Public board read endpoints for view-only access
- Real-time element create, update, delete, and bulk update events
- Active users list and live cursor positions
- Keyboard-friendly interactions (undo/redo, selection, delete)
- Board clear action restricted to privileged roles

### AI features

- Auto-Organize sticky notes by semantic similarity
- Configurable layout mode (preserve proximity or aggressive organize)
- Backend caching of cluster results in Redis
- Circuit-breaker and graceful degraded fallback when ML is unavailable
- Request validation and strict rate limiting for AI endpoints

### Reliability and safety

- API and socket event rate limits
- Role checks on board operations
- Strict payload validation with Zod and Pydantic
- Health and readiness probes for service monitoring
- CI checks with path-based job filtering

## Architecture

The system uses a service-oriented architecture:

- Frontend: Next.js app with Fabric.js canvas, Zustand state, and Socket.IO client
- Backend: Express + Socket.IO gateway, Prisma ORM, Redis integration, board/auth/AI APIs
- ML service: FastAPI service for semantic clustering using sentence-transformers + scikit-learn
- Data layer: MySQL for persistence, Redis for caching, presence, and history stacks
- Edge: Nginx reverse proxy for HTTPS, API routing, and WebSocket upgrade

### High-level request flow

1. User performs an action in the canvas.
2. Frontend emits socket events and/or calls REST APIs.
3. Backend authenticates, validates, checks permissions, and persists state.
4. Backend broadcasts real-time updates to board room participants.
5. AI requests are proxied by backend to ML service with service-token auth.

## Tech stack

- Frontend: Next.js 16, React 19, TypeScript, Fabric.js, Zustand, Vitest
- Backend: Node.js, Express 5, TypeScript, Socket.IO, Prisma, Jest, Supertest
- ML service: Python 3.11, FastAPI, sentence-transformers, scikit-learn, pytest
- Infrastructure: Docker Compose, Nginx, GitHub Actions, AWS EC2 deployment

## Repository structure

```text
.
├── backend/
│   ├── prisma/
│   ├── src/
│   └── tests/
├── frontend/
│   ├── app/
│   ├── components/
│   ├── hooks/
│   └── store/
├── ml-service/
│   ├── app/
│   └── tests/
├── docker/
├── nginx/
├── docker-compose.yml
├── .env.example
├── dev.sh
├── run-tests.sh
└── stop.sh
```

## Quick start (Docker, recommended)

### 1) Configure environment

```bash
cp .env.example .env
```

Open `.env` and set secure values for at least:

- `MYSQL_ROOT_PASSWORD`
- `MYSQL_PASSWORD`
- `JWT_SECRET`
- `ML_SERVICE_KEY`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_WS_URL`

### 2) Build and run

```bash
docker compose up --build -d
```

### 3) Verify health

```bash
curl http://localhost:4000/health
curl http://localhost:5000/ready
```

### 4) Open the app

- Application: `http://localhost`

## Local development (without Docker)

This mode is useful when iterating quickly on one service.

### Prerequisites

- Node.js 20+
- npm
- Python 3.10+ (3.11 recommended)
- MySQL 8
- Redis 7

### Backend

```bash
cd backend
cp .env.example .env
npm ci
npx prisma generate
npx prisma migrate deploy
npm run dev
```

### Frontend

```bash
cd frontend
cp .env.local.example .env.local
npm ci
npm run dev
```

### ML service

```bash
cd ml-service
python -m venv venv
./venv/bin/pip install -r requirements-dev.txt
./venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 5000 --log-level info
```

### Optional tmux launcher

```bash
./dev.sh
```

## Environment variables

Root `.env` (for Docker Compose) contains the most important runtime settings.

### Core variables

- `MYSQL_ROOT_PASSWORD`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `FRONTEND_URL`
- `ML_ENABLED`
- `ML_TIMEOUT_MS`
- `ML_SERVICE_KEY`
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_WS_URL`

### Optional S3 upload variables

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_BUCKET`

Important: `NEXT_PUBLIC_*` values are compiled into the frontend bundle at build time.

## API overview

### Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/profile`
- `PATCH /api/auth/profile`

### Boards

- `GET /api/boards`
- `GET /api/boards/:id`
- `GET /api/boards/:id/elements`
- `POST /api/boards`
- `PATCH /api/boards/:id`
- `DELETE /api/boards/:id`
- `POST /api/boards/:id/collaborators`

### Public board endpoints

- `GET /api/public/boards/:id`
- `GET /api/public/boards/:id/elements`

### AI

- `POST /api/boards/:id/ai/cluster`

### Health

- `GET /health`

## Real-time socket events

### Client to server

- `board:join`
- `board:leave`
- `cursor:move`
- `element:create`
- `element:update`
- `elements:bulk_update`
- `element:delete`
- `element:undo`
- `element:redo`
- `board:clear`

### Server to client

- `room:users`
- `user:joined`
- `user:left`
- `cursor:update`
- `element:created`
- `element:updated`
- `element:deleted`
- `element:snapshot`
- `board:cleared`
- `history:state`
- `error`

## AI Auto-Organize behavior

1. Frontend collects sticky notes from board state.
2. Backend verifies board permission (editor/admin), validates payload, applies AI rate limit.
3. Backend checks Redis cache for prior clustering result.
4. On cache miss, backend calls ML service with `ML_SERVICE_KEY`.
5. ML service creates embeddings and computes K-Means clusters.
6. Backend returns suggestions to frontend preview modal.
7. User accepts or rejects suggested layout.

Failure mode:

- If ML is slow/unavailable, backend returns degraded response that preserves current positions.

## Testing

Run all tests from project root:

```bash
./run-tests.sh
```

Run service-specific tests:

```bash
cd backend && npm test
cd frontend && npm test
cd ml-service && ./venv/bin/python -m pytest tests
```

## CI and CD

### CI

- GitHub Actions workflow runs on push/PR
- Path filter skips unaffected jobs
- Backend: type check, lint, tests, Prisma migrate deploy
- Frontend: type check, tests, production build
- ML service: targeted pytest suites

### CD

- Deploy workflow triggers after successful CI on `main`
- SSH deploy to AWS EC2
- Builds images, applies Prisma migrations, starts services with Docker Compose
- Performs health checks and attempts rollback on failure

## Troubleshooting

### Frontend calls wrong backend URL

- Ensure `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` are correct in `.env`
- Rebuild frontend image after changing these values

### AI endpoint returns degraded suggestions

- Check `ML_ENABLED=true`
- Verify `ML_SERVICE_KEY` matches in backend and ml-service
- Check ML readiness endpoint: `GET /ready`

### Socket updates not working behind proxy

- Confirm Nginx includes WebSocket upgrade for `/socket.io/`

### Database errors on startup

- Verify `DATABASE_URL` and MySQL credentials
- Run migrations in backend container or local backend

## Security notes

- Never commit secrets or private keys
- Use strong random values for `JWT_SECRET` and `ML_SERVICE_KEY`
- Keep TLS certificates secure in production environments
- Restrict destructive board actions to trusted roles

## Contributing

1. Create a feature branch
2. Implement and test changes
3. Run service tests locally
4. Open a pull request with a clear description

## License

See `LICENSE` if present in this repository.
