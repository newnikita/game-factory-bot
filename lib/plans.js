const COST_PER_GAME = 25;

const PLANS = {
    pack3: {
        id: 'pack3',
        title: 'Пакет «Попробовать»',
        description: '3 игры, без подписки',
        games: 3,
        stars: 120,
        rub: 249,
        periodDays: 0,
        badge: 'Разовый'
    },
    starter: {
        id: 'starter',
        title: 'Starter',
        description: '15 игр в месяц, автопродление',
        games: 15,
        stars: 450,
        rub: 690,
        periodDays: 30,
        badge: 'Старт'
    },
    creator: {
        id: 'creator',
        title: 'Creator',
        description: '50 игр в месяц, автопродление',
        games: 50,
        stars: 1400,
        rub: 1990,
        periodDays: 30,
        badge: 'Хит'
    },
    studio: {
        id: 'studio',
        title: 'Studio',
        description: '150 игр в месяц, приоритет, автопродление',
        games: 150,
        stars: 4000,
        rub: 7900,
        periodDays: 30,
        badge: 'B2B'
    },
    campaign: {
        id: 'campaign',
        title: 'Кампания',
        description: '15 игр для мероприятия или бренда, разовый пакет',
        games: 15,
        stars: 900,
        rub: 1990,
        periodDays: 0,
        badge: 'Событие'
    }
};

function getPlan(id) {
    return Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null;
}

function gamesGranted(plan) {
    return Math.max(0, Math.trunc(Number(plan && plan.games) || 0)) * COST_PER_GAME;
}

function gamesFromBalance(balance) {
    return Math.floor(Math.max(0, Number(balance) || 0) / COST_PER_GAME);
}

function gamesLabel(count) {
    const n = Math.max(0, Math.trunc(Number(count) || 0));
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return `${n} игра`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} игры`;
    return `${n} игр`;
}

module.exports = {
    COST_PER_GAME,
    PLANS,
    getPlan,
    gamesGranted,
    gamesFromBalance,
    gamesLabel
};
