const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../lib/gemini');

test('stripCodeMarkers убирает markdown-обёртку', () => {
    assert.equal(gemini.stripCodeMarkers('```html\n<!DOCTYPE html>\n```'), '<!DOCTYPE html>');
    assert.equal(gemini.stripCodeMarkers('  ```\nкод\n```  '), 'код');
});

test('parseJsonLoose читает чистый JSON', () => {
    assert.deepEqual(gemini.parseJsonLoose('{"a":1}'), { a: 1 });
    assert.deepEqual(gemini.parseJsonLoose('[1,2]'), [1, 2]);
});

test('parseJsonLoose вытаскивает JSON из текста вокруг', () => {
    const parsed = gemini.parseJsonLoose('Вот ответ: {"score": 80, "issues": []} — всё.');
    assert.deepEqual(parsed, { score: 80, issues: [] });
});

test('parseJsonLoose переживает мусорные ```-обёртки', () => {
    const parsed = gemini.parseJsonLoose('```json\n{"ok":true}\n```');
    assert.deepEqual(parsed, { ok: true });
});

test('parseJsonLoose возвращает null на мусоре', () => {
    assert.equal(gemini.parseJsonLoose('совсем не json'), null);
    assert.equal(gemini.parseJsonLoose(''), null);
});

test('extractText собирает части ответа и считает токены', () => {
    const data = {
        candidates: [{ content: { parts: [{ text: 'Привет ' }, { text: 'мир' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 }
    };
    const result = gemini.extractText(data);
    assert.equal(result.text, 'Привет мир');
    assert.equal(result.blocked, false);
    assert.equal(result.finishReason, 'STOP');
});

test('extractText помечает заблокированный ответ', () => {
    const result = gemini.extractText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] });
    assert.equal(result.blocked, true);
    assert.equal(result.text, '');
});

test('GeminiError хранит статус и флаг повторяемости', () => {
    const error = new gemini.GeminiError('лимит', { status: 429, retryable: true, model: 'gemini-2.5-flash' });
    assert.equal(error.name, 'GeminiError');
    assert.equal(error.status, 429);
    assert.equal(error.retryable, true);
    assert.equal(error.model, 'gemini-2.5-flash');
});

test('generate падает без ключа и не делает запрос', async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
        await assert.rejects(() => gemini.generate({ contents: [] }), /Ключ Gemini не настроен/);
    } finally {
        if (previous !== undefined) process.env.GEMINI_API_KEY = previous;
    }
});
