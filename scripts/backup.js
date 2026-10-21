require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDb, closeDb, backupDb, userFile, getStats } = require('../lib/db');

function main() {
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
    const dbFile = path.resolve(process.env.DB_FILE || path.join(dataDir, 'gamefactory.db'));
    const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
    fs.mkdirSync(backupDir, { recursive: true });

    initDb({ file: dbFile, importLegacy: false });
    const stats = getStats();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `gamefactory-${stamp}.db`);
    backupDb(target);
    closeDb();

    const size = fs.statSync(target).size;
    console.log(`Бэкап готов: ${target} (${size} байт)`);
    console.log(`Пользователей: ${stats.users}, игр: ${stats.games}, платежей: ${stats.payments}`);
    console.log(`Исходная база: ${userFile || dbFile}`);
}

try {
    main();
} catch (error) {
    console.error('Не удалось сделать бэкап:', error.stack || error.message);
    process.exitCode = 1;
}
