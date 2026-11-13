/*
 * Git's own objects and wire protocol, for a native push: a blob, the trees
 * above it and a commit, hashed as Git hashes them and packed in a version 2
 * pack; the receive-pack request that moves a branch from the head it was
 * advertised at to the new commit; and the report that says whether it moved.
 *
 * Tree entries come from the provider's answer, so their fields are read as
 * they come, and ordered and written exactly as JavaScript always ordered and
 * wrote them.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/* A tree entry: its mode, its name in the tree, and the object it names. */
export interface TreeEntry {
  readonly mode: unknown;
  readonly name: unknown;
  readonly sha: unknown;
}
/* One level of the path a file is pushed to, from the root down. */
export interface TreeLevel {
  readonly entries: readonly TreeEntry[];
}
export type ObjectType = 'commit' | 'tree' | 'blob';
export interface GitObject {
  readonly type: ObjectType;
  readonly buf: Buffer;
  readonly sha: string;
}

export function pktLine(value: Buffer | string): Buffer {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}

/* A packet stream's packets; a flush packet is null. */
export function parsePkts(buf: Buffer): (Buffer | null)[] {
  const out: (Buffer | null)[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (!len) { out.push(null); i += 4; continue; }
    out.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return out;
}

/* The head a receive-pack advertisement names for a ref, or null. */
export function parseAdvert(buf: Buffer, ref: string): string | null {
  let old: string | null = null;
  for (const pk of parsePkts(buf)) {
    if (!pk) continue;
    const line = pk.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('#')) continue;
    const noCaps = line.split('\0')[0] ?? '';
    if (noCaps.indexOf(' ') !== 40) continue;
    if (noCaps.slice(41) === ref) old = noCaps.slice(0, 40);
  }
  return old;
}

export function gitHashObj(type: ObjectType, buf: Buffer): string {
  return crypto.createHash('sha1').update(Buffer.from(`${type} ${buf.length}\0`)).update(buf).digest('hex');
}

const PACK_TYPE: Readonly<Record<ObjectType, number>> = Object.freeze({ commit: 1, tree: 2, blob: 3 });

export function packEncode(objs: readonly GitObject[]): Buffer {
  const chunks: Buffer[] = [Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2])];
  const n = Buffer.alloc(4);
  n.writeUInt32BE(objs.length);
  chunks.push(n);
  for (const o of objs) {
    let size = o.buf.length;
    const head = [(PACK_TYPE[o.type] << 4) | (size & 15)];
    size >>= 4;
    while (size) {
      head[head.length - 1] = (head[head.length - 1] ?? 0) | 0x80;
      head.push(size & 127);
      size >>= 7;
    }
    chunks.push(Buffer.from(head), zlib.deflateSync(o.buf));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}

/* `value + '/'` and `${value}` for a value read from JSON: its text, as JavaScript makes it. */
function asText(value: unknown): string {
  return String(value);
}
/* `a < b` for values read from JSON, as JavaScript compares them: two texts by code unit, anything else by number. */
function lessThan(a: unknown, b: unknown): boolean {
  const primitive = (value: unknown): unknown => (typeof value === 'object' && value !== null ? String(value) : value);
  const pa = primitive(a);
  const pb = primitive(b);
  if (typeof pa === 'string' && typeof pb === 'string') return pa < pb;
  return Number(pa) < Number(pb);
}
/* `Buffer.from(value, 'hex')`, called as JavaScript calls it on an entry's object id. */
function fromHex(value: unknown): Buffer {
  const decoded: unknown = Reflect.apply(Buffer.from, Buffer, [value, 'hex']);
  if (!Buffer.isBuffer(decoded)) throw new TypeError('Buffer.from did not answer a Buffer');
  return decoded;
}

export function treeEncode(entries: readonly TreeEntry[]): Buffer {
  const key = (e: TreeEntry): unknown => (e.mode === '40000' ? `${asText(e.name)}/` : e.name);
  return Buffer.concat([...entries]
    .sort((a, b) => (lessThan(key(a), key(b)) ? -1 : lessThan(key(b), key(a)) ? 1 : 0))
    .map(e => Buffer.concat([Buffer.from(`${asText(e.mode)} ${asText(e.name)}\0`), fromHex(e.sha)])));
}

export function commitEncode(tree: string, parent: unknown, message: unknown, name: unknown, email: unknown, now: () => number = Date.now): Buffer {
  const ts = Math.floor(now() / 1000);
  const id = `${asText(name)} <${asText(email)}> ${ts} +0000`;
  return Buffer.from(`tree ${tree}\n${parent ? `parent ${asText(parent)}\n` : ''}author ${id}\ncommitter ${id}\n\n${asText(message)}\n`);
}

/* The blob, the trees above it and the commit that put one file at a path. */
export function buildPushObjects(fileBuf: Buffer, filePath: string, levels: readonly TreeLevel[], parentSha: unknown, message: unknown, name: unknown, email: unknown, now: () => number = Date.now): { readonly objs: GitObject[]; readonly commitSha: string; readonly blobSha: string } {
  const parts = filePath.split('/');
  const fname = parts.pop();
  const blobSha = gitHashObj('blob', fileBuf);
  const objs: GitObject[] = [{ type: 'blob', buf: fileBuf, sha: blobSha }];
  const last = levels[levels.length - 1];
  if (last === undefined) throw new TypeError("Cannot read properties of undefined (reading 'entries')");
  const prior = (last.entries || []).find(e => e.name === fname);
  if (prior && (prior.mode === '120000' || prior.mode === '160000')) {
    throw new Error('Refusing to overwrite a symlink or submodule entry — remove it first');
  }
  let childSha = blobSha;
  let childName: unknown = fname;
  let childMode: unknown = (prior && prior.mode) || '100644';
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (level === undefined) throw new TypeError("Cannot read properties of undefined (reading 'entries')");
    const entries = level.entries.filter(e => e.name !== childName);
    entries.push({ mode: childMode, name: childName, sha: childSha });
    const buf = treeEncode(entries);
    childSha = gitHashObj('tree', buf);
    objs.push({ type: 'tree', buf, sha: childSha });
    childMode = '40000';
    childName = parts[i - 1];
  }
  const cbuf = commitEncode(childSha, parentSha, message, name, email, now);
  const commitSha = gitHashObj('commit', cbuf);
  objs.push({ type: 'commit', buf: cbuf, sha: commitSha });
  return { objs, commitSha, blobSha };
}

export function buildReceiveBody(oldSha: string, newSha: string, branch: string, pack: Buffer): Buffer {
  return Buffer.concat([
    pktLine(`${oldSha} ${newSha} refs/heads/${branch}\0report-status agent=nebulaverse/4.6.0`),
    Buffer.from('0000'),
    pack
  ]);
}

export interface PushReport {
  readonly unpackOk: boolean;
  readonly okRef: boolean;
  readonly err: string | null;
  readonly lines: readonly string[];
}
export function parseReport(buf: Buffer, branch: string): PushReport {
  /* Every packet but a flush: a Buffer, even an empty one, is truthy. */
  const lines = parsePkts(buf).filter((packet): packet is Buffer => packet !== null).map(b => b.toString('utf8').replace(/\n$/, ''));
  return {
    unpackOk: lines.includes('unpack ok'),
    okRef: lines.includes(`ok refs/heads/${branch}`),
    err: (lines.find(l => l.startsWith('ng ')) || '').replace(/^ng \S+ ?/, '') || null,
    lines
  };
}
