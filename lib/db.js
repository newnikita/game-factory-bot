const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbFile = null;
let txDepth = 0;
let config = {
    startBalance: 50,
    adminIds: [],
    rewardPerRef: 50,
    referralsPerMonth: 10,
    legacyUsersFile: path.join(__dirname, '..', 'users.json')
};

function getDb() {
    if (!db) throw new Error('База данных не инициализирована');
    return db;
}

function withTransaction(fn) {
    const database = getDb();
    if (txDepth > 0) return fn();
    database.exec('BEGIN IMMEDIATE');
    txDepth += 1;
    try {
        const result = fn();
        database.exec('COMMIT');
        return result;
    } catch (error) {
        try { database.exec('ROLLBACK'); } catch (rollbackError) { /* ignore */ }
        throw error;
    } finally {
        txDepth -= 1;
    }
}

function mapUser(row) {
    if (!row) return null;
    return {
        telegramId: Number(row.telegram_id),
        username: row.username,
        firstName: row.first_name,
        language: row.language,
        balance: Number(row.balance),
        referrals: Number(row.referrals),
        referredBy: row.referred_by === null ? null : Number(row.referred_by),
        referralQualified: Boolean(row.referral_qualified),
        referralRewarded: Boolean(row.referral_rewarded),
        isAdmin: Boolean(row.is_admin),
        banned: Boolean(row.banned),
        subscriptionPlan: row.subscription_plan,
        subscriptionUntil: row.subscription_until,
        createdAt: row.created_at
    };
}

