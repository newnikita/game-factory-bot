const { gamesFromBalance } = require('./plans');

const REFUND_MODES = new Set(['money', 'games', 'force']);

function normalizeMode(mode) {
    const value = String(mode || '').toLowerCase();
    return REFUND_MODES.has(value) ? value : 'money';
}

// Деньги не возвращаются, если игры по платежу уже потрачены: иначе пользователь
// получает и Stars, и оплаченные игры. Режим force — явное решение администратора.
function planRefund(options) {
    const balance = Math.max(0, Math.trunc(Number(options && options.balance) || 0));
    const granted = Math.max(0, Math.trunc(Number(options && options.gamesGranted) || 0));
    const mode = normalizeMode(options && options.mode);

    if (mode === 'games') {
        return { action: 'repair', games: gamesFromBalance(granted), granted };
    }
    if (granted > balance && mode !== 'force') {
        return { action: 'refuse', reason: 'games_spent', balance, granted, mode };
    }
    return { action: 'refund', remove: Math.min(balance, granted), granted, forced: mode === 'force' };
}

module.exports = {
    REFUND_MODES,
    normalizeMode,
    planRefund
};
