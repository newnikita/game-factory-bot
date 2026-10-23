const https = require('https');
const { MODEL_CHAIN } = require('../lib/gemini');

const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
    console.error('::error::GEMINI_API_KEY не задан.');
    process.exit(1);
}

function redact(text) {
    return String(text).split(apiKey).join('***').slice(0, 400);
}

function probe(model) {
    return new Promise((resolve) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
        const body = JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 8 }
        });
        const request = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => resolve({ model, status: response.statusCode, body: data }));
        });
        request.on('error', (error) => resolve({ model, status: 0, body: error.message }));
        request.write(body);
        request.end();
    });
}

(async () => {
    const working = [];
    for (const model of MODEL_CHAIN) {
        const result = await probe(model);
        const ok = result.status === 200;
        console.log(`${ok ? 'OK' : 'ОТКАЗ'} ${model}: статус ${result.status}`);
        if (!ok) console.log(redact(result.body));
        if (ok) working.push(model);
    }
    console.log(`Рабочие модели: ${working.length ? working.join(', ') : 'нет'}`);
    if (!working.length) {
        console.error('::error::Ни одна модель Gemini не отвечает — прогон бессмыслен, детали выше.');
        process.exit(1);
    }
    process.exit(0);
})();
