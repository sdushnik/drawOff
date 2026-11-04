# DrawOff

DrawOff is a multiplayer drawing game project. The repository contains a React,
TypeScript, Vite, and Tailwind frontend and a minimal Node.js, TypeScript,
Fastify, and Socket.IO backend entry point.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer

## Install

From the repository root, install all workspace dependencies from the root
`package-lock.json`:

```sh
npm ci
```

## Development

Start the frontend and backend development servers together:

```sh
npm run dev
```

The frontend is served by Vite. The backend listens on port `3000` by default;
set `PORT` or `HOST` to override its listener.

The backend allows the local Vite origins on ports 5173 and 8080 in
development. In production, set `FRONTEND_ORIGINS` to a comma-separated list
of exact frontend origins (for example, `https://draw.example`). The same
allowlist is used for HTTP and Socket.IO, with credentialed CORS enabled; a
wildcard origin is not accepted.

## Test

Run the test suites for all workspaces:

```sh
npm test
```

Run the real multi-browser frontend/backend flow:

```sh
npx playwright install chromium
npm run test:e2e
```

The end-to-end command starts an isolated Fastify/Socket.IO backend and Vite
frontend, then drives separate Chromium browser contexts through the full game
loop and recovery scenarios. It uses state-based waits, cleans up contexts and
servers on failure, and retains traces, screenshots, and video for diagnostics.

## Production build

Build all workspaces:

```sh
npm run build
```

The backend build is emitted to `backend/dist`; start it with
`npm run start --workspace=@drawoff/backend`.
