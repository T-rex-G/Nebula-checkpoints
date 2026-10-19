'use strict';

/*
 * The digest of a built directory: every regular file, by its path relative to
 * the root and the SHA-256 of its bytes, in byte order of the path. The served
 * browser build (servedAssetsSha256) and the compiled server tree
 * (serverBuildSha256) are named this way, so two builds of the same source
 * compare by one value and the server can attest what it runs at startup.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function listFiles(root, what, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, what, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`unexpected entry in ${what}: ${relative}`);
  }
  return files;
}

function directoryDigest(root, what = 'the build') {
  const files = listFiles(root, what).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    const content = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    digest.update(`${file}\0${content}\n`);
  }
  return digest.digest('hex');
}

module.exports = Object.freeze({ directoryDigest, listFiles });
