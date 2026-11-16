class InvoiceService {
  async getInvoice(id) {
    return prisma.invoice.findUnique({ where: { id } });
  }
}
module.exports = { InvoiceService };
