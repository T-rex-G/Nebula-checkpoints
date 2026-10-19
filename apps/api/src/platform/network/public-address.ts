import { isIP } from 'node:net';

/*
 * Which addresses this server may open a connection to on somebody else's
 * behalf: public unicast only. Private, loopback, link-local, carrier-grade
 * NAT, documentation, benchmarking, multicast and reserved ranges are refused,
 * and an IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
 *
 * The policy began inside the governance webhook model, which needed it first;
 * every outbound path (the guarded transport, the webhook destination
 * check) now reads it from here, so the platform's transport does not depend
 * on one product module's internals.
 */

type Ipv6Words = readonly [number, number, number, number, number, number, number, number];

function ipv4Number(address: string): number | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  const [a, b, c, d] = parts as [number, number, number, number];
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function inV4(value: number, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === ((ipv4Number(base) ?? 0) & mask);
}

function expandIpv6(address: unknown): Ipv6Words | null {
  let text = String(address || '').toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);
  if (text.includes('.')) {
    const last = text.lastIndexOf(':');
    const v4 = ipv4Number(text.slice(last + 1));
    if (v4 == null) return null;
    text = `${text.slice(0, last)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const pieces: string[] = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (pieces.length !== 8 || pieces.some(piece => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
  return pieces.map(piece => parseInt(piece, 16)) as unknown as Ipv6Words;
}

const BLOCKED_V4: readonly (readonly [base: string, prefix: number])[] = Object.freeze([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]);

export function isPublicAddress(addressInput: unknown): boolean {
  const address = String(addressInput || '').trim();
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    if (value == null) return false;
    return !BLOCKED_V4.some(([base, prefix]) => inV4(value, base, prefix));
  }
  if (family === 6) {
    const parts = expandIpv6(address);
    if (!parts) return false;
    const allZero = parts.every(part => part === 0);
    if (allZero || (parts.slice(0, 7).every(part => part === 0) && parts[7] === 1)) return false;
    if ((parts[0] & 0xfe00) === 0xfc00) return false;
    if ((parts[0] & 0xffc0) === 0xfe80) return false;
    if ((parts[0] & 0xff00) === 0xff00) return false;
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false;
    if (parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) {
      const v4 = `${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`;
      return isPublicAddress(v4);
    }
    return true;
  }
  return false;
}
