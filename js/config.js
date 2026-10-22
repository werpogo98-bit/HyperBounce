(function (global) {
  'use strict';

  const Config = {
    COLS: 7,
    GRID_TOP_FRAC: 0.10,
    GRID_BOTTOM_FRAC: 0.56,
    CELL_GAP: 4,
    BLOCK_RADIUS: 8,
    LAUNCH_ZONE_H: 105,

    BALL_BASE_RADIUS: 6.5,
    BALL_MAX_RADIUS: 13,
    SHOOT_INTERVAL: 0.05,
    AIM_MIN_ELEV_DEG: 11,
    GRAVITY: 620,
    LAUNCH_SPEED: 980,
    MUZZLE_OFFSET: 28,
    ANTI_STUCK_GRAVITY: 110,
    RESTITUTION: 0.95,
    WALL_RESTITUTION: 0.98,
    // Трение по касательной к грани полублока (0 = нет трения, 1 = стоп).
    // Небольшое значение гасит «лыжное» скольжение мяча по скосу за острие.
    TRI_FRICTION: 0.22,
    MAX_SPEED: 1400,
    MIN_SPEED: 280,
    AIR_DRAG: 0.0006,

    FIXED_DT: 1 / 120,
    SUBSTEPS_PER_STEP: 2,
    MAX_STEPS_PER_FRAME: 6,

    FF_AFTER_S: 3.5,
    FF_LEVELS: [1, 2, 3.5],

    PHYS_BALL_CAP: 250,
    MERGE_DAMAGE_RATIO: 0.95,

    /* --- Рассчитанный баланс волн (6-8 обычных выстрелов или 4 снайперских) --- */
    START_BALLS: 5,
    START_DAMAGE: 2,
    START_CRIT: 0.06,
    CRIT_MULT: 2.2,

    WAVE_SHOT_LIMIT: 8,
    BOSS_SHOT_LIMIT: 10,
    ELIMINATE_FROM_WAVE: 10,

    /* --- Экономика и Магазин (4 улучшения) --- */
    GOLD_PER_BLOCK: 2,
    GOLD_WAVE_CLEAR: 18,
    GOLD_PER_SAVED_SHOT: 8,

    UPGRADES: {
      count: {
        label: '+Balls', icon: '⚪',
        baseCost: 14, costMult: 1.36, maxLevel: 25,
        desc: '+1 ball per volley'
      },
      damage: {
        label: '+Damage', icon: '💥',
        baseCost: 12, costMult: 1.34, maxLevel: 30,
        desc: '+1.5 base damage'
      },
      crit: {
        label: '+Crit/Armor', icon: '⚡',
        baseCost: 18, costMult: 1.42, maxLevel: 15,
        desc: '+4% crit & shield pierce'
      },
      blast: {
        label: '+Shockwave', icon: '💣',
        baseCost: 24, costMult: 1.48, maxLevel: 12,
        desc: 'Every 8th hit blasts area'
      }
    },

    HEATMAP: [
      '#7FB8A4', // приглушённая мята — низкий HP
      '#9BC4A8', // шалфей
      '#C9B98A', // тёплый песок
      '#E0B36A', // карамель
      '#E29A63', // терракота светлая
      '#D97F5F', // терракота
      '#C96A6A', // кирпичная роза
      '#B85C7A'  // пыльная роза — высокий HP
    ],
    BOSS_COLOR: '#B85C7A',
    TNT_COLOR: '#E29A63',
    BALL_COLORS: ['#F4A261', '#E9C46A', '#7FB8A4', '#E76F51', '#C9A7C4'],
    SUPER_BALL_COLOR: '#E9C46A',
    MEGA_BALL_COLOR: '#E76F51',
    CANNON: '#F4A261',
    BG: '#241F2C',
    BG_TOP: '#2B2534',
    BG_PANEL: '#322B3B',
    TEXT: '#FFF6EA',

    STORAGE_KEY: 'rf_roguelike_best_v2',
    TUTORIAL_KEY: 'rf_tutorial_seen_v2'
  };

  /** Ожидаемый урон одного залпа игрока на волне W (для калибровки HP волны) */
  Config.expectedVolleyDamage = function (wave) {
    const estBalls = Config.START_BALLS + Math.floor((wave - 1) * 0.75);
    const estDmg = Config.START_DAMAGE + (wave - 1) * 1.1;
    const avgBouncesPerBall = 4.2;
    return estBalls * estDmg * avgBouncesPerBall;
  };

  /** Целевой суммарный пул HP всей волны (чтобы требовалось 6-7 залпов, минимум 4 идеальных) */
  Config.targetWaveTotalHp = function (wave, isBoss) {
    const volley = Config.expectedVolleyDamage(wave);
    const targetShots = isBoss ? 7.8 : (wave <= 2 ? 5.2 : 6.4);
    return Math.round(volley * targetShots);
  };

  Config.heatColor = function (hp, maxWaveHp) {
    const ref = Math.max(10, maxWaveHp || 30);
    const ratio = Math.min(1, Math.max(0, hp / ref));
    const idx = Math.min(Config.HEATMAP.length - 1, Math.floor(ratio * (Config.HEATMAP.length - 1)));
    return Config.HEATMAP[idx];
  };

  Config.upgradeCost = function (key, level) {
    const u = Config.UPGRADES[key];
    return Math.floor(u.baseCost * Math.pow(u.costMult, level));
  };

  global.RF = global.RF || {};
  global.RF.Config = Config;
})(window);