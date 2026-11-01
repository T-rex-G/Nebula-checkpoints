/*
 * The evidence chain: each repository's records, hashed one onto the next
 * from a fixed genesis, in nv_evidence_chain.
 *
 * A record is appended under the repository's advisory lock, so two writers
 * never chain onto the same predecessor. A record already written (the same
 * repository, kind and record id) is answered with what was written and marked
 * deduplicated, never chained twice. Its hash is keyed with the ledger's own
 * key (domain/evidence-ledger.ts).
 *
 * Verification walks the chain from the start, at most 5,000 records, and
 * says whether what it walked is the whole chain. A record that does not
 * verify stops the walk at that record; where it would verify under the
 * session key the ledger used before its key was separated by purpose, the
 * answer says the chain needs migrating, not that it was tampered with.
 * Records still kept under a retired key verify and are counted. Without a
 * database there is no chain: nothing is appended, and verification says the
 * chain is unavailable.
 */
import { hashJson } from '../../../platform/values/stable-hash.ts';
import { evidenceRecordHash, verifyEvidenceRecord, type Keyring } from '../domain/evidence-ledger.ts';

export const EVIDENCE_GENESIS = 'NEBULAVERSE-EVIDENCE-GENESIS-V2';
export const EVIDENCE_VERIFY_LIMIT = 5000;

type Rows = { readonly rows: readonly Record<string, unknown>[] };

interface Client {
  query(text: string, values?: readonly unknown[]): Promise<Rows>;
  release(): void;
}

export interface EvidenceChainDeps {
  readonly ready: () => Promise<boolean>;
  readonly pool: () => {
    query(text: string, values?: readonly unknown[]): Promise<Rows>;
    connect(): Promise<Client>;
  };
  /* The ledger's own key, that new records are hashed with. */
  readonly ledgerSecret: unknown;
  /* The keys a record verifies under: the ledger's, then the retired ones. */
  readonly keyring: Keyring;
  /* The session key the ledger used before, to recognise a chain that needs migrating. */
  readonly legacyProbe: Keyring;
  /* Whether records under the session key are accepted as they are. */
  readonly legacyAccepted: boolean;
}

interface ChainRow {
  readonly seq: unknown;
  readonly kind: unknown;
  readonly record_id: unknown;
  readonly previous_hash: unknown;
  readonly record_hash: unknown;
  readonly payload_hash: unknown;
  readonly created_at: unknown;
}

export function createEvidenceChain(deps: EvidenceChainDeps) {
  async function appendEvidence(repoK: string, kind: string, recordId: string, payload: unknown) {
    if (!(await deps.ready())) return null;
    const client = await deps.pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [repoK]);
      const existing = await client.query(
        `SELECT seq,created_at,previous_hash,record_hash,payload_hash FROM nv_evidence_chain
       WHERE repo_key=$1 AND kind=$2 AND record_id=$3 ORDER BY seq ASC LIMIT 1`,
        [repoK, kind, recordId]
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { ...existing.rows[0], deduplicated: true };
      }
      const prev = await client.query('SELECT record_hash FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq DESC LIMIT 1', [repoK]);
      const previousHash = (prev.rows[0] && prev.rows[0].record_hash || EVIDENCE_GENESIS) as string;
      const payloadHash = hashJson(payload);
      const recordHash = evidenceRecordHash(deps.ledgerSecret, previousHash, repoK, kind, recordId, payloadHash);
      const out = await client.query(
        `INSERT INTO nv_evidence_chain(repo_key,kind,record_id,previous_hash,record_hash,payload_hash)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING seq,created_at`,
        [repoK, kind, recordId, previousHash, recordHash, payloadHash]
      );
      await client.query('COMMIT');
      return { ...out.rows[0], previousHash, recordHash, payloadHash };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function verifyEvidenceChain(repoK: string, limit = 1000) {
    if (!(await deps.ready())) return { available: false, valid: false, complete: false, checked: 0, total: 0 };
    const capped = Math.min(Math.max(limit, 1), EVIDENCE_VERIFY_LIMIT);
    const [r, count] = await Promise.all([
      deps.pool().query(
        'SELECT seq,kind,record_id,previous_hash,record_hash,payload_hash,created_at FROM nv_evidence_chain WHERE repo_key=$1 ORDER BY seq ASC LIMIT $2',
        [repoK, capped]
      ),
      deps.pool().query('SELECT count(*)::int AS total FROM nv_evidence_chain WHERE repo_key=$1', [repoK])
    ]);
    const rows = r.rows as unknown as readonly ChainRow[];
    const total = count.rows[0] ? Number(count.rows[0].total || 0) : 0;
    let previousHash: unknown = EVIDENCE_GENESIS;
    /* Records written before the hashing key was separated by purpose still
       verify, under the retired key, and are counted so the export can say so. */
    let legacyRecords = 0;
    for (const row of rows) {
      const check = verifyEvidenceRecord(
        deps.keyring, row.record_hash, previousHash, repoK, row.kind, row.record_id, row.payload_hash
      );
      if (check.legacy) legacyRecords += 1;
      if (row.previous_hash !== previousHash || !check.valid) {
        /* Distinguish an unmigrated pre-separation chain from real tampering. */
        const legacyKeyRequired = !deps.legacyAccepted &&
          row.previous_hash === previousHash &&
          verifyEvidenceRecord(
            deps.legacyProbe, row.record_hash, previousHash, repoK,
            row.kind, row.record_id, row.payload_hash
          ).valid;
        return {
          available: true, valid: false, complete: rows.length === total,
          checked: rows.indexOf(row) + 1, total, failedAt: row.seq, legacyRecords,
          legacyKeyRequired,
          records: rows
        };
      }
      previousHash = row.record_hash;
    }
    return { available: true, valid: true, complete: rows.length === total, checked: rows.length, total, head: previousHash, legacyRecords, legacyKeyRequired: false, records: rows };
  }

  return { appendEvidence, verifyEvidenceChain };
}

export type EvidenceChain = ReturnType<typeof createEvidenceChain>;
