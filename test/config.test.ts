import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses development defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      PORT: 4000,
      HOST: '0.0.0.0',
      PUBLIC_BASE_URL: 'http://localhost:4000',
      AIDLINE_NETWORK: 'testnet',
      AIDLINE_RPC_URL: 'https://soroban-testnet.stellar.org',
      AIDLINE_CONTRACT_ID: '',
      INDEXER_POLL_MS: 5000,
      INDEXER_ENABLED: true,
      METRICS_ENABLED: true,
      UPLOAD_DIR: 'uploads',
    });
    expect(config.INDEXER_START_LEDGER).toBeUndefined();
  });

  it('treats empty strings like unset variables so the defaults apply', () => {
    const config = loadConfig({ PORT: '', AIDLINE_NETWORK: '', INDEXER_POLL_MS: '' });
    expect(config.PORT).toBe(4000);
    expect(config.AIDLINE_NETWORK).toBe('testnet');
    expect(config.INDEXER_POLL_MS).toBe(5000);
  });

  it('removes a trailing slash from PUBLIC_BASE_URL', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://api.example.org/' }).PUBLIC_BASE_URL).toBe(
      'https://api.example.org',
    );
  });

  it('splits CORS_ORIGINS on commas and trims spaces', () => {
    const config = loadConfig({ CORS_ORIGINS: 'https://a.example, https://b.example ,http://c' });
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example', 'http://c']);
  });

  it('picks the network passphrase that matches AIDLINE_NETWORK', () => {
    expect(loadConfig({ AIDLINE_NETWORK: 'testnet' }).networkPassphrase).toBe(Networks.TESTNET);
    expect(loadConfig({ AIDLINE_NETWORK: 'mainnet' }).networkPassphrase).toBe(Networks.PUBLIC);
    expect(loadConfig({ AIDLINE_NETWORK: 'futurenet' }).networkPassphrase).toBe(Networks.FUTURENET);
  });

  it('parses numbers and booleans from strings', () => {
    const config = loadConfig({
      PORT: '8080',
      INDEXER_POLL_MS: '2500',
      INDEXER_START_LEDGER: '123456',
      INDEXER_ENABLED: 'false',
      METRICS_ENABLED: 'false',
    });
    expect(config.PORT).toBe(8080);
    expect(config.INDEXER_POLL_MS).toBe(2500);
    expect(config.INDEXER_START_LEDGER).toBe(123456);
    expect(config.INDEXER_ENABLED).toBe(false);
    expect(config.METRICS_ENABLED).toBe(false);
  });

  it('rejects an unknown network', () => {
    expect(() => loadConfig({ AIDLINE_NETWORK: 'devnet' })).toThrow();
  });

  it('rejects a poll interval below one second', () => {
    expect(() => loadConfig({ INDEXER_POLL_MS: '999' })).toThrow();
  });

  it('rejects a PUBLIC_BASE_URL that is not a URL', () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'not a url' })).toThrow();
  });

  it('rejects a boolean flag that is not true or false', () => {
    expect(() => loadConfig({ INDEXER_ENABLED: 'yes' })).toThrow();
  });
});
