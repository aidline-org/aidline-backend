import { Networks } from '@stellar/stellar-sdk';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('true')
  .transform((v) => v === 'true');

const falseBool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
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

  // Proof storage. `local` is the default; `s3` works with any S3 compatible provider.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  S3_SESSION_TOKEN: z.string().default(''),
  S3_FORCE_PATH_STYLE: bool,

  // GDACS disaster alert feed poller.
  GDACS_ENABLED: bool,
  GDACS_FEED_URL: z.url().default('https://www.gdacs.org/xml/rss.xml'),
  GDACS_POLL_MS: z.coerce.number().int().min(60_000).default(300_000),

  // Live event stream (GET /events). Heartbeats keep idle connections open through proxies.
  STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).default(100),
  STREAM_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),

  // Webhook delivery worker.
  WEBHOOK_POLL_MS: z.coerce.number().int().min(1000).default(5000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  WEBHOOK_ALLOW_PRIVATE_URLS: falseBool,
});

export type Config = z.infer<typeof schema> & {
  networkPassphrase: string;
  corsOrigins: string[] | true;
};

const passphrases = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
} as const;

function parseCorsOrigins(value: string): string[] {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${entry}`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== entry) {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${entry}`);
    }
  }
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings in .env as unset so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.parse(cleaned);
  if (
    parsed.STORAGE_DRIVER === 's3' &&
    (!parsed.S3_BUCKET || !parsed.S3_ACCESS_KEY_ID || !parsed.S3_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_DRIVER=s3',
    );
  }
  if (parsed.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!parsed.AIDLINE_CONTRACT_ID) missing.push('AIDLINE_CONTRACT_ID');
    if (!parsed.AIDLINE_TOKEN_ID) missing.push('AIDLINE_TOKEN_ID');
    if (missing.length > 0) {
      throw new Error(`${missing.join(' and ')} must be set when NODE_ENV=production`);
    }
  }
  const corsValue = parsed.CORS_ORIGINS.trim();
  return {
    ...parsed,
    PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL.replace(/\/$/, ''),
    networkPassphrase: passphrases[parsed.AIDLINE_NETWORK],
    corsOrigins: corsValue === '*' ? true : parseCorsOrigins(corsValue),
  };
}
