const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const DEFAULT_PREFIX = 'gamefactory/';
const DB_KEY = 'db/latest.db';
const INDEX_KEY = 'state/index.json';
const GEMINI_KEY = 'state/gemini-state.json';
const SCOPE_DIRS = { games: 'ai_games', uploads: 'uploads' };

function envInt(env, name, fallback) {
    const value = Number.parseInt(String(env[name] || ''), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePrefix(value) {
    const raw = String(value || DEFAULT_PREFIX).trim().replace(/^\/+/, '');
    if (!raw) return DEFAULT_PREFIX;
    return raw.endsWith('/') ? raw : `${raw}/`;
}

function safeName(name) {
    if (typeof name !== 'string' || !name || name.length > 200) return false;
    if (name !== path.basename(name)) return false;
    if (name.startsWith('.')) return false;
    if (/[\\/\0]/.test(name)) return false;
    return true;
}

function readConfig(env) {
    const bucket = String(env.R2_BUCKET || env.SNAPSHOT_BUCKET || '').trim();
    const accountId = String(env.R2_ACCOUNT_ID || '').trim();
    const endpoint = String(env.R2_ENDPOINT || env.SNAPSHOT_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).trim();
    const accessKeyId = String(env.R2_ACCESS_KEY_ID || env.SNAPSHOT_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = String(env.R2_SECRET_ACCESS_KEY || env.SNAPSHOT_SECRET_ACCESS_KEY || '').trim();
    const requested = String(env.SNAPSHOT_ENABLED || '').trim().toLowerCase() !== 'false';
    const configured = Boolean(bucket && endpoint && accessKeyId && secretAccessKey);
    return {
        enabled: requested && configured,
        requested,
        configured,
        bucket,
        endpoint,
        region: String(env.R2_REGION || env.SNAPSHOT_REGION || 'auto').trim() || 'auto',
        accessKeyId,
        secretAccessKey,
        prefix: normalizePrefix(env.R2_PREFIX || env.SNAPSHOT_PREFIX || DEFAULT_PREFIX),
        intervalMs: envInt(env, 'SNAPSHOT_INTERVAL_MS', 60000),
        timeoutMs: envInt(env, 'SNAPSHOT_TIMEOUT_MS', 20000)
    };
}

function createS3Storage(config) {
    const { AwsClient } = require('aws4fetch');
    const client = new AwsClient({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        service: 's3',
        region: config.region
    });
    const base = `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}/`;
    const objectUrl = (key) => base + key.split('/').map(encodeURIComponent).join('/');

    async function put(key, body) {
        const res = await client.fetch(objectUrl(key), {
            method: 'PUT',
            body,
            headers: { 'content-type': 'application/octet-stream' }
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`PUT ${key}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
        }
    }

    async function get(key) {
        const res = await client.fetch(objectUrl(key), { method: 'GET' });
        if (res.status === 404) return null;
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`GET ${key}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
        }
        return Buffer.from(await res.arrayBuffer());
    }

    return { put, get };
}

function withTimeout(promise, ms, label) {
    if (!ms) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'операция'}: таймаут ${ms} мс`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createSnapshotService(options = {}) {
    const env = options.env || process.env;
    const config = readConfig(env);
    const dataDir = path.resolve(options.dataDir || process.cwd());
    const dbFile = path.resolve(options.dbFile || path.join(dataDir, 'gamefactory.db'));
    const aiGamesDir = path.resolve(options.aiGamesDir || path.join(dataDir, SCOPE_DIRS.games));
    const uploadsDir = path.resolve(options.uploadsDir || path.join(dataDir, SCOPE_DIRS.uploads));
    const logger = options.logger || console;
    const backupDb = options.backupDb || ((target) => require('./db').backupDb(target));
    const storage = config.enabled ? (options.storage || createS3Storage(config)) : null;

    const status = {
        enabled: config.enabled,
        requested: config.requested,
        configured: config.configured,
        bucket: config.enabled ? config.bucket : null,
        prefix: config.enabled ? config.prefix : null,
        last_snapshot_at: null,
        last_restore: null,
        last_error: null,
        running: false
    };

    const known = new Map();
    const knownState = new Map();
    let dirty = false;
    let timer = null;
    let chain = Promise.resolve();
    let lastArchiveDay = null;

    function remember(relKey, stat) {
        known.set(relKey, { size: stat.size, mtimeMs: stat.mtimeMs });
    }

    async function uploadFile(storageRef, relKey, fullPath, stat) {
        const body = await fsp.readFile(fullPath);
        await withTimeout(storageRef.put(config.prefix + relKey, body), config.timeoutMs, `выгрузка ${relKey}`);
        remember(relKey, stat);
    }

    async function scanDir(storageRef, dir, kind, stats) {
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !safeName(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            const relKey = `${kind}/${entry.name}`;
            const stat = await fsp.stat(fullPath);
            const prev = known.get(relKey);
            if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue;
            await uploadFile(storageRef, relKey, fullPath, stat);
            stats.uploaded += 1;
        }
    }

    async function uploadGeminiState(storageRef, stats) {
        const fullPath = path.join(dataDir, 'gemini-state.json');
        let stat;
        try {
            stat = await fsp.stat(fullPath);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
        const prev = knownState.get('gemini');
        if (!prev || prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs) {
            await withTimeout(storageRef.put(config.prefix + GEMINI_KEY, await fsp.readFile(fullPath)), config.timeoutMs, 'выгрузка состояния Gemini');
            knownState.set('gemini', { size: stat.size, mtimeMs: stat.mtimeMs });
            stats.uploaded += 1;
        }
        return { key: config.prefix + GEMINI_KEY, size: stat.size, mtimeMs: stat.mtimeMs };
    }

    async function doFlush(reason) {
        if (!config.enabled) return { skipped: true, reason: 'disabled' };
        if (reason === 'timer' && !dirty) return { skipped: true, reason: 'clean' };

        status.running = true;
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gf-snapshot-'));
        try {
            const dbCopy = path.join(tempDir, 'gamefactory.db');
            backupDb(dbCopy);
            const dbBody = await fsp.readFile(dbCopy);
            await withTimeout(storage.put(config.prefix + DB_KEY, dbBody), config.timeoutMs, 'выгрузка БД');

            const day = new Date().toISOString().slice(0, 10);
            if (lastArchiveDay !== day) {
                await withTimeout(storage.put(`${config.prefix}db/archive/${day}.db`, dbBody), config.timeoutMs, 'выгрузка архива БД');
                lastArchiveDay = day;
            }

            const stats = { uploaded: 0 };
            await scanDir(storage, aiGamesDir, 'games', stats);
            await scanDir(storage, uploadsDir, 'uploads', stats);
            const gemini = await uploadGeminiState(storage, stats);

            const files = {};
            for (const [relKey, meta] of known) files[relKey] = { size: meta.size, mtimeMs: meta.mtimeMs };
            const index = {
                version: 1,
                updatedAt: new Date().toISOString(),
                reason,
                db: { key: config.prefix + DB_KEY, size: dbBody.length },
                gemini,
                files
            };
            await withTimeout(storage.put(config.prefix + INDEX_KEY, Buffer.from(JSON.stringify(index))), config.timeoutMs, 'выгрузка индекса');

            dirty = false;
            status.last_snapshot_at = index.updatedAt;
            status.last_error = null;
            return { skipped: false, uploaded: stats.uploaded, files: known.size, size: dbBody.length };
        } catch (error) {
            status.last_error = error.message;
            throw error;
        } finally {
            status.running = false;
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }

    function flush(reason = 'manual') {
        const task = chain.then(() => doFlush(reason));
        chain = task.catch(() => {});
        return task;
    }

    function markDirty() {
        dirty = true;
    }

    async function downloadFile(storageRef, key, target, attempts = 2) {
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const body = await withTimeout(storageRef.get(key), config.timeoutMs, `загрузка ${key}`);
                if (!body) return null;
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.writeFile(target, body);
                return body.length;
            } catch (error) {
                lastError = error;
                if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
            }
        }
        throw lastError;
    }

    async function restore() {
        if (!config.enabled) {
            status.last_restore = 'disabled';
            return { restored: false, reason: 'disabled' };
        }
        try {
            const existing = await fsp.stat(dbFile).catch(() => null);
            if (existing && existing.size > 0) {
                status.last_restore = 'skipped';
                return { restored: false, reason: 'local_db_exists' };
            }

            const rawIndex = await withTimeout(storage.get(config.prefix + INDEX_KEY), config.timeoutMs, 'загрузка индекса');
            if (!rawIndex) {
                status.last_restore = 'empty';
                return { restored: false, reason: 'no_remote_snapshot' };
            }
            const index = JSON.parse(rawIndex.toString('utf8'));
            if (!index || index.version !== 1) throw new Error('неизвестный формат индекса снапшотов');

            const dbSize = await downloadFile(storage, config.prefix + DB_KEY, `${dbFile}.restore`, 3);
            if (!dbSize) throw new Error('в R2 есть индекс, но нет файла базы');
            for (const suffix of ['-wal', '-shm']) {
                fs.rmSync(dbFile + suffix, { force: true });
            }
            await fsp.rename(`${dbFile}.restore`, dbFile);

            const geminiSize = await downloadFile(storage, config.prefix + GEMINI_KEY, path.join(dataDir, 'gemini-state.json')).catch(() => null);

            let restoredFiles = 0;
            let failedFiles = 0;
            const files = index.files && typeof index.files === 'object' ? index.files : {};
            for (const [relKey, meta] of Object.entries(files)) {
                const slash = typeof relKey === 'string' ? relKey.indexOf('/') : -1;
                const kind = slash > 0 ? relKey.slice(0, slash) : '';
                const name = slash > 0 ? relKey.slice(slash + 1) : '';
                if (!SCOPE_DIRS[kind] || !safeName(name)) continue;
                const dir = kind === 'games' ? aiGamesDir : uploadsDir;
                try {
                    const size = await downloadFile(storage, config.prefix + relKey, path.join(dir, name));
                    if (size) {
                        const stat = await fsp.stat(path.join(dir, name));
                        remember(relKey, stat);
                        restoredFiles += 1;
                    }
                } catch (error) {
                    failedFiles += 1;
                    if (meta && typeof meta === 'object') {
                        known.set(relKey, { size: Number(meta.size) || 0, mtimeMs: Number(meta.mtimeMs) || 0 });
                    }
                    logger.warn(`[Снапшот] Не удалось восстановить ${relKey}: ${error.message}`);
                }
            }

            status.last_restore = `restored:db=${dbSize},files=${restoredFiles},failed=${failedFiles}`;
            status.last_snapshot_at = index.updatedAt || null;
            status.last_error = failedFiles > 0 ? `не восстановлено файлов: ${failedFiles}` : null;
            return { restored: true, dbSize, gemini: Boolean(geminiSize), files: restoredFiles, failedFiles };
        } catch (error) {
            status.last_restore = 'error';
            status.last_error = error.message;
            // Запускаться с пустой базой при существующем снапшоте нельзя: первый же
            // flush перезаписал бы удалённые данные. Лучше упасть и перезапуститься.
            throw new Error(`Не удалось восстановить данные из R2: ${error.message}`);
        }
    }

    function start() {
        if (!config.enabled || timer) return;
        timer = setInterval(() => {
            flush('timer').catch((error) => logger.error(`[Снапшот] Ошибка: ${error.message}`));
        }, config.intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    async function stop() {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (!config.enabled) return { skipped: true };
        try {
            // Render даёт 30 секунд между SIGTERM и SIGKILL, поэтому финальную
            // выгрузку ограничиваем 20 секундами.
            return await withTimeout(flush('shutdown'), Math.min(Math.max(config.timeoutMs, 5000), 20000), 'финальный снапшот');
        } catch (error) {
            logger.error(`[Снапшот] Финальная выгрузка не удалась: ${error.message}`);
            return { skipped: false, error: error.message };
        }
    }

    function snapshotStatus() {
        return {
            enabled: status.enabled,
            configured: status.configured,
            requested: status.requested,
            bucket: status.bucket,
            prefix: status.prefix,
            last_snapshot_at: status.last_snapshot_at,
            last_restore: status.last_restore,
            last_error: status.last_error,
            running: status.running
        };
    }

    return {
        enabled: config.enabled,
        config,
        restore,
        flush,
        markDirty,
        start,
        stop,
        status: snapshotStatus
    };
}

module.exports = {
    createSnapshotService,
    readConfig,
    createS3Storage,
    DEFAULT_PREFIX
};
