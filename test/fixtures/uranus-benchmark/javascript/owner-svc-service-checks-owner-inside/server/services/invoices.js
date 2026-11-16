exports.getChecked = async (id, user) => {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || invoice.ownerId !== user.id) throw new Error('not found');
  return invoice;
};
