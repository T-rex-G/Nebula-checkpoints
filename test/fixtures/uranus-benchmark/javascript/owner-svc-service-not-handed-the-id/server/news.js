exports.currentNotice = locale => prisma.notice.findFirst({ where: { locale, published: true } });
