(function (global) {
  'use strict';

  const Spawner = {};
  let _id = 1;

  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  Spawner.isFunnelWave = function (w) { return w % 3 === 0 && w % 5 !== 0; };
  Spawner.isBossWave = function (w) { return w % 5 === 0; };

  /**
   * Создает осмысленные уровни с закрытыми крышами (без сквозного прострела потолка),
   * бочками TNT, одноразовыми бустами и точной калибровкой суммарного HP под 6-8 выстрелов.
   */
  Spawner.buildWave = function (wave, area, seed) {
    const C = global.RF.Config;
    seed = (seed === undefined ? ((wave * 2654435761) ^ Date.now()) >>> 0 : seed >>> 0);
    const rng = makeRng(seed);
    const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));

    const cols = C.COLS;
    const cellW = (area.w - (cols + 1) * C.CELL_GAP) / cols;
    const cellH = cellW * 0.88;
    const rows = 5;

    const rawBlocks = [];
    const gates = [];
    const occ = Array.from({ length: cols }, () => new Array(rows).fill(false));

    function addCell(col, row, wCells, hCells, weight, opts) {
      opts = opts || {};
      if (col < 0 || row < 0 || col + wCells > cols || row + hCells > rows) return null;
      for (let c = col; c < col + wCells; c++) {
        for (let r = row; r < row + hCells; r++) {
          if (occ[c][r]) return null;
        }
      }
      for (let c = col; c < col + wCells; c++) {
        for (let r = row; r < row + hCells; r++) occ[c][r] = true;
      }
      const x = area.x + C.CELL_GAP + col * (cellW + C.CELL_GAP);
      const y = area.y + C.CELL_GAP + row * (cellH + C.CELL_GAP);
      const w = cellW * wCells + C.CELL_GAP * (wCells - 1);
      const h = cellH * hCells + C.CELL_GAP * (hCells - 1);

      const b = {
        id: _id++, x, y, w, h, baseX: x, baseY: y,
        col, row,
        weight: weight || 1,
        hp: 10, maxHp: 10,
        type: opts.type || 'rect',
        cut: opts.cut || null,
        boss: !!opts.boss,
        shielded: !!opts.shielded,
        tnt: !!opts.tnt,
        dead: false, flash: 0, squash: 0
      };
      rawBlocks.push(b);
      return b;
    }

    function addSingleUseGate(col, row, kind) {
      if (col < 0 || col >= cols || row < 0 || row >= rows) return;
      occ[col][row] = true;
      const x = area.x + C.CELL_GAP + col * (cellW + C.CELL_GAP) + cellW / 2;
      const y = area.y + C.CELL_GAP + row * (cellH + C.CELL_GAP) + cellH / 2;
      gates.push({
        id: _id++, x, y,
        kind: kind, // '+3 BALLS', '+5 BALLS', 'LASER'
        r: 15, w: 38, h: 22,
        pulse: rng() * 6,
        flash: 0,
        spent: false
      });
    }

    const isBoss = Spawner.isBossWave(wave);
    const archetype = isBoss ? 'boss' : ['bunker', 'diamond', 'phalanx', 'citadels', 'hourglass'][(wave - 1) % 5];

    if (archetype === 'boss') {
      // Мега-Босс по центру + крыша сверху + TNT по бокам
      addCell(2, 1, 3, 2, 4.8, { boss: true });
      // Верхняя крыша-отражатель (чтобы нельзя было зажать шары над боссом бесконечно)
      addCell(0, 0, 1, 1, 1.4, { type: 'tri', cut: 'bl' });
      addCell(2, 0, 1, 1, 1.5);
      addCell(4, 0, 1, 1, 1.5);
      addCell(6, 0, 1, 1, 1.4, { type: 'tri', cut: 'br' });
      // Боковые колонны и TNT
      addCell(1, 2, 1, 1, 0.7, { tnt: true });
      addCell(5, 2, 1, 1, 0.7, { tnt: true });
      addCell(0, 3, 2, 1, 1.8, { shielded: true });
      addCell(5, 3, 2, 1, 1.8, { shielded: true });
      addCell(3, 4, 1, 1, 1.1);
      addSingleUseGate(3, 0, 'LASER');
    } else if (archetype === 'bunker') {
      // Бункер с крышей, бочкой TNT внутри и слабой пробкой снизу
      addCell(1, 0, 5, 1, 1.8); // Сплошная крыша бункера
      addCell(0, 0, 1, 1, 1.2, { type: 'tri', cut: 'bl' });
      addCell(6, 0, 1, 1, 1.2, { type: 'tri', cut: 'br' });
      addCell(1, 1, 1, 3, 1.6); // Левая стена
      addCell(5, 1, 1, 3, 1.6); // Правая стена
      addCell(3, 2, 1, 1, 0.65, { tnt: true }); // TNT в сердце бункера
      addSingleUseGate(2, 1, '+4 BALLS');
      addSingleUseGate(4, 1, 'LASER');
      // Передний щит бункера со слабой пробкой по центру
      addCell(2, 3, 1, 1, 1.7, { shielded: true });
      addCell(4, 3, 1, 1, 1.7, { shielded: true });
      addCell(3, 3, 1, 1, 0.55); // Слабая пробка для пробития!
    } else if (archetype === 'diamond') {
      // Плинко-ромб с треугольными скосами и крышей
      addCell(1, 0, 2, 1, 1.5);
      addCell(4, 0, 2, 1, 1.5);
      addCell(3, 0, 1, 1, 1.4);
      addCell(0, 1, 1, 1, 1.2, { type: 'tri', cut: 'br' });
      addCell(2, 1, 1, 1, 1.2, { type: 'tri', cut: 'bl' });
      addCell(4, 1, 1, 1, 1.2, { type: 'tri', cut: 'br' });
      addCell(6, 1, 1, 1, 1.2, { type: 'tri', cut: 'bl' });
      addCell(3, 2, 1, 1, 0.65, { tnt: true });
      addSingleUseGate(1, 2, '+3 BALLS');
      addSingleUseGate(5, 2, 'LASER');
      addCell(1, 3, 1, 1, 1.3, { type: 'tri', cut: 'tr' });
      addCell(5, 3, 1, 1, 1.3, { type: 'tri', cut: 'tl' });
      addCell(2, 4, 1, 1, 1.4);
      addCell(4, 4, 1, 1, 1.4);
    } else if (archetype === 'phalanx') {
      // Бронированная фаланга: снизу щиты (надо рикошетить от стен за спину!)
      addCell(1, 0, 5, 1, 1.5);
      addCell(2, 1, 1, 1, 0.65, { tnt: true });
      addCell(4, 1, 1, 1, 0.65, { tnt: true });
      addSingleUseGate(3, 1, '+5 BALLS');
      for (let c = 1; c <= 5; c++) {
        addCell(c, 3, 1, 1, 1.6, { shielded: true });
      }
      addCell(0, 2, 1, 1, 1.1, { type: 'tri', cut: 'br' });
      addCell(6, 2, 1, 1, 1.1, { type: 'tri', cut: 'bl' });
    } else if (archetype === 'citadels') {
      // Две башни по бокам и лазерный карман в центре
      for (let r = 0; r < 4; r++) {
        addCell(0, r, 2, 1, 1.5 + (r === 3 ? 0.3 : 0), { shielded: r === 3 });
        addCell(5, r, 2, 1, 1.5 + (r === 3 ? 0.3 : 0), { shielded: r === 3 });
      }
      addCell(2, 0, 3, 1, 1.6); // Крыша над центральным карманом
      addCell(3, 2, 1, 1, 0.6, { tnt: true });
      addSingleUseGate(3, 1, 'LASER');
      addCell(2, 3, 1, 1, 1.1, { type: 'tri', cut: 'tr' });
      addCell(4, 3, 1, 1, 1.1, { type: 'tri', cut: 'tl' });
    } else {
      // Hourglass (Песочные часы)
      addCell(0, 0, 7, 1, 1.5); // Закрытый свод сверху
      addCell(0, 1, 2, 1, 1.3);
      addCell(5, 1, 2, 1, 1.3);
      addCell(1, 2, 1, 1, 1.2, { type: 'tri', cut: 'tr' });
      addCell(5, 2, 1, 1, 1.2, { type: 'tri', cut: 'tl' });
      addCell(3, 2, 1, 1, 0.65, { tnt: true });
      addSingleUseGate(2, 1, '+4 BALLS');
      addSingleUseGate(4, 1, 'LASER');
      addCell(1, 4, 2, 1, 1.4, { shielded: wave >= 4 });
      addCell(4, 4, 2, 1, 1.4, { shielded: wave >= 4 });
    }

    // Калибровка HP каждого блока так, чтобы суммарное HP волны строго попадало в 6-8 выстрелов
    const totalTargetHp = C.targetWaveTotalHp(wave, isBoss);
    let weightSum = 0;
    for (const b of rawBlocks) weightSum += b.weight;
    weightSum = Math.max(1, weightSum);

    let maxBlockHp = 10;
    for (const b of rawBlocks) {
      const hp = Math.max(8, Math.round((b.weight / weightSum) * totalTargetHp));
      b.hp = hp;
      b.maxHp = hp;
      if (hp > maxBlockHp && !b.boss) maxBlockHp = hp;
    }

    return { blocks: rawBlocks, gates, seed, maxBlockHp, cellH: cellH + C.CELL_GAP };
  };

  /** Доспавн верхнего ряда подкрепления в режиме выбывания (волна 10+) */
  Spawner.spawnReinforcementRow = function (wave, area, yTop) {
    const C = global.RF.Config;
    const cols = C.COLS;
    const cellW = (area.w - (cols + 1) * C.CELL_GAP) / cols;
    const cellH = cellW * 0.88;
    const rowHp = Math.max(15, Math.round(C.expectedVolleyDamage(wave) * 0.25));
    const list = [];
    const gapCol = Math.floor(Math.random() * cols);
    for (let c = 0; c < cols; c++) {
      if (c === gapCol) continue;
      const isTnt = Math.random() < 0.16;
      const x = area.x + C.CELL_GAP + c * (cellW + C.CELL_GAP);
      const hp = isTnt ? Math.round(rowHp * 0.5) : rowHp;
      list.push({
        id: _id++, x, y: yTop, w: cellW, h: cellH, baseX: x, baseY: yTop,
        hp, maxHp: hp, type: 'rect', cut: null,
        boss: false, shielded: false, tnt: isTnt,
        dead: false, flash: 1, squash: 0
      });
    }
    return list;
  };

  global.RF = global.RF || {};
  global.RF.Spawner = Spawner;
})(window);