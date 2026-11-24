import { lineOf } from './audit-text.ts';
import type { RuleFile, RuleHit } from './line-rules.ts';

/* ---- Infrastructure -------------------------------------------------------------- */

/*
 * A Dockerfile's final stage: does it drop root, does it pull files straight
 * from the network, does it bake a secret into a layer. Earlier build stages
 * are thrown away, so only the stage that ships is held to the USER rule.
 */
export function dockerfileFindings(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
  const lines = file.text.split('\n');
  let finalFrom = 0;
  let user: { name: string; line: number } | null = null;
  let nonrootBase = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+#.*$/, '');
    const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
    if (from) {
      finalFrom = index + 1;
      user = null;
      nonrootBase = /nonroot|rootless|chainguard|distroless.*:nonroot/i.test(from[1] ?? '');
      continue;
    }
    const setUser = /^\s*USER\s+(\S+)/i.exec(line);
    if (setUser) user = { name: (setUser[1] ?? '').toLowerCase(), line: index + 1 };
    if (/^\s*ADD\s+(?!.*--checksum=)(?:--\S+\s+)*https?:\/\//i.test(line)) out.push({ rule: 'IAC-002', line: index + 1 });
    const secret = /^\s*(ENV|ARG)\s+([A-Za-z_][\w]*)(?:\s*=\s*|\s+)(\S+)/i.exec(line);
    const [, , variable = '', value = ''] = secret ?? [];
    if (secret && /(SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)/i.test(variable) &&
      !/^["']?\$|^["']?$/.test(value) && !/^(true|false|0|1)$/i.test(value)) out.push({ rule: 'IAC-003', line: index + 1 });
  }
  if (finalFrom && !nonrootBase && (!user || /^(root|0)(:|$)/.test(user.name))) {
    out.push({ rule: 'IAC-001', line: user ? user.line : finalFrom });
  }
  return out;
}

/* The blocks of an HCL file, each with the line it opens on and its text. */
function hclBlocks(text: string, name: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = [];
  const opener = new RegExp(`(^|\\n)\\s*${name}\\s*(=\\s*)?\\{`, 'g');
  for (const match of text.matchAll(opener)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    while (index < text.length && depth > 0) {
      if (text[index] === '{') depth += 1;
      else if (text[index] === '}') depth -= 1;
      index += 1;
    }
    out.push({ body: text.slice(start, index - 1), line: lineOf(text, match.index + (match[1] ?? '').length) });
  }
  return out;
}

const ADMIN_PORTS = new Set([22, 23, 3389, 5900, 3306, 5432, 1433, 1521, 6379, 11211, 27017, 9200, 5601, 2375, 2376]);

/*
 * Terraform, read as text: public bucket ACLs, admin and database ports open
 * to the whole internet, storage that is not encrypted, and databases given a
 * public address. Variables are not resolved -- a literal is judged, a
 * reference is left alone.
 */
export function terraformFindings(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
  const text = file.text;
  text.split('\n').forEach((line, index) => {
    const acl = /^\s*acl\s*=\s*"(public-read-write|public-read|authenticated-read)"/.exec(line);
    if (acl) out.push({ rule: 'IAC-005', line: index + 1, severity: acl[1] === 'public-read-write' ? 'critical' : 'serious' });
    if (/^\s*(encrypted|storage_encrypted|encrypt_at_rest|enable_encryption)\s*=\s*false\b/.test(line)) out.push({ rule: 'IAC-007', line: index + 1 });
    if (/^\s*publicly_accessible\s*=\s*true\b/.test(line)) out.push({ rule: 'IAC-008', line: index + 1 });
  });
  for (const block of [...hclBlocks(text, 'ingress'), ...hclBlocks(text, 'resource\\s+"aws_(vpc_)?security_group_(ingress_)?rule"\\s+"[^"]+"')]) {
    if (!/cidr_(blocks|ipv4|ipv6)\s*=\s*\[?\s*"(0\.0\.0\.0\/0|::\/0)"/.test(block.body)) continue;
    if (/\btype\s*=\s*"egress"/.test(block.body)) continue;
    const from = Number((/from_port\s*=\s*(\d+)/.exec(block.body) || [])[1]);
    const to = Number((/to_port\s*=\s*(\d+)/.exec(block.body) || [])[1] || from);
    const protocol = (/protocol\s*=\s*"([^"]+)"/.exec(block.body) || [])[1] || 'tcp';
    const everything = protocol === '-1' || protocol === 'all' || (from === 0 && to >= 65535);
    const hit = everything || [...ADMIN_PORTS].some(port => port >= from && port <= to);
    if (Number.isFinite(from) && hit) out.push({ rule: 'IAC-006', line: block.line });
  }
  return out;
}

/*
 * Kubernetes manifests and Compose files: a container that is privileged or
 * shares the node's network, process or IPC namespace, and one allowed to run
 * as root or to escalate. Workflows are read by their own rules.
 */
export function manifestFindings(file: RuleFile): RuleHit[] {
  const out: RuleHit[] = [];
  if (!/\b(apiVersion|kind|services|containers|securityContext|privileged)\s*:/.test(file.text)) return out;
  file.text.split('\n').forEach((line, index) => {
    const bare = line.replace(/\s+#.*$/, '');
    if (/^\s*(-\s+)?(privileged|hostNetwork|hostPID|hostIPC)\s*:\s*true\b/.test(bare) || /^\s*network_mode\s*:\s*["']?host["']?\s*$/.test(bare)) {
      out.push({ rule: 'IAC-009', line: index + 1 });
    }
    if (/^\s*(-\s+)?(allowPrivilegeEscalation\s*:\s*true|runAsUser\s*:\s*0|runAsNonRoot\s*:\s*false)\b/.test(bare)) {
      out.push({ rule: 'IAC-010', line: index + 1 });
    }
  });
  return out;
}
