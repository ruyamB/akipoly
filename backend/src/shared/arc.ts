/**
 * Arc network table, shared by the backend and the web client.
 * Dependency-free on purpose so the frontend can import it without pulling
 * server code. Source: https://docs.arc.io/arc/references/connect-to-arc
 */

export type ArcNetwork = 'testnet' | 'mainnet';

/** USDC ERC-20 interface on Arc uses 6 decimals (native gas view uses 18). */
export const USDC_DECIMALS = 6;

export interface ArcNetworkConfig {
  network: ArcNetwork;
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  /** ERC-20 interface over native USDC. Same address on both networks. */
  usdc: `0x${string}`;
  /** Where to get test funds; null on mainnet. */
  faucetUrl: string | null;
  /**
   * Hosted Arc VRF (https://arcvrf.007575.xyz/docs) that draws every ball.
   * null where it isn't deployed yet: set VRF_COORDINATOR_ADDRESS/VRF_KEY_HASH.
   */
  vrf: ArcVrfConfig | null;
}

export interface ArcVrfConfig {
  /** Subscription coordinator: AkipolyRounds requests through it. */
  coordinator: `0x${string}`;
  /** Pass in every request. */
  keyHash: `0x${string}`;
  /** Public proof pages live at `${explorerUrl}/requests/<requestId>`. */
  explorerUrl: string;
}

export const ARC_NETWORKS: Record<ArcNetwork, ArcNetworkConfig> = {
  testnet: {
    network: 'testnet',
    chainId: 5042002,
    name: 'Arc Testnet',
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorerUrl: 'https://explorer.testnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    faucetUrl: 'https://faucet.circle.com/',
    vrf: {
      coordinator: '0xe852aab2d5c609b89ea2b39e1451608d8649827a',
      keyHash: '0xcf39e27191d1d13c8fec1a175eda831392ef974fe21a5a0a0680c3a22c6deb88',
      explorerUrl: 'https://arcvrf.007575.xyz',
    },
  },
  mainnet: {
    network: 'mainnet',
    chainId: 5042,
    name: 'Arc',
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorerUrl: 'https://explorer.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    faucetUrl: null,
    vrf: null,
  },
};

export function isArcNetwork(value: unknown): value is ArcNetwork {
  return value === 'testnet' || value === 'mainnet';
}
