'use strict';

/*
 * The LFS probe earns a Provider-verified claim for `lfs`, and that claim is
 * about the product's path, not about the protocol in general. A probe that
 * reached the store by some other route -- a different host, a different
 * scheme, a different batch body -- would prove GitHub works and leave the
 * product's LFS upload (the workbench's, in application/lfs.ts) unproven,
 * while the registry said otherwise.
 *
 * So the two are held together here. This is a source contract rather than a
 * behavioural test because the behaviour is only observable against a live
 * provider, and the thing that would silently drift is the request shape.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const lfsModule = read('apps/api/src/modules/workbench/application/lfs.ts');
const probe = read('ci/run-github-alpha17-validation.js');

const uploadStart = lfsModule.indexOf('  async function upload(');
assert(uploadStart >= 0, 'the workbench no longer has an LFS upload');
const productBody = lfsModule.slice(uploadStart, lfsModule.indexOf('\n  return { downloadStream, upload };', uploadStart));
assert(productBody.includes('info/lfs/objects/batch'), 'the LFS upload no longer reaches an LFS batch endpoint');

/*
 * The endpoint. Both must address the batch route the same way -- the LFS
 * store lives on the web host, not the API host, and a probe pointed at
 * api.github.com would 404 in a way that looks like a permission problem.
 */
for (const [name, source] of [['the LFS upload', productBody], ['the probe', probe]]) {
  assert(/\.git\/info\/lfs\/objects\/batch/.test(source),
    `${name} must address the LFS batch endpoint as <repo>.git/info/lfs/objects/batch`);
}

/*
 * The scheme. LFS authenticates Basic with the actor's login and the token as
 * the password; every other call in this codebase is Bearer. A probe that sent
 * Bearer here would be testing a request the product never makes.
 */
for (const [name, source] of [['the LFS upload', productBody], ['the probe', probe]]) {
  assert(/Basic \$\{/.test(source) || /Basic \$\{Buffer/.test(source),
    `${name} must authenticate the LFS batch with Basic`);
  assert(/application\/vnd\.git-lfs\+json/.test(source),
    `${name} must send and accept the git-lfs media type`);
}

/*
 * The batch body. `operation`, `transfers` and the `ref` are what the server
 * uses to decide whether the actor may write to that branch, and the object
 * list is what it answers about.
 */
for (const field of ["operation: 'upload'", "transfers: ['basic']", 'ref:', 'objects:']) {
  assert(productBody.includes(field), `the LFS upload no longer sends ${field}`);
  assert(probe.includes(field), `the probe must send ${field} exactly as the LFS upload does`);
}

/*
 * The upload. The product streams the file and sends the headers the batch
 * response handed back; a probe that dropped those headers would be refused by
 * the storage endpoint for a reason unrelated to the capability.
 */
assert(/Content-Type': 'application\/octet-stream'/.test(productBody), 'the LFS upload no longer PUTs octet-stream');
assert(/Content-Type': 'application\/octet-stream'/.test(probe), 'the probe must PUT octet-stream as the product does');
assert(/\.\.\.spread\(member\(uploadAction, 'header'\) \|\| \{\}\)/.test(productBody), 'the LFS upload no longer forwards the upload headers');
assert(/\.\.\.\(action\.header \|\| \{\}\)/.test(probe), 'the probe must forward the upload headers the batch returned');

/*
 * The behaviour the claim actually rests on. The LFS upload treats a missing
 * upload action as success -- the object is already stored -- and that branch
 * has never been observed from a provider. The probe exists to observe it, so
 * if the product stops depending on it the probe is proving something the
 * product no longer does.
 */
assert(/if \(uploadAction\) \{/.test(productBody),
  'the LFS upload no longer treats a withheld upload action as an already-stored object; the deduplication proof no longer describes it');
assert(/deduplicatedOnRepeat/.test(probe),
  'the probe must record whether the provider withheld the upload action on a repeat request');

/*
 * And the promise made to the reader: no pointer is committed. The probe reads
 * the branch head on both sides of the upload and reports whether it moved, so
 * this is measured rather than asserted in prose.
 */
/*
 * The object must be synthetic. A fixed payload would already be in the store
 * from the previous run, so the first batch would withhold the upload action
 * and `uploadOffered` would be false -- the run would fail, but only after the
 * fact and only against a provider with history. The fixture cannot catch it
 * at all, since its store starts empty every time, so the requirement is held
 * at the source.
 */
assert(/crypto\.randomBytes\(/.test(probe.slice(probe.indexOf('async function lfsChecks'))),
  'the LFS probe must build a synthetic object; a fixed payload is already stored after its first run');

assert(/pointerCommitted/.test(probe), 'the probe must report whether a pointer was committed');
assert(/headBefore/.test(probe) && /headAfter/.test(probe),
  'pointerCommitted must be measured from the branch head before and after, not assumed');

/*
 * The registry may not claim more than the probe proves. If `lfs` is
 * Provider-verified, the contract must require the probe that earns it.
 */
const registry = JSON.parse(read('config/public-alpha-capabilities.json'));
const lfs = registry.providers.github['hosted-alpha'].lfs;
const { PROVIDER_CAPABILITY_REQUIREMENTS } = require('../src/qualification-evidence');
if (lfs && lfs[1] === 'Provider-verified') {
  const required = (PROVIDER_CAPABILITY_REQUIREMENTS.github || {}).lfs || [];
  assert(required.includes('lfs-object-upload'),
    'github lfs is Provider-verified but the contract does not require the probe that would earn it');
}

console.log('lfs probe contract tests passed');
