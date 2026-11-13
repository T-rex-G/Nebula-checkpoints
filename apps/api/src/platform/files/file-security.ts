import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const BUILTIN_CHUNK_SIZE = 64 * 1024;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ScanMatch {
  readonly engine: 'builtin' | 'yara';
  readonly rule: string;
  readonly severity: 'critical';
  readonly path?: string;
}

export interface BuiltinScan {
  readonly available: true;
  readonly engine: 'builtin';
  readonly blocked: boolean;
  readonly matches: ScanMatch[];
}

export interface YaraScan {
  readonly available: boolean;
  readonly configured: boolean;
  readonly matches: ScanMatch[];
  readonly blocked?: boolean;
  readonly error?: string;
  readonly warnings?: string;
}

export interface UploadScan {
  readonly blocked: boolean;
  readonly matches: ScanMatch[];
  readonly builtin: BuiltinScan;
  readonly yara: YaraScan;
}

function boolEnv(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

export function scannerStatus(env: Environment = process.env) {
  const rulesPath = String(env.NV_YARA_RULES_PATH || '').trim();
  return {
    builtin: { available: true, engine: 'bounded-signature-gate', rules: ['EICAR_TEST_FILE'] },
    yara: {
      configured: !!rulesPath,
      required: boolEnv(env.NV_REQUIRE_YARA),
      binary: String(env.NV_YARA_BIN || 'yara'),
      rulesPath: rulesPath ? basename(rulesPath) : '',
      timeoutSeconds: Math.min(Math.max(parseInt(env.NV_YARA_TIMEOUT_SECONDS || '5', 10) || 5, 1), 30)
    }
  };
}

export function builtinScanBuffer(input: Uint8Array | string | null | undefined, context: { readonly repoPath?: unknown } = {}): BuiltinScan {
  const buffer = Buffer.isBuffer(input) ? input : typeof input === 'string' || !input ? Buffer.from(input || '') : Buffer.from(input);
  const matches: ScanMatch[] = [];
  if (buffer.indexOf(EICAR) >= 0) {
    matches.push({ engine: 'builtin', rule: 'EICAR_TEST_FILE', severity: 'critical', path: String(context.repoPath || '') });
  }
  return { available: true, engine: 'builtin', blocked: matches.length > 0, matches };
}

export async function builtinScanFile(filePath: string, context: { readonly repoPath?: unknown } = {}): Promise<BuiltinScan> {
  const stream = createReadStream(filePath, { highWaterMark: BUILTIN_CHUNK_SIZE });
  let overlap: Buffer = Buffer.alloc(0);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const candidate = overlap.length ? Buffer.concat([overlap, chunk]) : chunk;
    const result = builtinScanBuffer(candidate, context);
    if (result.blocked) {
      stream.destroy();
      return result;
    }
    const keep = Math.min(EICAR.length - 1, candidate.length);
    overlap = keep ? candidate.subarray(candidate.length - keep) : Buffer.alloc(0);
  }
  return { available: true, engine: 'builtin', blocked: false, matches: [] };
}

async function runYara(filePath: string, env: Environment): Promise<YaraScan> {
  const status = scannerStatus(env).yara;
  if (!status.configured) return { available: false, configured: false, matches: [], error: '' };
  const rulesPath = String(env.NV_YARA_RULES_PATH || '');
  let ruleStat;
  try { ruleStat = await stat(rulesPath); }
  catch { return { available: false, configured: true, matches: [], error: 'Configured YARA rules file is unavailable' }; }
  if (!ruleStat.isFile()) return { available: false, configured: true, matches: [], error: 'Configured YARA rules path is not a file' };
  try {
    const { stdout, stderr } = await execFileAsync(status.binary, [
      '-w', '-a', String(status.timeoutSeconds), '-l', '20', rulesPath, filePath
    ], {
      timeout: (status.timeoutSeconds + 2) * 1000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      shell: false,
      env: { PATH: process.env.PATH || '', LANG: 'C', LC_ALL: 'C' }
    });
    const matches: ScanMatch[] = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 20).map(line => ({
      engine: 'yara', rule: (line.split(/\s+/)[0] ?? '').slice(0, 128), severity: 'critical'
    }));
    return { available: true, configured: true, matches, blocked: matches.length > 0, warnings: String(stderr || '').trim().slice(0, 500) };
  } catch (error) {
    const failure = (error && typeof error === 'object' ? error : {}) as { readonly stderr?: unknown; readonly message?: unknown };
    return {
      available: false,
      configured: true,
      matches: [],
      blocked: false,
      error: String(error && (failure.stderr || failure.message) || 'YARA execution failed').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
    };
  }
}

/* The upload's size travels with the request; the scan reads the file itself. */
export async function scanUploadFile(filePath: string, options: { readonly env?: Environment; readonly repoPath?: unknown; readonly size?: number } = {}): Promise<UploadScan> {
  const env = options.env || process.env;
  const builtin = await builtinScanFile(filePath, { repoPath: options.repoPath });
  if (builtin.blocked) return { blocked: true, matches: builtin.matches, builtin, yara: { available: false, configured: false, matches: [] } };
  const yara = await runYara(filePath, env);
  if (!yara.available && scannerStatus(env).yara.required) {
    throw Object.assign(new Error(yara.error || 'YARA scanning is required but unavailable'), { status: 503, code: 'YARA_UNAVAILABLE' });
  }
  return { blocked: !!yara.blocked, matches: yara.matches || [], builtin, yara };
}
