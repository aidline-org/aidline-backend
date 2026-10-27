import { Networks } from '@stellar/stellar-sdk';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('postgres://aidline:aidline@localhost:5433/aidline'),
  AIDLINE_NETWORK: z.enum(['testnet', 'mainnet', 'futurenet']).default('testnet'),
  AIDLINE_RPC_URL: z.url().default('https://soroban-testnet.stellar.org'),
  AIDLINE_CONTRACT_ID: z.string().default(''),
  AIDLINE_TOKEN_ID: z.string().default(''),
  INDEXER_START_LEDGER: z.coerce.number().int().optional(),
  INDEXER_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  INDEXER_ENABLED: bool,
  METRICS_ENABLED: bool,
  UPLOAD_DIR: z.string().default('uploads'),
});

export type Config = z.infer<typeof schema> & { networkPassphrase: string; corsOrigins: string[] };

const passphrases = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings in .env as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.parse(cleaned);
  return {
    ...parsed,
    PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL.replace(/\/$/, ''),
    networkPassphrase: passphrases[parsed.AIDLINE_NETWORK],
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()),
  };
}
