const RECENT_LIMIT = 60;
const CRITIC_WINDOW = 10;
const CRITIC_UNAVAILABLE_MIN = 3;
const FAILURE_STREAK_MIN = 3;
const QUOTA_ALERT_WINDOW_MS = 6 * 3600 * 1000;

function emptyState() {
    return {
        startedAt: Date.now(),
        generations: { started: 0, succeeded: 0, failed: 0, consecutiveFailures: 0 },
        pipeline: {
            patched: 0,
            repaired: 0,
            polished: 0,
            tdzRepaired: 0,
            patchFailed: 0,
            repairFailed: 0,
            polishFailed: 0,
            criticModel: 0,
            criticAudit: 0
        },
        quotaErrors: [],
        canvas: { reports: 0, blank: 0, hidden: 0, blankGames: [] },
        scores: [],
        recent: []
    };
}

let state = emptyState();

function pushRecent(entry) {
    state.recent.push({ at: Date.now(), ...entry });
    if (state.recent.length > RECENT_LIMIT) state.recent.splice(0, state.recent.length - RECENT_LIMIT);
}

function recordGenerationStarted() {
    state.generations.started += 1;
    pushRecent({ kind: 'generation_started' });
}

function recordGenerationSucceeded(details = {}) {
    const score = Number.isFinite(details.score) ? details.score : null;
    state.generations.succeeded += 1;
    state.generations.consecutiveFailures = 0;
    if (score !== null) {
        state.scores.push(score);
        if (state.scores.length > 50) state.scores.shift();
    }
    pushRecent({ kind: 'generation_succeeded', score, criticSource: details.criticSource || null });
}

function recordGenerationFailed(details = {}) {
    const error = String(details.error || '').slice(0, 200);
    state.generations.failed += 1;
    state.generations.consecutiveFailures += 1;
    pushRecent({ kind: 'generation_failed', error });
}

const STAGE_COUNTERS = {
    patch: ['patched', 'patchFailed'],
    repair: ['repaired', 'repairFailed'],
    polish: ['polished', 'polishFailed']
};

function recordPipelineStage(stage, ok) {
    const counters = STAGE_COUNTERS[stage];
    if (!counters) return;
    state.pipeline[counters[ok ? 0 : 1]] += 1;
}

function recordTdzRepaired(count = 1) {
    state.pipeline.tdzRepaired += Math.max(0, Number(count) || 0);
}

function recordCritic(source) {
    if (source === 'audit') state.pipeline.criticAudit += 1;
    else state.pipeline.criticModel += 1;
}

function recordQuotaError() {
    state.quotaErrors.push(Date.now());
    if (state.quotaErrors.length > 20) state.quotaErrors.shift();
}

function recordCanvasReport(details = {}) {
    state.canvas.reports += 1;
    if (details.blank) {
        state.canvas.blank += 1;
        const gameId = String(details.gameId || '');
        if (gameId && !state.canvas.blankGames.includes(gameId)) {
            state.canvas.blankGames.push(gameId);
            if (state.canvas.blankGames.length > 10) state.canvas.blankGames.shift();
        }
    }
}

function recordCanvasHidden() {
    state.canvas.hidden += 1;
}

function averageScore() {
    if (!state.scores.length) return null;
    const sum = state.scores.reduce((acc, value) => acc + value, 0);
    return Math.round((sum / state.scores.length) * 10) / 10;
}

function quotaErrorsRecent(windowMs = QUOTA_ALERT_WINDOW_MS) {
    const since = Date.now() - windowMs;
    return state.quotaErrors.filter((at) => at >= since).length;
}

function snapshot() {
    return {
        uptimeMs: Date.now() - state.startedAt,
        generations: { ...state.generations },
        pipeline: { ...state.pipeline },
        quotaErrors: state.quotaErrors.length,
        quotaErrorsRecent: quotaErrorsRecent(),
        canvas: { ...state.canvas, blankGames: [...state.canvas.blankGames] },
        averageScore: averageScore()
    };
}

function evaluate() {
    const alerts = [];

    if (state.generations.consecutiveFailures >= FAILURE_STREAK_MIN) {
        const last = [...state.recent].reverse().find((entry) => entry.kind === 'generation_failed');
        alerts.push({
            key: 'generation_failures',
            level: 'critical',
            text: `Генерации падают ${state.generations.consecutiveFailures} раза подряд. Последняя ошибка: ${(last && last.error) || 'неизвестна'}`
        });
    }

    const recentGenerations = state.recent.filter((entry) => entry.kind === 'generation_succeeded').slice(-CRITIC_WINDOW);
    const audits = recentGenerations.filter((entry) => entry.criticSource === 'audit').length;
    if (recentGenerations.length >= CRITIC_WINDOW && audits >= CRITIC_UNAVAILABLE_MIN) {
        alerts.push({
            key: 'critic_unavailable',
            level: 'warn',
            text: `Критик Gemini не ответил в ${audits} играх из последних ${recentGenerations.length}: игры оценивает статический аудит кода, а не модель`
        });
    }

    const recentQuotaErrors = quotaErrorsRecent();
    if (recentQuotaErrors) {
        alerts.push({
            key: 'quota_exhausted',
            level: 'critical',
            text: `Квота Gemini исчерпана (${recentQuotaErrors} за последние 6 часов): генерации и критика идут на резервных моделях или по аудиту`
        });
    }

    if (state.canvas.blank) {
        alerts.push({
            key: 'canvas_blank',
            level: 'warn',
            text: `Игры с пустым экраном: ${state.canvas.blank} (${state.canvas.blankGames.join(', ') || 'без идентификаторов'})`
        });
    }

    return alerts;
}

function reset() {
    state = emptyState();
}

module.exports = {
    recordGenerationStarted,
    recordGenerationSucceeded,
    recordGenerationFailed,
    recordPipelineStage,
    recordTdzRepaired,
    recordCritic,
    recordQuotaError,
    recordCanvasReport,
    recordCanvasHidden,
    snapshot,
    evaluate,
    reset
};
