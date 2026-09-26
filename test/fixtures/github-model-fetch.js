'use strict';

/*
 * Preloaded into a server under test: GitHub's REST API answered by the same
 * transcribed model the live-provider harness is falsified against, so a
 * route test and a probe disagree with GitHub in the same places or not at
 * all. Every other host goes to the real network, which a test never reaches.
 */

const { createProviderFetchFixture } = require('../../ci/alpha17-fixtures');

const realFetch = global.fetch;
const token = String(process.env.NV_GITHUB_MODEL_TOKEN || '');
const model = createProviderFetchFixture({
  provider: 'github',
  repository: 'Acme/Demo',
  defaultBranch: 'main',
  mutationCredential: token,
  readOnlyCredential: 'github-model-read-only'
});
global.__githubModel = model;

/* The files the route tests move around, committed through the contents API. */
const seeded = (async () => {
  for (const [filePath, text] of [
    ['a.txt', 'alpha\n'],
    ['b.txt', 'bravo\n'],
    ['docs/one.md', 'one\n'],
    ['docs/sub/two.md', 'two\n'],
    ['guides/one.md', 'already here\n']
  ]) {
    await model.fetch(`https://api.github.com/repos/Acme/Demo/contents/${filePath}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ branch: 'main', message: `seed ${filePath}`, content: Buffer.from(text).toString('base64') })
    });
  }
  /* A pull request with a real difference, for the merge precondition. */
  const head = model.state.branches.get('main').sha;
  const auth = { Authorization: `Bearer ${token}` };
  await model.fetch('https://api.github.com/repos/Acme/Demo/git/refs', {
    method: 'POST', headers: auth, body: JSON.stringify({ ref: 'refs/heads/feature', sha: head })
  });
  await model.fetch('https://api.github.com/repos/Acme/Demo/contents/feature.txt', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ branch: 'feature', message: 'feature', content: Buffer.from('feature\n').toString('base64') })
  });
  await model.fetch('https://api.github.com/repos/Acme/Demo/pulls', {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'Route test pull', head: 'feature', base: 'main', body: '' })
  });
})();

global.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname !== 'api.github.com') return realFetch(input, init);
  await seeded;
  return model.fetch(url.toString(), init);
};
