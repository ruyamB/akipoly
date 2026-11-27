import 'dotenv/config';
import { z } from 'zod';
import { parseUnits } from 'viem';
import { ARC_NETWORKS, USDC_DECIMALS } from '../shared/arc.js';

const usdc = (fallback: string) =>
  z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/, 'expected a USDC amount like 1 or 0.5')
    .default(fallback)
    .transform((v) => parseUnits(v, USDC_DECIMALS));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Comma-separated list of allowed browser origins; empty = allow all. */
  ALLOWED_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  /** Set when DATABASE_URL points at an IP (TLS SNI must still be the host). */
  DATABASE_TLS_SERVERNAME: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  PRIVY_APP_ID: z.string().min(1),

  ARC_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),
  /** Optional RPC override (e.g. a paid provider). */
  ARC_RPC_URL: z.string().url().optional(),
  /** Hot wallet that receives buy-ins/side bets and sends payouts. */
  TREASURY_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'TREASURY_PRIVATE_KEY must be 0x + 64 hex'),
  /** AkipolyRounds: the Arc VRF consumer the treasury calls once per round. */
  VRF_ROUNDS_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'VRF_ROUNDS_ADDRESS must be an address'),
  /** Arc VRF subscription that pays for draws (https://arcvrf.007575.xyz/subscriptions). */
  VRF_SUBSCRIPTION_ID: z.string().regex(/^\d{1,78}$/, 'VRF_SUBSCRIPTION_ID must be the numeric subscription id'),
  /** Override the network's Arc VRF coordinator / key hash (required where none is published). */
  VRF_COORDINATOR_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'VRF_COORDINATOR_ADDRESS must be an address').optional(),
  VRF_KEY_HASH: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'VRF_KEY_HASH must be 0x + 64 hex').optional(),
  /** A round still drawing after this long is voided (side bets refunded, nobody out). */
  VRF_DRAW_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(300_000),
  /** Run the treasury worker (VRF draws + payouts) in this process. Exactly one instance should. */
  PAYOUT_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  HOUSE_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(0),
  MIN_BUY_IN_USDC: usdc('0.1'),
  MAX_BUY_IN_USDC: usdc('100'),
  MAX_SIDE_BET_USDC: usdc('50'),
  /** Payouts above this are held for manual review instead of auto-sent. */
  MAX_AUTO_PAYOUT_USDC: usdc('1000'),

  BETTING_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  ROLLING_MS: z.coerce.number().int().min(1000).max(10000).default(3500),
  START_COUNTDOWN_MS: z.coerce.number().int().min(0).max(30000).default(3000),
  MAX_ROUNDS: z.coerce.number().int().min(1).max(500).default(50),
  /** Hard cap on open sockets; further upgrades get 503 (bounds memory). */
  MAX_CONNECTIONS: z.coerce.number().int().min(10).max(100_000).default(2000),
});

// Backwards-compatible names from the previous .env layout.
const raw = {
  ...process.env,
  PORT: process.env.PORT ?? process.env.WS_PORT,
  TREASURY_PRIVATE_KEY: process.env.TREASURY_PRIVATE_KEY ?? process.env.OPERATOR_PRIVATE_KEY,
};

const parsed = schema.safeParse(raw);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

// Arc VRF: the network's published coordinator/key hash unless overridden.
const vrfDefaults = ARC_NETWORKS[env.ARC_NETWORK].vrf;
const vrfCoordinator = env.VRF_COORDINATOR_ADDRESS ?? vrfDefaults?.coordinator;
const vrfKeyHash = env.VRF_KEY_HASH ?? vrfDefaults?.keyHash;
if (!vrfCoordinator || !vrfKeyHash) {
  // eslint-disable-next-line no-console
  console.error(
    `Invalid environment:\n  Arc VRF has no published deployment on ${env.ARC_NETWORK}: set VRF_COORDINATOR_ADDRESS and VRF_KEY_HASH`,
  );
  process.exit(1);
}

export const arc = {
  ...ARC_NETWORKS[env.ARC_NETWORK],
  rpcUrl: env.ARC_RPC_URL ?? ARC_NETWORKS[env.ARC_NETWORK].rpcUrl,
  vrf: {
    coordinator: vrfCoordinator as `0x${string}`,
    keyHash: vrfKeyHash as `0x${string}`,
    subscriptionId: BigInt(env.VRF_SUBSCRIPTION_ID),
    // The published explorer only knows the published coordinator's requests.
    explorerUrl:
      vrfDefaults && vrfCoordinator.toLowerCase() === vrfDefaults.coordinator.toLowerCase() ? vrfDefaults.explorerUrl : null,
  },
};
export type Env = typeof env;
