import { describe, expect, it } from 'vitest';

import { metadataIdFromUri, proofIdFromUri } from '../src/lib/uris.js';

// #14: unit tests for URI helpers

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('metadataIdFromUri', () => {
  it('extracts a UUID from a well-formed metadata URI', () => {
    expect(metadataIdFromUri(`http://api.test/metadata/${UUID}`)).toBe(UUID);
  });

  it('is case-insensitive', () => {
    expect(metadataIdFromUri(`http://api.test/metadata/${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it('returns null for a proof URI', () => {
    expect(metadataIdFromUri(`http://api.test/proofs/${UUID}`)).toBeNull();
  });

  it('returns null for an IPFS URI', () => {
    expect(metadataIdFromUri('ipfs://bafy1234')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(metadataIdFromUri('')).toBeNull();
  });

  it('does not match if UUID is not at the end', () => {
    expect(metadataIdFromUri(`http://api.test/metadata/${UUID}/extra`)).toBeNull();
  });
});

describe('proofIdFromUri', () => {
  it('extracts a UUID from a well-formed proof URI', () => {
    expect(proofIdFromUri(`http://api.test/proofs/${UUID}`)).toBe(UUID);
  });

  it('is case-insensitive', () => {
    expect(proofIdFromUri(`http://api.test/proofs/${UUID.toUpperCase()}`)).toBe(UUID);
  });

  it('returns null for a metadata URI', () => {
    expect(proofIdFromUri(`http://api.test/metadata/${UUID}`)).toBeNull();
  });

  it('returns null for an IPFS URI', () => {
    expect(proofIdFromUri('ipfs://bafy1234')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(proofIdFromUri('')).toBeNull();
  });
});
