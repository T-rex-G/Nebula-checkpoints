exports.settingsOf = id => prisma.settings.findUnique({ where: { userId: id } });
