const https = require('https');

const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
    console.error('::error::GEMINI_API_KEY не задан.');
    process.exit(1);
}

const model = process.env.GEMINI_PROBE_MODEL || 'gemini-2.5-flash';
const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
    generationConfig: { maxOutputTokens: 8 }
});

function redact(text) {
    return String(text).split(apiKey).join('***').slice(0, 600);
}

const request = https.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => {
        console.log(`Пробный запрос к ${model}: статус ${response.statusCode}`);
        console.log(redact(data));
        if (response.statusCode === 429 || response.statusCode === 403) {
            console.error(`::error::Gemini API отклонил пробный запрос (${response.statusCode}) — прогон бессмыслен, детали выше.`);
            process.exit(1);
        }
        if (response.statusCode >= 500) {
            console.error(`::error::Gemini API вернул ${response.statusCode} — прогон бессмыслен, детали выше.`);
            process.exit(1);
        }
        process.exit(0);
    });
});

request.on('error', (error) => {
    console.error('::error::Пробный запрос не прошёл:', error.message);
    process.exit(1);
});

request.write(body);
request.end();
