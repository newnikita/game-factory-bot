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

        CREATE TABLE IF NOT EXISTS complaints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL,
            reporter_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            details TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            action TEXT,
            resolved_by INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS complaints_open_unique
            ON complaints (game_id, reporter_id) WHERE status = 'open';
        CREATE INDEX IF NOT EXISTS complaints_status ON complaints (status, id);

        CREATE TABLE IF NOT EXISTS game_ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            rating INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS game_ratings_unique ON game_ratings (game_id, user_id);
        CREATE INDEX IF NOT EXISTS game_ratings_game ON game_ratings (game_id);

        CREATE TABLE IF NOT EXISTS visual_measurements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id TEXT NOT NULL,
            score INTEGER NOT NULL,
            coverage REAL,
            colors INTEGER,
            shades INTEGER,
            contrast REAL,
            animated INTEGER DEFAULT 0,
            blank INTEGER DEFAULT 0,
            samples INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS visual_measurements_game ON visual_measurements (game_id, id);
    `);

    const measurementColumns = db.prepare('PRAGMA table_info(visual_measurements)').all().map((column) => column.name);
    if (!measurementColumns.includes('samples')) {
        db.exec('ALTER TABLE visual_measurements ADD COLUMN samples INTEGER DEFAULT 0');
    }

    const gameColumns = db.prepare('PRAGMA table_info(games)').all().map((column) => column.name);
    if (!gameColumns.includes('build_json')) {
        db.exec('ALTER TABLE games ADD COLUMN build_json TEXT');
    }
    if (!gameColumns.includes('visual_static')) {
        db.exec('ALTER TABLE games ADD COLUMN visual_static INTEGER');
    }
    if (!gameColumns.includes('visual_measured')) {
        db.exec('ALTER TABLE games ADD COLUMN visual_measured INTEGER');
    }
    if (!gameColumns.includes('visual_measured_at')) {
        db.exec('ALTER TABLE games ADD COLUMN visual_measured_at TEXT');
    }
    const generationColumns = db.prepare('PRAGMA table_info(generations)').all().map((column) => column.name);
    if (!generationColumns.includes('genre')) {
        db.exec('ALTER TABLE generations ADD COLUMN genre TEXT');
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
            (id, telegram_id, prompt, platform, engine, status, model, input_tokens, output_tokens, cost_usd, attempts, error, game_id, finished_at, genre)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cost_usd = excluded.cost_usd,
            attempts = excluded.attempts,
            error = excluded.error,
            game_id = excluded.game_id,
            finished_at = excluded.finished_at,
            genre = COALESCE(excluded.genre, generations.genre)
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
        generation.finishedAt || new Date().toISOString(),
        generation.genre || null
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

const MAX_VISUAL_MEASUREMENTS = 5;

function setGameVisualStatic(gameId, score) {
    const value = Number(score);
    if (!Number.isFinite(value)) return false;
    const updated = getDb().prepare('UPDATE games SET visual_static = ? WHERE id = ?')
        .run(Math.round(value), String(gameId));
    return Number(updated.changes) > 0;
}

function recordVisualMeasurement(gameId, data) {
    const id = String(gameId || '');
    if (!id) throw new Error('Не указана игра');
    const score = Math.max(0, Math.min(100, Math.round(Number(data.score) || 0)));
    const samples = Math.max(0, Math.min(64, Math.round(Number(data.samples) || 0)));
    return withTransaction(() => {
        const total = Number(getDb().prepare('SELECT COUNT(*) AS c FROM visual_measurements WHERE game_id = ?').get(id).c) || 0;
        let accepted = false;
        if (total < MAX_VISUAL_MEASUREMENTS) {
            getDb().prepare(`
                INSERT INTO visual_measurements (game_id, score, coverage, colors, shades, contrast, animated, blank, samples)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                score,
                Number(data.coverage) || 0,
                Number(data.colors) || 0,
                Number(data.shades) || 0,
                Number(data.contrast) || 0,
                data.animated ? 1 : 0,
                data.blank ? 1 : 0,
                samples
            );
            accepted = true;
        }
        const blankReports = Number(getDb().prepare(
            'SELECT COUNT(*) AS c FROM visual_measurements WHERE game_id = ? AND blank = 1 AND samples >= 2'
        ).get(id).c) || 0;
        const best = getDb().prepare(
            'SELECT MAX(score) AS score FROM visual_measurements WHERE game_id = ?'
        ).get(id);
        const bestScore = best && best.score !== null ? Number(best.score) : null;
        getDb().prepare(`UPDATE games SET visual_measured = ?, visual_measured_at = datetime('now') WHERE id = ?`)
            .run(bestScore, id);
        return { accepted, blankReports, score: bestScore };
    });
}

