exports.sendReminder = id => queue.add('remind', { id });
