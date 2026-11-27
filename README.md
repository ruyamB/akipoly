<div align="center">

<img src="public/icons/akipoly-wordmark.png" alt="Akipoly" width="360" />

### Roll. Trade. Own the Arc.

The classic property-trading board game, rebuilt as a loud, fast, arcade-bright game on the [Arc](https://www.arc.network/) blockchain.

[**Website**](https://akipoly.xyz) · [**Docs**](https://akipoly.xyz/docs) · [**Play the minigame**](https://akipoly.xyz/play)

![Astro](https://img.shields.io/badge/Astro-BC52EE?logo=astro&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Solidity](https://img.shields.io/badge/Solidity-363636?logo=solidity&logoColor=white)
![Network](https://img.shields.io/badge/Arc-testnet-yellow)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

</div>

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [How the minigame works](#how-the-minigame-works)
- [Provably fair randomness](#provably-fair-randomness)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Performance](#performance)
- [Project structure](#project-structure)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Overview

Akipoly is a GameFi project that reimagines the property-trading board game for the screen, with a neobrutalist, arcade-style look. This repository contains:

- **The website**: the landing page with a waitlist and the `/docs` explainer.
- **The `/play` minigame**: a real-money (USDC) "higher or lower" elimination game, playable today on Arc testnet.
- **The game server**: an authoritative WebSocket backend that runs lobbies, games, and payouts.
- **The smart contracts**: an on-chain verifiable random function (VRF) that draws every ball.

## Features

- **Embedded wallets.** Sign in with [Privy](https://privy.io); an embedded wallet on Arc is created on first login, so no browser extension is needed.
- **Real USDC stakes.** Buy-ins and side bets are paid in USDC and verified on-chain before a player is seated.
- **Provably fair.** Every ball comes from an on-chain VRF, and any round can be re-verified against the contract.
- **Rooms and invites.** Create a room, share a room code or invite link, or pick an open room from the list.
- **Live play.** Server-pushed state, a betting countdown, round history, and a career view of past games.
- **Accessible motion.** All animations respect `prefers-reduced-motion`.

## How the minigame works

1. **Buy in and take a seat.** Anyone can open a room with a USDC buy-in (up to 10 players). Pressing **Ready** pays the buy-in from the player's wallet to the treasury, and the server verifies the transfer on-chain.
2. **Call the next ball.** When at least two players are seated and ready, a short countdown starts the game and an opening ball (00–16) is drawn. Each round, every player still standing calls whether the next ball will be **higher** or **lower**, optionally backing the call with a pari-mutuel USDC side bet.
3. **Last one standing takes the pot.** A wrong call, or no call, eliminates the player. The same ball again is a push. The last player standing wins the pot, minus the house fee (`HOUSE_FEE_BPS`).

Rounds move through the phases `betting → drawing → rolling → settled`.

## Provably fair randomness

Balls are drawn by the hosted [Arc VRF](https://arcvrf.007575.xyz/docs) (Chainlink VRF v2.5-style, paid in USDC from a subscription):

1. Calls close first. Only then does the treasury call `AkipolyRounds.requestBall(game, round)`, which asks the Arc VRF coordinator for one word using our key hash and `VRF_SUBSCRIPTION_ID`.
2. The Arc VRF answers with a proof, the coordinator verifies it on-chain, and only then calls `AkipolyRounds` back with the word. Nobody can rig the number, including the VRF operator and us.
3. `AkipolyRounds` sets `ball = randomWord % 17` on-chain. A round can never be re-requested, so a slow answer can't be swapped for a better one.

The game server holds no VRF key: it only sends the request and reads `AkipolyRounds.drawOf`. If a draw is not delivered within `VRF_DRAW_TIMEOUT_MS`, the round is voided and side bets are refunded. The game review links every ball to its Arc VRF proof page (`/requests/<requestId>`) and re-reads the result from the chain in your browser.

## Architecture

```
┌────────────────────────┐    wss://     ┌────────────────────────────┐
│  Website (Astro)       │──────────────▶│  Game server (Node, ws)    │
│  /  /docs  /play       │               │  lobbies · games · payouts │
│  /api/waitlist (Vercel)│               └──────┬──────────────┬──────┘
└──────────┬─────────────┘                      │              │
           │ Privy embedded wallet              │ SQL          │ viem
           ▼                                    ▼              ▼
┌────────────────────────┐            ┌────────────────┐ ┌──────────────────────┐
│  Arc (USDC, ERC-20)    │◀───────────│ Postgres (Neon)│ │ Arc VRF + Rounds     │
└────────────────────────┘            └────────────────┘ │ + AkipolyRounds      │
                                                         └──────────────────────┘
```

- The **website** serves static pages plus one serverless function (`/api/waitlist`). The `/play` page is a React island.
- The **game server** is the single authority for lobbies and game state. It verifies incoming USDC, schedules rounds, requests VRF draws, and pays winners from a treasury hot wallet.
- Payouts are written in the same database transaction that settles a round, then sent by a single worker that signs each transfer before broadcasting it. A crash can only rebroadcast the same transaction, never pay twice.

## Tech stack

| Layer     | Technologies                                                         |
| --------- | -------------------------------------------------------------------- |
| Frontend  | Astro, React, TypeScript, Privy, viem, Three.js                      |
| Backend   | Node.js ≥ 20, TypeScript, `ws`, Zod, Pino, PostgreSQL (`pg`), viem   |
| Contracts | Solidity 0.8, solc-js build, Ganache tests                           |
| Infra     | Vercel (website), Docker + nginx (game server), Neon (Postgres), Arc |

## Getting started

### Prerequisites

- Node.js 20 or newer and npm
- A PostgreSQL database (a [Neon](https://neon.tech) pooled endpoint is recommended)
- A [Privy](https://privy.io) app with **identity tokens enabled**
- For testnet play: test USDC from the [Circle faucet](https://faucet.circle.com/)

### 1. Website

```sh
npm install
cp .env.example .env      # fill in PUBLIC_PRIVY_APP_ID, PUBLIC_WS_URL, PUBLIC_ARC_NETWORK
npm run dev               # http://localhost:4321
```

| Command           | Description                    |
| ----------------- | ------------------------------ |
| `npm run dev`     | Start the local dev server     |
| `npm run build`   | Build for production           |
| `npm run preview` | Preview the production build   |
| `npm run check`   | Type-check the project         |

### 2. Game server

```sh
cd backend
cp .env.example .env      # fill in DATABASE_URL, PRIVY_APP_ID, TREASURY_PRIVATE_KEY, VRF_* …
npm ci
npm run migrate:dev       # apply database migrations
npm run dev               # ws://localhost:8081  (health: /health, /ready)
npm test                  # rules and fairness unit tests
```

> **Note:** migration `001_init` drops and recreates the game tables (it keeps `app_users`). Only run it against a database you are happy to reset.

### 3. Smart contracts

```sh
cd contracts
npm install
npm test                  # compile and run the Ganache test suite
RPC_URL=https://rpc.testnet.arc.io DEPLOYER_PRIVATE_KEY=0x… TREASURY_ADDRESS=0x… VRF_SUBSCRIPTION_ID=… npm run deploy
```

Before deploying, create a subscription on [Arc VRF → Subscriptions](https://arcvrf.007575.xyz/subscriptions) and fund it with USDC (1 USDC covers plenty of test draws). `npm run deploy` deploys `AkipolyRounds` against the Arc VRF coordinator, adds it as a consumer if the deployer owns the subscription (otherwise add it on the subscription page), and prints `VRF_SUBSCRIPTION_ID` and `VRF_ROUNDS_ADDRESS` for `backend/.env`.

## Configuration

### Website (`.env`)

| Variable                   | Required | Description                                                                 |
| -------------------------- | -------- | --------------------------------------------------------------------------- |
| `PUBLIC_PRIVY_APP_ID`      | Yes      | Privy App ID (public). Never put the Privy App Secret in this repo.         |
| `PUBLIC_WS_URL`            | Yes      | Game server endpoint, e.g. `ws://localhost:8081` or `wss://ws.example.com`. |
| `PUBLIC_ARC_NETWORK`       | Yes      | `testnet` or `mainnet`. Must match the server's `ARC_NETWORK`.              |
| `DATABASE_URL`             | Waitlist | Server-only Neon connection string used by `/api/waitlist`.                 |
| `PUBLIC_WAITLIST_ENDPOINT` | No       | Override the endpoint the waitlist form posts to.                           |

Without `DATABASE_URL`, the waitlist endpoint returns a friendly 503 instead of failing the page.

### Game server (`backend/.env`)

`backend/.env.example` documents every option. The most important ones:

| Variable                                         | Description                                                    |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `DATABASE_URL`, `DB_POOL_MAX`                    | Postgres connection (use the pooled endpoint) and pool size.   |
| `PRIVY_APP_ID`                                   | Used to verify players' identity tokens.                       |
| `ARC_NETWORK`, `ARC_RPC_URL`                     | `testnet` (chain 5042002) or `mainnet` (chain 5042); optional RPC override. |
| `TREASURY_PRIVATE_KEY`                           | Hot wallet that receives buy-ins and sends payouts.            |
| `VRF_SUBSCRIPTION_ID`, `VRF_ROUNDS_ADDRESS`      | Arc VRF subscription that pays for draws, and the deployed `AkipolyRounds`. |
| `VRF_COORDINATOR_ADDRESS`, `VRF_KEY_HASH`        | Only for networks without a built-in Arc VRF deployment (Arc Testnet is built in). |
| `VRF_DRAW_TIMEOUT_MS`                            | Deadline before an undelivered round is voided.                |
| `HOUSE_FEE_BPS`, `MIN_BUY_IN_USDC`, `MAX_BUY_IN_USDC`, `MAX_SIDE_BET_USDC` | Table economics.       |
| `MAX_AUTO_PAYOUT_USDC`                           | Payouts above this are held for manual review.                 |
| `BETTING_SECONDS`, `ROLLING_MS`, `MAX_ROUNDS`    | Game timing.                                                   |
| `ALLOWED_ORIGINS`, `MAX_CONNECTIONS`             | Socket origin allow-list and connection cap.                   |

On both networks, USDC is the ERC-20 interface at `0x3600000000000000000000000000000000000000` (6 decimals).

## Deployment

### Website (Vercel)

Import the repository into Vercel; it detects Astro automatically. Set the website variables above under **Project → Settings → Environment Variables**. Keep `DATABASE_URL` server-only: never commit it and never prefix it with `PUBLIC_`.

### Game server (Docker)

On the server, inside `backend/`:

```sh
cp .env.example .env                       # once: fill in the real values
docker compose up -d --build               # build, apply pending migrations, start
docker compose logs -f                     # follow logs
git pull && docker compose up -d --build   # update
```

The container listens on port 8081 and is published on `127.0.0.1` only (configurable with `PORT` and `BIND_ADDRESS`). Put a reverse proxy such as nginx in front of it to terminate TLS and proxy `wss://` traffic. Run **exactly one** instance: the treasury must have a single signer.

## Performance

A single container comfortably serves well over 100 concurrent players. Results from `backend/scripts/loadtest.ts` (real services, local Postgres, 5 s betting and 1 s rolling; measured before the VRF drawing phase was added, with VRF answered in-process):

| Players | Games | `placePick` p95 | Change → push p95 | Phase lateness p95 |
| ------: | ----: | --------------: | ----------------: | -----------------: |
|     100 | 10/10 |            6 ms |             60 ms |              68 ms |
|     500 | 50/50 |            5 ms |             58 ms |             135 ms |

Keep `DB_POOL_MAX=10` for about 100 players and raise it to 20 past about 300, or whenever `/health` reports `db.waiting > 0`. To run the load test against a throwaway database:

```sh
cd backend
docker compose -p akipoly-loadtest -f docker-compose.loadtest.yml run --rm loadtest
docker compose -p akipoly-loadtest -f docker-compose.loadtest.yml down -v
```

`-p akipoly-loadtest` keeps the test on its own Docker network, apart from the real server (`COMPOSE_PROJECT_NAME` would otherwise override the file's `name:`). If you ran the load test before it had its own project name, remove the old database once, from `backend/`:

```sh
docker ps -aq -f label=com.docker.compose.project.config_files="$PWD/docker-compose.loadtest.yml" -f label=com.docker.compose.service=db | xargs -r docker rm -fv
```

PowerShell:

```powershell
docker ps -aq -f "label=com.docker.compose.project.config_files=$PWD\docker-compose.loadtest.yml" -f label=com.docker.compose.service=db | ForEach-Object { docker rm -fv $_ }
```

It matches on the compose file path, so it only touches this repo's load-test db whatever project name the old run used. Check `docker ps` afterwards if you ran it with a different `-f` path.

Connection limits: 5 sockets per player (the oldest is closed), `MAX_CONNECTIONS` in total, and clients with more than 1 MB of unsent data are dropped.

## Project structure

```
akipoly/
├── src/                        Website (Astro)
│   ├── pages/                  index, docs, play, api/waitlist
│   ├── components/             landing components and the /play React island
│   │   └── dashboard/          lobby list, room, live game, wallet, career, review
│   ├── features/game/          socket client, USDC payments, ball reel, pick panel
│   ├── lib/                    Arc network config, fairness checks, waitlist client
│   ├── scripts/                motion and confetti effects
│   └── styles/                 design tokens and page styles
├── backend/                    Game server
│   ├── src/shared/             protocol (Zod), Arc network table, VRF helpers; the site
│   │                           imports it as `@shared/*` (alias in tsconfig.json)
│   ├── src/config/             validated environment (fails fast)
│   ├── src/db/                 pool, migration runner, read models
│   ├── src/domain/             pure game rules (unit tested)
│   ├── src/chain/              USDC verification, treasury transactions, Arc VRF client
│   ├── src/services/           lobby and game state machines, VRF draws, payouts
│   ├── src/scheduler/          advances due rounds and countdowns
│   ├── src/ws/                 transport, router, per-user push hub
│   └── migrations/             SQL migrations
├── contracts/                  AkipolyRounds (Arc VRF consumer) + test mock coordinator
└── public/                     icons and static assets
```

## Security

- **Never commit secrets.** `.env` files are git-ignored; only the `.env.example` templates belong in the repo.
- **The treasury is a custodial hot wallet.** Keep its balance small and sweep it regularly. Payouts above `MAX_AUTO_PAYOUT_USDC`, or that never land, are marked `held` for manual review.
- **Keep the Arc VRF subscription funded.** The server warns at boot when it runs low; an empty subscription stalls draws until rounds void. The Arc VRF is unaudited testnet software with a single operator: it can delay an answer but not change it.
- If you find a vulnerability, please report it privately to the maintainers rather than opening a public issue.

## Contributing

Contributions are welcome.

1. Fork the repository and create a feature branch from `master`.
2. Make your change, then run `npm run build` (and `npm test` in `backend/` or `contracts/` if you touched them).
3. Open a pull request with a clear description and screenshots for UI changes.

## License

Released under the [MIT License](LICENSE).

`contracts/src/ArcVRFClient.sol` is copied from [arc-vrf](https://github.com/HimanshuM685/arc-vrf) and the consumer base follows [Chainlink](https://github.com/smartcontractkit/chainlink)'s; both are MIT-licensed.
