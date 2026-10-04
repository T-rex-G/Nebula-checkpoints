const fastify = require('fastify')();
const fs = require('fs/promises');
fastify.get('/docs', async (request, reply) => {
  return fs.readFile('/srv/docs/' + request.query.page, 'utf8'); // expect: SEC-022
});
fastify.listen({ port: 3000 });