function initDb(options = {}) {
    if (db) return db;
    config = { ...config, ...options };
    dbFile = options.file || path.join(__dirname, '..', 'gamefactory.db');
    db = new DatabaseSync(dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            language TEXT DEFAULT 'ru',
            balance INTEGER NOT NULL DEFAULT 0,
            referrals INTEGER NOT NULL DEFAULT 0,
            referred_by INTEGER,
            referral_qualified INTEGER NOT NULL DEFAULT 0,
            referral_rewarded INTEGER NOT NULL DEFAULT 0,
            is_admin INTEGER NOT NULL DEFAULT 0,
            banned INTEGER NOT NULL DEFAULT 0,
            subscription_plan TEXT,
            subscription_until TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ledger (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER NOT NULL,
            delta INTEGER NOT NULL,
            reason TEXT NOT NULL,
            ref TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ledger_idem ON ledger (reason, ref) WHERE ref IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ledger_user ON ledger (telegram_id, created_at);

        CREATE TABLE IF NOT EXISTS referrals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            referrer_id INTEGER NOT NULL,
            invited_id INTEGER NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending',
            reward_granted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            qualified_at TEXT,
            rewarded_at TEXT
        );
        CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals (referrer_id, status);

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            charge_id TEXT NOT NULL UNIQUE,
            payload TEXT,
            amount INTEGER NOT NULL,
            currency TEXT NOT NULL,
            plan_id TEXT,
            games_granted INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'succeeded',
            raw TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS payments_user ON payments (telegram_id, created_at);

        CREATE TABLE IF NOT EXISTS generations (
            id TEXT PRIMARY KEY,
            telegram_id INTEGER NOT NULL,
            prompt TEXT,
            platform TEXT,
            engine TEXT,
            status TEXT NOT NULL,
            model TEXT,
            input_tokens INTEGER DEFAULT 0,
            output_tokens INTEGER DEFAULT 0,
            cost_usd REAL DEFAULT 0,
            attempts INTEGER DEFAULT 0,
            error TEXT,
            game_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS generations_user ON generations (telegram_id, created_at);

        CREATE TABLE IF NOT EXISTS games (
            id TEXT PRIMARY KEY,
            telegram_id INTEGER NOT NULL,
            generation_id TEXT,
            title TEXT,
            source TEXT,
            html_path TEXT,
            public INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'ready',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS games_user ON games (telegram_id, created_at);

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER,
            name TEXT NOT NULL,
            props TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS events_name ON events (name, created_at);
    `);

    const gameColumns = db.prepare('PRAGMA table_info(games)').all().map((column) => column.name);
    if (!gameColumns.includes('build_json')) {
        db.exec('ALTER TABLE games ADD COLUMN build_json TEXT');
    }

    if (options.importLegacy !== false) {
        importLegacyUsers(config.legacyUsersFile);
    }
    return db;
}

function getUser(telegramId) {
    const row = getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(telegramId));
    return mapUser(row);
}

function ensureUser(telegramId, profile = {}) {
    const id = Number(telegramId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некорректный Telegram ID');

    return withTransaction(() => {
        let row = getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
        if (!row) {
            getDb().prepare(`
                INSERT INTO users (telegram_id, username, first_name, language)
                VALUES (?, ?, ?, ?)
            `).run(id, profile.username || null, profile.firstName || null, profile.language || 'ru');

            credit(id, config.startBalance, 'welcome', `welcome:${id}`);

            if (config.adminIds.includes(id)) {
                getDb().prepare('UPDATE users SET is_admin = 1 WHERE telegram_id = ?').run(id);
                credit(id, 1000000, 'admin_grant', `admin:${id}`);
            }
        } else if (profile.username || profile.firstName || profile.language) {
            getDb().prepare(`
                UPDATE users
                SET username = COALESCE(?, username),
                    first_name = COALESCE(?, first_name),
                    language = COALESCE(?, language),
                    updated_at = datetime('now')
                WHERE telegram_id = ?
            `).run(profile.username || null, profile.firstName || null, profile.language || null, id);
        }
        return mapUser(getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(id));
    });
}

function credit(telegramId, delta, reason, ref = null) {
    if (!Number.isInteger(delta) || delta <= 0) throw new Error('Некорректная сумма начисления');
    return withTransaction(() => {
        const inserted = getDb().prepare(`
            INSERT OR IGNORE INTO ledger (telegram_id, delta, reason, ref)
            VALUES (?, ?, ?, ?)
        `).run(Number(telegramId), delta, reason, ref);
        if (Number(inserted.changes) === 0) return false;
        getDb().prepare(`
            UPDATE users SET balance = balance + ?, updated_at = datetime('now')
            WHERE telegram_id = ?
        `).run(delta, Number(telegramId));
        return true;
    });
}

function debit(telegramId, amount, reason, ref = null) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('Некорректная сумма списания');
    return withTransaction(() => {
        const user = getDb().prepare('SELECT balance FROM users WHERE telegram_id = ?').get(Number(telegramId));
        if (!user || Number(user.balance) < amount) return false;
        const inserted = getDb().prepare(`
            INSERT OR IGNORE INTO ledger (telegram_id, delta, reason, ref)
            VALUES (?, ?, ?, ?)
        `).run(Number(telegramId), -amount, reason, ref);
        if (Number(inserted.changes) === 0) return false;
        getDb().prepare(`
            UPDATE users SET balance = balance - ?, updated_at = datetime('now')
            WHERE telegram_id = ?
        `).run(amount, Number(telegramId));
        return true;
    });
}

function attachReferral(invitedId, referrerId) {
    const invited = Number(invitedId);
    const referrer = Number(referrerId);
    if (invited === referrer) return false;
    return withTransaction(() => {
        const invitedUser = getDb().prepare('SELECT telegram_id, referred_by, banned FROM users WHERE telegram_id = ?').get(invited);
        const referrerUser = getDb().prepare('SELECT telegram_id, banned FROM users WHERE telegram_id = ?').get(referrer);
        if (!invitedUser || !referrerUser) return false;
        if (invitedUser.referred_by || invitedUser.banned || referrerUser.banned) return false;
        getDb().prepare('UPDATE users SET referred_by = ?, updated_at = datetime(\'now\') WHERE telegram_id = ?').run(referrer, invited);
        getDb().prepare(`
            INSERT OR IGNORE INTO referrals (referrer_id, invited_id, status)
            VALUES (?, ?, 'pending')
        `).run(referrer, invited);
        return true;
    });
}

function qualifyReferral(invitedId) {
    const invited = Number(invitedId);
    return withTransaction(() => {
        const user = getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(invited);
        if (!user || !user.referred_by) return { rewarded: false, reason: 'not_eligible' };
        if (user.referral_qualified) return { rewarded: false, reason: 'already_qualified' };

        getDb().prepare(`
            UPDATE users SET referral_qualified = 1, updated_at = datetime('now')
            WHERE telegram_id = ?
        `).run(invited);
        getDb().prepare(`
            UPDATE referrals SET status = 'qualified', qualified_at = datetime('now')
            WHERE invited_id = ?
        `).run(invited);

        const referrer = getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(Number(user.referred_by));
        if (!referrer || referrer.banned) {
            getDb().prepare('UPDATE referrals SET status = \'rejected\' WHERE invited_id = ?').run(invited);
            return { rewarded: false, reason: 'referrer_unavailable' };
        }

        const monthly = getDb().prepare(`
            SELECT COUNT(*) AS count FROM ledger
            WHERE telegram_id = ? AND reason = 'referral'
              AND created_at >= datetime('now', '-30 days')
        `).get(Number(referrer.telegram_id));
        if (Number(monthly.count) >= config.referralsPerMonth) {
            getDb().prepare('UPDATE referrals SET status = \'rejected_limit\' WHERE invited_id = ?').run(invited);
            return { rewarded: false, reason: 'limit' };
        }

        const credited = credit(Number(referrer.telegram_id), config.rewardPerRef, 'referral', `referral:${invited}`);
        if (!credited) {
            return { rewarded: false, reason: 'duplicate' };
        }

        getDb().prepare(`
            UPDATE users SET referrals = referrals + 1, referral_rewarded = 1, updated_at = datetime('now')
            WHERE telegram_id = ?
        `).run(Number(referrer.telegram_id));
        getDb().prepare('UPDATE users SET referral_rewarded = 1 WHERE telegram_id = ?').run(invited);
        getDb().prepare(`
            UPDATE referrals
            SET status = 'rewarded', reward_granted = ?, rewarded_at = datetime('now')
            WHERE invited_id = ?
        `).run(config.rewardPerRef, invited);

        return {
            rewarded: true,
            referrerId: Number(referrer.telegram_id),
            amount: config.rewardPerRef,
            reason: 'ok'
        };
    });
}

function recordPayment(payment) {
    return withTransaction(() => {
        const inserted = getDb().prepare(`
            INSERT OR IGNORE INTO payments
                (telegram_id, provider, charge_id, payload, amount, currency, plan_id, games_granted, status, raw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?)
        `).run(
            Number(payment.telegramId),
            payment.provider,
            payment.chargeId,
            payment.payload || null,
            Number(payment.amount) || 0,
            payment.currency,
            payment.planId || null,
            Number(payment.gamesGranted) || 0,
            payment.raw ? JSON.stringify(payment.raw) : null
        );

        if (Number(inserted.changes) === 0) {
            return { credited: false, duplicate: true };
        }

        const telegramUntil = payment.subscriptionUntil ? new Date(payment.subscriptionUntil) : null;
        if (telegramUntil && Number.isFinite(telegramUntil.getTime())) {
            const user = getDb().prepare('SELECT subscription_until FROM users WHERE telegram_id = ?').get(Number(payment.telegramId));
            const current = user && user.subscription_until ? new Date(user.subscription_until).getTime() : 0;
            const until = new Date(Math.max(Number.isFinite(current) ? current : 0, telegramUntil.getTime())).toISOString();
            getDb().prepare(`
                UPDATE users SET subscription_plan = ?, subscription_until = ?, updated_at = datetime('now')
                WHERE telegram_id = ?
            `).run(payment.planId || null, until, Number(payment.telegramId));
        } else if (payment.subscriptionDays) {
            const user = getDb().prepare('SELECT subscription_until FROM users WHERE telegram_id = ?').get(Number(payment.telegramId));
            const current = user && user.subscription_until ? new Date(user.subscription_until).getTime() : 0;
            const base = Number.isFinite(current) && current > Date.now() ? current : Date.now();
            const until = new Date(base + payment.subscriptionDays * 24 * 60 * 60 * 1000).toISOString();
            getDb().prepare(`
                UPDATE users SET subscription_plan = ?, subscription_until = ?, updated_at = datetime('now')
                WHERE telegram_id = ?
            `).run(payment.planId || null, until, Number(payment.telegramId));
        }

        const credited = Number(payment.gamesGranted) > 0
            ? credit(Number(payment.telegramId), Number(payment.gamesGranted), 'purchase', payment.chargeId)
            : true;

        return { credited, duplicate: false };
    });
}

function getPaymentByChargeId(chargeId) {
    return getDb().prepare('SELECT * FROM payments WHERE charge_id = ?').get(chargeId) || null;
}

function markPaymentRefunded(chargeId) {
    getDb().prepare(`
        UPDATE payments SET status = 'refunded' WHERE charge_id = ?
    `).run(chargeId);
}

function recordGeneration(generation) {
    getDb().prepare(`
        INSERT INTO generations
            (id, telegram_id, prompt, platform, engine, status, model, input_tokens, output_tokens, cost_usd, attempts, error, game_id, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cost_usd = excluded.cost_usd,
            attempts = excluded.attempts,
            error = excluded.error,
            game_id = excluded.game_id,
            finished_at = excluded.finished_at
    `).run(
        generation.id,
        Number(generation.telegramId),
        generation.prompt || null,
        generation.platform || null,
        generation.engine || null,
        generation.status,
        generation.model || null,
        Number(generation.inputTokens) || 0,
        Number(generation.outputTokens) || 0,
        Number(generation.costUsd) || 0,
        Number(generation.attempts) || 0,
        generation.error || null,
        generation.gameId || null,
        generation.finishedAt || new Date().toISOString()
    );
}

function recordGame(game) {
    getDb().prepare(`
        INSERT INTO games (id, telegram_id, generation_id, title, source, html_path, public, status, build_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            html_path = excluded.html_path,
            public = excluded.public,
            status = excluded.status,
            build_json = excluded.build_json
    `).run(
        game.id,
        Number(game.telegramId),
        game.generationId || null,
        game.title || null,
        game.source || 'ai',
        game.htmlPath || null,
        game.public ? 1 : 0,
        game.status || 'ready',
        game.build ? JSON.stringify(game.build) : null
    );
}

function getGame(gameId) {
    return getDb().prepare('SELECT * FROM games WHERE id = ?').get(gameId) || null;
}

function logEvent(name, telegramId = null, props = null) {
    try {
        getDb().prepare('INSERT INTO events (telegram_id, name, props) VALUES (?, ?, ?)')
            .run(telegramId === null ? null : Number(telegramId), name, props ? JSON.stringify(props) : null);
    } catch (error) {
        console.error('[Аналитика] Не удалось записать событие:', error.message);
    }
}

function countEvents(name, sinceDays = 1) {
    return getDb().prepare(`
        SELECT COUNT(*) AS count FROM events
        WHERE name = ? AND created_at >= datetime('now', ?)
    `).get(name, `-${Number(sinceDays)} days`).count;
}

function importLegacyUsers(filePath) {
    const imported = getDb().prepare('SELECT value FROM meta WHERE key = ?').get('legacy_users_imported');
    if (imported) return;

    if (!fs.existsSync(filePath)) {
        getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_users_imported', new Date().toISOString());
        return;
    }

    let legacy;
    try {
        legacy = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error('[Миграция] users.json повреждён, импорт пропущен:', error.message);
        return;
    }
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return;

    withTransaction(() => {
        for (const [rawId, rawUser] of Object.entries(legacy)) {
            const telegramId = Number(rawId);
            if (!Number.isSafeInteger(telegramId) || telegramId <= 0) continue;
            const balance = Math.max(0, Math.trunc(Number(rawUser && rawUser.balance) || 0));
            const referrals = Math.max(0, Math.trunc(Number(rawUser && rawUser.referrals) || 0));
            const referredBy = rawUser && rawUser.referredBy ? Number(rawUser.referredBy) : null;
            const hasReferrer = Number.isSafeInteger(referredBy) && referredBy > 0;

            getDb().prepare(`
                INSERT OR IGNORE INTO users
                    (telegram_id, balance, referrals, referred_by, referral_qualified, referral_rewarded, is_admin)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                telegramId,
                balance,
                referrals,
                hasReferrer ? referredBy : null,
                hasReferrer ? 1 : 0,
                hasReferrer ? 1 : 0,
                config.adminIds.includes(telegramId) ? 1 : 0
            );

            if (balance > 0) {
                getDb().prepare(`
                    INSERT OR IGNORE INTO ledger (telegram_id, delta, reason, ref)
                    VALUES (?, ?, 'legacy_import', ?)
                `).run(telegramId, balance, `legacy:${telegramId}`);
            }
        }
        getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('legacy_users_imported', new Date().toISOString());
    });
}

function getStats() {
    const database = getDb();
    return {
        users: Number(database.prepare('SELECT COUNT(*) AS c FROM users').get().c),
        games: Number(database.prepare('SELECT COUNT(*) AS c FROM games').get().c),
        generations: Number(database.prepare('SELECT COUNT(*) AS c FROM generations').get().c),
        payments: Number(database.prepare('SELECT COUNT(*) AS c FROM payments').get().c)
    };
}

function backupDb(targetFile) {
    const target = path.resolve(String(targetFile || ''));
    if (!target) throw new Error('Не указан путь для бэкапа');
    const escaped = target.replace(/'/g, "''");
    getDb().exec(`VACUUM INTO '${escaped}'`);
    return target;
}

function closeDb() {
    if (db) {
        db.close();
        db = null;
        dbFile = null;
        txDepth = 0;
    }
}

module.exports = {
    initDb,
    closeDb,
    backupDb,
    getUser,
    ensureUser,
    credit,
    debit,
    attachReferral,
    qualifyReferral,
    recordPayment,
    getPaymentByChargeId,
    markPaymentRefunded,
    recordGeneration,
    recordGame,
    getGame,
    logEvent,
    countEvents,
    importLegacyUsers,
    getStats,
    get userFile() { return dbFile; }
};
