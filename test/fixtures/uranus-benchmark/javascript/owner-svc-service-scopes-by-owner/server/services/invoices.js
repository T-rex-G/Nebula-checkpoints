exports.getInvoiceFor = (userId, id) => prisma.invoice.findFirst({ where: { id, ownerId: userId } });
