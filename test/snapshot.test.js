const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createSnapshotService, readConfig, createS3Storage } = require('../lib/snapshot');

const ENV = {
    R2_BUCKET: 'bucket',
    R2_ACCOUNT_ID: 'account',
    R2_ACCESS_KEY_ID: 'key',
    R2_SECRET_ACCESS_KEY: 'secret',
    SNAPSHOT_INTERVAL_MS: '60000'
};

function memoryStorage(seed) {
    const objects = new Map();
    for (const [key, value] of Object.entries(seed || {})) {
        objects.set(key, Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    return {
        objects,
        puts: 0,
        async put(key, body) {
            this.puts += 1;
            objects.set(key, Buffer.from(body));
        },
        async get(key) {
            return objects.has(key) ? Buffer.from(objects.get(key)) : null;
        }
    };
}

function makeWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-snapshot-test-'));
    const dirs = {
        root,
        dataDir: path.join(root, 'data'),
        aiGamesDir: path.join(root, 'data', 'ai_games'),
        uploadsDir: path.join(root, 'data', 'uploads'),
        dbFile: path.join(root, 'data', 'gamefactory.db')
    };
    fs.mkdirSync(dirs.aiGamesDir, { recursive: true });
    fs.mkdirSync(dirs.uploadsDir, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return dirs;
}

function service(dirs, storage, env) {
    return createSnapshotService({
        env: { ...ENV, ...(env || {}) },
        dataDir: dirs.dataDir,
        dbFile: dirs.dbFile,
        aiGamesDir: dirs.aiGamesDir,
        uploadsDir: dirs.uploadsDir,
        storage,
        backupDb: (target) => fs.writeFileSync(target, 'DB-CONTENT'),
        logger: { warn() {}, error() {} }
    });
}

function index(files) {
    return JSON.stringify({
        version: 1,
        updatedAt: '2026-10-24T10:00:00.000Z',
        db: { key: 'gamefactory/db/latest.db' },
        files
    });
}

test('без настроек снапшоты выключены и ничего не делают', async (t) => {
    const dirs = makeWorkspace(t);
    const svc = createSnapshotService({
        env: {},
        dataDir: dirs.dataDir,
        dbFile: dirs.dbFile,
        aiGamesDir: dirs.aiGamesDir,
        uploadsDir: dirs.uploadsDir
    });
    assert.equal(svc.enabled, false);
    assert.deepEqual(await svc.flush('manual'), { skipped: true, reason: 'disabled' });
    assert.equal((await svc.restore()).reason, 'disabled');
});

test('SNAPSHOT_ENABLED=false выключает даже полностью настроенное хранилище', () => {
    const config = readConfig({ ...ENV, SNAPSHOT_ENABLED: 'false' });
    assert.equal(config.configured, true);
    assert.equal(config.enabled, false);
});

test('при старте база, игры и загрузки восстанавливаются из R2', async (t) => {
    const dirs = makeWorkspace(t);
    const storage = memoryStorage({
        'gamefactory/state/index.json': index({
            'games/ai_1.html': { size: 5, mtimeMs: 1 },
            'uploads/bg.jpg': { size: 3, mtimeMs: 1 }
        }),
        'gamefactory/db/latest.db': 'DB-FROM-R2',
        'gamefactory/games/ai_1.html': '<html>',
        'gamefactory/uploads/bg.jpg': 'jpg',
        'gamefactory/state/gemini-state.json': '{"models":[]}'
    });
    const svc = service(dirs, storage);
    const result = await svc.restore();

    assert.equal(result.restored, true);
    assert.equal(result.files, 2);
    assert.equal(fs.readFileSync(dirs.dbFile, 'utf8'), 'DB-FROM-R2');
    assert.equal(fs.readFileSync(path.join(dirs.aiGamesDir, 'ai_1.html'), 'utf8'), '<html>');
    assert.equal(fs.readFileSync(path.join(dirs.uploadsDir, 'bg.jpg'), 'utf8'), 'jpg');
    assert.equal(fs.readFileSync(path.join(dirs.dataDir, 'gemini-state.json'), 'utf8'), '{"models":[]}');
    assert.match(svc.status().last_restore, /^restored:/);
});

test('если индекс есть, а базы в R2 нет — запуск падает, а не стартует с пустой базой', async (t) => {
    const dirs = makeWorkspace(t);
    const storage = memoryStorage({ 'gamefactory/state/index.json': index({}) });
    const svc = service(dirs, storage);
    await assert.rejects(() => svc.restore(), /Не удалось восстановить данные из R2/);
    assert.equal(fs.existsSync(dirs.dbFile), false);
});

test('локальная база не перезаписывается снапшотом', async (t) => {
    const dirs = makeWorkspace(t);
    fs.writeFileSync(dirs.dbFile, 'LOCAL');
    const storage = memoryStorage({
        'gamefactory/state/index.json': index({}),
        'gamefactory/db/latest.db': 'REMOTE'
    });
    const svc = service(dirs, storage);
    const result = await svc.restore();
    assert.equal(result.reason, 'local_db_exists');
    assert.equal(fs.readFileSync(dirs.dbFile, 'utf8'), 'LOCAL');
});

test('flush выгружает базу, файлы и индекс, повторный — только изменения', async (t) => {
    const dirs = makeWorkspace(t);
    fs.writeFileSync(path.join(dirs.aiGamesDir, 'ai_1.html'), '<html>v1');
    fs.writeFileSync(path.join(dirs.uploadsDir, 'bg.jpg'), 'jpg');
    const storage = memoryStorage();
    const svc = service(dirs, storage);

    const first = await svc.flush('manual');
    assert.equal(first.skipped, false);
    assert.equal(storage.objects.get('gamefactory/db/latest.db').toString('utf8'), 'DB-CONTENT');
    assert.equal(storage.objects.get('gamefactory/games/ai_1.html').toString('utf8'), '<html>v1');
    assert.equal(storage.objects.get('gamefactory/uploads/bg.jpg').toString('utf8'), 'jpg');
    const saved = JSON.parse(storage.objects.get('gamefactory/state/index.json').toString('utf8'));
    assert.ok(saved.files['games/ai_1.html']);
    assert.equal(first.uploaded, 2);

    const second = await svc.flush('manual');
    assert.equal(second.uploaded, 0, 'неизменённые файлы повторно не выгружаются');

    fs.writeFileSync(path.join(dirs.aiGamesDir, 'ai_1.html'), '<html>v2-longer');
    const third = await svc.flush('manual');
    assert.equal(third.uploaded, 1);
    assert.equal(storage.objects.get('gamefactory/games/ai_1.html').toString('utf8'), '<html>v2-longer');
});

test('таймер не выгружает, пока нет изменений, а платёж выгружает сразу', async (t) => {
    const dirs = makeWorkspace(t);
    const storage = memoryStorage();
    const svc = service(dirs, storage);
    assert.deepEqual(await svc.flush('timer'), { skipped: true, reason: 'clean' });
    svc.markDirty();
    assert.equal((await svc.flush('timer')).skipped, false);
    assert.equal((await svc.flush('payment')).skipped, false);
});

test('S3-адаптер подписывает PUT и читает GET', async (t) => {
    const objects = new Map();
    let authorization = '';
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            authorization = req.headers.authorization || authorization;
            const key = decodeURIComponent(req.url.replace(/^\/[^/]+\//, ''));
            if (req.method === 'PUT') {
                objects.set(key, Buffer.concat(chunks));
                res.writeHead(200);
                res.end();
            } else if (req.method === 'GET') {
                if (objects.has(key)) {
                    res.writeHead(200);
                    res.end(objects.get(key));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            } else {
                res.writeHead(405);
                res.end();
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());

    const storage = createS3Storage({
        endpoint: `http://127.0.0.1:${server.address().port}`,
        bucket: 'bucket',
        region: 'auto',
        accessKeyId: 'key',
        secretAccessKey: 'secret'
    });
    await storage.put('gamefactory/db/latest.db', Buffer.from('hello'));
    assert.equal((await storage.get('gamefactory/db/latest.db')).toString('utf8'), 'hello');
    assert.equal(await storage.get('gamefactory/missing'), null);
    assert.match(authorization, /AWS4-HMAC-SHA256/);
});

test('опасные имена из индекса не восстанавливаются', async (t) => {
    const dirs = makeWorkspace(t);
    const storage = memoryStorage({
        'gamefactory/state/index.json': index({
            'games/../evil.html': { size: 1, mtimeMs: 1 },
            'games/.hidden': { size: 1, mtimeMs: 1 },
            'other/file.txt': { size: 1, mtimeMs: 1 }
        }),
        'gamefactory/db/latest.db': 'DB'
    });
    const svc = service(dirs, storage);
    const result = await svc.restore();
    assert.equal(result.restored, true);
    assert.equal(result.files, 0);
    assert.equal(fs.existsSync(path.join(dirs.root, 'evil.html')), false);
    assert.equal(fs.existsSync(path.join(dirs.aiGamesDir, '.hidden')), false);
});
