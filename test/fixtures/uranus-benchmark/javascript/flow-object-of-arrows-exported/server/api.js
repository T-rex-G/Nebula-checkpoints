module.exports = {
  proxy: async (url) => { const r = await fetch(url); return r.json(); }, // expect: SEC-021
  ping: () => 'ok'
};
