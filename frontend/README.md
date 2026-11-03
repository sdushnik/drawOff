# Sketch Together

Create a live-drawing multiplayer application.

Centralize every backend call in one services layer, and create a mock
implementation of it so the whole app runs without a real backend.

Add tests.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/27ed0992-a3fe-472e-93d8-a9916dd8968e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

The browser uses the local mock game service by default. To use the live
Socket.IO lobby, set `VITE_GAME_SERVER_URL` to the backend origin before
starting the frontend (for example, `http://localhost:3000`). The live service
supports room creation/joining, roster updates, reconnect, leave, host kick,
and cycle selection; the mock remains the full gameplay implementation.
