exports.fetchThing = id => prisma.thing.findUnique({ where: { id } });
