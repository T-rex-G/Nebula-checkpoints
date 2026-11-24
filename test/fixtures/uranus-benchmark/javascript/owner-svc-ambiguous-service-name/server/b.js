exports.fetchThing = (id, owner) => prisma.thing.findFirst({ where: { id, owner } });
