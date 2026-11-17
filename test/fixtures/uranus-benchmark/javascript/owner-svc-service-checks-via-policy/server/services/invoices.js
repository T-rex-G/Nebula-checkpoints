exports.readInvoice = async (id, user) => {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  await authorize(user, 'read', invoice);
  return invoice;
};
