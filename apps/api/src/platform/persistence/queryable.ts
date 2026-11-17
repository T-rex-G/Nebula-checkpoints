/*
 * The part of a pg pool, or of a client checked out of one, that the stores
 * use: one parameterised query and what it answers. Typed this narrowly so a
 * store can be driven by a fake in tests without pretending to be a pool.
 */
export interface QueryOutcome {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<QueryOutcome>;
}

/* The driver's error code, when the failure carries one: PostgreSQL's SQLSTATE or a Node system code. */
export function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' ? (error as { readonly code?: unknown }).code : undefined;
}

/* A row as the driver returns it: named columns, values to be read and checked. */
export type Row = Readonly<Record<string, unknown>>;

/* A client checked out of a pool for one transaction, then given back. */
export interface PoolClient extends Queryable {
  release(): void;
}

/* A pool a store can both query and open a transaction on. */
export interface TransactionalPool extends Queryable {
  connect(): Promise<PoolClient>;
}
