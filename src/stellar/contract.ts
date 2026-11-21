import {
  Account,
  BASE_FEE,
  contract,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';

/** On chain campaign, as returned by the contract's `get_campaign`. */
export interface ChainCampaign {
  id: bigint;
  creator: string;
  beneficiary: string;
  verifier: string;
  kind: 'emergency' | 'climate';
  metadataUri: string;
  goal: bigint;
  deadline: bigint;
  milestones: bigint[];
  milestonesReleased: number;
  raised: bigint;
  released: bigint;
  status: 'active' | 'completed' | 'cancelled';
}

export interface ContractReader {
  getCampaign(id: bigint): Promise<ChainCampaign>;
}

/** The write side of the contract, used by the TTL keeper. */
export interface ContractTtlExtender {
  extendCampaignTtl(id: bigint): Promise<void>;
}

export class AidlineContract implements ContractReader, ContractTtlExtender {
  private readonly contract: Contract;

  constructor(
    private readonly server: rpc.Server,
    contractId: string,
    private readonly networkPassphrase: string,
    private readonly keeper?: Keypair,
  ) {
    this.contract = new Contract(contractId);
  }

  async getCampaign(id: bigint): Promise<ChainCampaign> {
    const raw = await this.read('get_campaign', nativeToScVal(id, { type: 'u64' }));
    return parseCampaign(raw);
  }

  /**
   * #22: bumps the storage TTL of one campaign. Unlike `read`, this is a real
   * transaction: it needs a funded source account and is signed by the keeper
   * key loaded from the environment.
   */
  async extendCampaignTtl(id: bigint): Promise<void> {
    if (!this.keeper) throw new Error('AIDLINE_KEEPER_SECRET is not configured');
    const source = await this.server.getAccount(this.keeper.publicKey());
    const raw = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call('extend_campaign_ttl', nativeToScVal(id, { type: 'u64' })))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(raw);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`extend_campaign_ttl failed: ${sim.error}`);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      // The entry has already expired and needs a restore operation first. The
      // keeper deliberately bumps well before that point, so treat it as an
      // operator-visible error instead of silently skipping a campaign.
      throw new Error(`extend_campaign_ttl(${id}) needs a restore, entry has expired`);
    }

    const tx = rpc.assembleTransaction(raw, sim).build();
    tx.sign(this.keeper);
    const sent = await this.server.sendTransaction(tx);
    if (sent.status !== 'PENDING') {
      throw new Error(`extend_campaign_ttl(${id}) was rejected: ${sent.status}`);
    }
  }

  private async read(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    // Read only calls are simulated, so the source account never needs to exist.
    const tx = new TransactionBuilder(new Account(contract.NULL_ACCOUNT, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`${method} failed: ${sim.error}`);
    }
    if (!sim.result) throw new Error(`${method} returned no result`);
    return scValToNative(sim.result.retval);
  }
}

// Unit enum variants decode as a one element array, for example ['Emergency'].
function variant(value: unknown): string {
  const name = Array.isArray(value) ? value[0] : value;
  return String(name).toLowerCase();
}

export function parseCampaign(raw: unknown): ChainCampaign {
  const c = raw as Record<string, unknown>;
  return {
    id: BigInt(c.id as bigint),
    creator: String(c.creator),
    beneficiary: String(c.beneficiary),
    verifier: String(c.verifier),
    kind: variant(c.kind) as ChainCampaign['kind'],
    metadataUri: String(c.metadata_uri),
    goal: BigInt(c.goal as bigint),
    deadline: BigInt(c.deadline as bigint),
    milestones: (c.milestones as bigint[]).map((m) => BigInt(m)),
    milestonesReleased: Number(c.milestones_released),
    raised: BigInt(c.raised as bigint),
    released: BigInt(c.released as bigint),
    status: variant(c.status) as ChainCampaign['status'],
  };
}