function getVisualCalibration(limit = 50) {
    const rows = getDb().prepare(`
        SELECT id, visual_static AS staticScore, visual_measured AS measuredScore
        FROM games
        WHERE visual_static IS NOT NULL AND visual_measured IS NOT NULL
        ORDER BY visual_measured_at DESC
        LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit) || 50)));
    return rows.map((row) => ({
        staticScore: Number(row.staticScore),
        measuredScore: Math.round(Number(row.measuredScore) || 0)
    }));
}

function getGameRating(gameId, userId = null) {
    const id = String(gameId || '');
    const row = getDb().prepare('SELECT COUNT(*) AS c, AVG(rating) AS avg FROM game_ratings WHERE game_id = ?').get(id);
    const count = Number(row && row.c) || 0;
    const avg = count ? Math.round((Number(row.avg) || 0) * 10) / 10 : 0;
    let myRating = null;
    if (userId) {
        const mine = getDb().prepare('SELECT rating FROM game_ratings WHERE game_id = ? AND user_id = ?').get(id, Number(userId));
        myRating = mine ? Number(mine.rating) : null;
    }
    return { gameId: id, count, avg, myRating };
}

function rateGame(gameId, userId, rating) {
    const id = String(gameId || '').trim();
    const score = Math.round(Number(rating));
    const uid = Number(userId);
    if (!id) throw new Error('Не указана игра');
    if (!Number.isSafeInteger(score) || score < 1 || score > 5) throw new Error('Оценка должна быть от 1 до 5');
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Некорректный Telegram ID');
    return withTransaction(() => {
        getDb().prepare(`
            INSERT INTO game_ratings (game_id, user_id, rating, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(game_id, user_id) DO UPDATE SET
                rating = excluded.rating,
                updated_at = datetime('now')
        `).run(id, uid, score);
        return getGameRating(id, uid);
    });
}

function getRatingStats(days = 30) {
    const safeDays = Math.max(1, Math.min(365, Number(days) || 30));
    const rows = getDb().prepare(`
        SELECT r.game_id AS game_id, g.title AS title,
               COALESCE(gen.genre, 'unknown') AS genre,
               COALESCE(gen.prompt, '') AS prompt,
               COUNT(r.id) AS votes, AVG(r.rating) AS avg_rating,
               MAX(r.updated_at) AS last_at
        FROM game_ratings r
        JOIN games g ON g.id = r.game_id
        LEFT JOIN generations gen ON gen.id = g.generation_id
        WHERE r.updated_at >= datetime('now', ?)
        GROUP BY r.game_id
        ORDER BY votes DESC, avg_rating DESC
    `).all(`-${safeDays} days`);

    const byGenreMap = new Map();
    let votes = 0;
    let sum = 0;
    const games = [];
    for (const row of rows) {
        const gameVotes = Number(row.votes) || 0;
        const avg = Math.round((Number(row.avg_rating) || 0) * 10) / 10;
        votes += gameVotes;
        sum += avg * gameVotes;
        const genre = String(row.genre || 'unknown');
        const bucket = byGenreMap.get(genre) || { genre, votes: 0, sum: 0 };
        bucket.votes += gameVotes;
        bucket.sum += avg * gameVotes;
        byGenreMap.set(genre, bucket);
        games.push({
            gameId: row.game_id,
            title: row.title || row.game_id,
            genre,
            prompt: String(row.prompt || '').slice(0, 300),
            votes: gameVotes,
            avg,
            lastAt: row.last_at
        });
    }

    const rated = games.filter((game) => game.votes > 0);
    const byGenre = [...byGenreMap.values()]
        .map((bucket) => ({
            genre: bucket.genre,
            votes: bucket.votes,
            avg: bucket.votes ? Math.round((bucket.sum / bucket.votes) * 10) / 10 : 0
        }))
        .sort((a, b) => b.votes - a.votes);

    return {
        days: safeDays,
        votes,
        avg: votes ? Math.round((sum / votes) * 10) / 10 : 0,
        ratedGames: rated.length,
        byGenre,
        top: rated.slice().sort((a, b) => b.avg - a.avg || b.votes - a.votes).slice(0, 5),
        bottom: rated.slice().sort((a, b) => a.avg - b.avg || b.votes - a.votes).slice(0, 5)
    };
}

const COMPLAINT_SELECT = `
    SELECT c.*, g.title AS game_title, g.telegram_id AS owner_id, g.status AS game_status
    FROM complaints c
    LEFT JOIN games g ON g.id = c.game_id
`;

function createComplaint({ gameId, reporterId, reason, details = null }) {
    const reporter = Number(reporterId);
    if (!Number.isSafeInteger(reporter) || reporter <= 0) throw new Error('Некорректный Telegram ID');

    return withTransaction(() => {
        const game = getDb().prepare('SELECT id FROM games WHERE id = ?').get(String(gameId));
        if (!game) return { created: false, reason: 'game_not_found' };

        const inserted = getDb().prepare(`
            INSERT OR IGNORE INTO complaints (game_id, reporter_id, reason, details)
            VALUES (?, ?, ?, ?)
        `).run(String(gameId), reporter, String(reason), details ? String(details).slice(0, 500) : null);

        if (Number(inserted.changes) === 0) return { created: false, reason: 'duplicate' };
        return { created: true, complaint: getComplaint(Number(inserted.lastInsertRowid)) };
    });
}

function getComplaint(complaintId) {
    return getDb().prepare(`${COMPLAINT_SELECT} WHERE c.id = ?`).get(Number(complaintId)) || null;
}

function listOpenComplaints(limit = 20) {
    const count = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return getDb().prepare(`
        ${COMPLAINT_SELECT}
        WHERE c.status = 'open'
        ORDER BY c.id DESC
        LIMIT ?
    `).all(count);
}

function hideGame(gameId, adminId = null) {
    const id = String(gameId);
    return withTransaction(() => {
        const updated = getDb().prepare(`
            UPDATE games SET status = 'hidden' WHERE id = ? AND status != 'hidden'
        `).run(id);
        if (Number(updated.changes) === 0) return false;

        getDb().prepare(`
            UPDATE complaints
            SET status = 'resolved', action = 'hide_game', resolved_by = ?, resolved_at = datetime('now')
            WHERE game_id = ? AND status = 'open'
        `).run(adminId === null ? null : Number(adminId), id);
        return true;
    });
}

function restoreGame(gameId) {
    const updated = getDb().prepare(`
        UPDATE games SET status = 'ready' WHERE id = ? AND status = 'hidden'
    `).run(String(gameId));
    return Number(updated.changes) > 0;
}

function dismissComplaint(complaintId, adminId = null) {
    const updated = getDb().prepare(`
        UPDATE complaints
        SET status = 'dismissed', action = 'dismiss', resolved_by = ?, resolved_at = datetime('now')
        WHERE id = ? AND status = 'open'
    `).run(adminId === null ? null : Number(adminId), Number(complaintId));
    return Number(updated.changes) > 0;
}

function countOpenComplaints() {
    return Number(getDb().prepare(`
        SELECT COUNT(*) AS count FROM complaints WHERE status = 'open'
    `).get().count);
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

function getQualityStats(days = 7) {
    const safeDays = Math.max(1, Math.min(90, Number(days) || 7));
    const rows = getDb().prepare(`
        SELECT props FROM events
        WHERE name IN ('generation_quality', 'improvement_quality')
          AND created_at >= datetime('now', ?)
    `).all(`-${safeDays} days`);

    let count = 0;
    let sum = 0;
    let lowQuality = 0;
    let rubricSum = 0;
    let rubricCount = 0;
    let auditCritic = 0;
    const issueCounts = new Map();
    const visualIssueCounts = new Map();
    const versionCounts = new Map();
    for (const row of rows) {
        let props = null;
        try { props = JSON.parse(row.props || '{}'); } catch (error) { continue; }
        const score = Number(props.score);
        if (!Number.isFinite(score)) continue;
        count++;
        sum += score;
        if (score < 80) lowQuality++;
        const rubric = Number(props.rubricScore);
        if (Number.isFinite(rubric)) {
            rubricCount++;
            rubricSum += rubric;
        }
        if (props.criticSource === 'audit') auditCritic++;
        const version = String(props.promptVersion || 'legacy').slice(0, 32);
        const versionStats = versionCounts.get(version) || { count: 0, sum: 0 };
        versionStats.count++;
        versionStats.sum += score;
        versionCounts.set(version, versionStats);
        for (const issue of Array.isArray(props.issues) ? props.issues : []) {
            const code = String(issue || '').slice(0, 48);
            if (code) issueCounts.set(code, (issueCounts.get(code) || 0) + 1);
        }
        for (const issue of Array.isArray(props.visualIssues) ? props.visualIssues : []) {
            const code = String(issue || '').slice(0, 48);
            if (code) visualIssueCounts.set(code, (visualIssueCounts.get(code) || 0) + 1);
        }
    }
    const topIssues = [...issueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, occurrences]) => ({ code, occurrences }));
    const topVisualIssues = [...visualIssueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([code, occurrences]) => ({ code, occurrences }));
    const byVersion = [...versionCounts.entries()]
        .map(([version, stats]) => ({
            version,
            count: stats.count,
            avgScore: Math.round(stats.sum / stats.count)
        }))
        .sort((a, b) => b.count - a.count);

    return {
        days: safeDays,
        count,
        avgScore: count ? Math.round(sum / count) : 0,
        avgRubric: rubricCount ? Math.round(rubricSum / rubricCount) : null,
        auditCritic,
        lowQuality,
        topIssues,
        topVisualIssues,
        byVersion
    };
}

function getStats() {
    const database = getDb();
    return {
        users: Number(database.prepare('SELECT COUNT(*) AS c FROM users').get().c),
        games: Number(database.prepare('SELECT COUNT(*) AS c FROM games').get().c),
        generations: Number(database.prepare('SELECT COUNT(*) AS c FROM generations').get().c),
        payments: Number(database.prepare('SELECT COUNT(*) AS c FROM payments').get().c),
        openComplaints: countOpenComplaints(),
        quality: getQualityStats(7),
        ratings: getRatingStats(30)
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
    setGameVisualStatic,
    recordVisualMeasurement,
    getVisualCalibration,
    createComplaint,
    getComplaint,
    listOpenComplaints,
    hideGame,
    restoreGame,
    dismissComplaint,
    countOpenComplaints,
    logEvent,
    countEvents,
    importLegacyUsers,
    getStats,
    getQualityStats,
    rateGame,
    getGameRating,
    getRatingStats,
    get userFile() { return dbFile; }
};
