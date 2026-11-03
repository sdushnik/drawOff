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

Running `npm run dev` from the repository root connects the frontend to the
local backend at `http://localhost:3000` by default, so multiple browser
clients share the same room state. Set `VITE_GAME_SERVER_URL` to override the
backend origin. Running the frontend workspace by itself uses the in-browser
mock unless `VITE_GAME_SERVER_URL` is set. The live service supports room
creation/joining, roster updates, reconnect, leave, host kick, and cycle
selection; the mock remains the full gameplay implementation.
