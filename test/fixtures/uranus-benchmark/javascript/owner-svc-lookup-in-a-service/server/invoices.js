exports.byId = id => prisma.invoice.findUnique({ where: { id } });
