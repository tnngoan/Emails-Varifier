import { Pool, PoolClient } from 'pg';
import { config } from '../config/index.js';

// ─── Singleton connection pool ────────────────────────────────────────────────
// pg.Pool manages a set of persistent connections, reusing them across queries.
// The pool is safe to import multiple times — Node's module cache ensures one
// instance exists per process.
let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: config.db.url,
      min: config.db.poolMin,
      max: config.db.poolMax,
      // Kill idle connections after 30 s to avoid resource leaks
      idleTimeoutMillis: 30_000,
      // Fail fast if we can't connect within 10 s
      connectionTimeoutMillis: 10_000,
    });

    _pool.on('error', (err) => {
      console.error('[DB] Unexpected pool error:', err);
    });
  }
  return _pool;
}

// ─── Convenience query helper ─────────────────────────────────────────────────
export async function query<T extends object = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query<T>(sql, params);
  return result.rows;
}

// ─── Transaction helper ───────────────────────────────────────────────────────
// Wraps a callback in BEGIN/COMMIT/ROLLBACK so callers don't need to.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
