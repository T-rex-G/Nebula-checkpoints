exports.noteFor = (who, id) => prisma.note.findFirst({ where: { id, accountRef: who } });
