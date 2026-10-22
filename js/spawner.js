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
   * Кладка блока-архетипа в сетке cols x rows.
   * Все координаты задаются долями (0..1) от размера сетки, поэтому один и тот же
   * макет корректно масштабируется под динамическую плотность поля (7x5 / 8x6 / 9x7).
   */
  function layoutArchetype(L, archetype, isBoss, wave) {
    const round = (v) => Math.round(v * 1e6) / 1e6;
    // Дроби не приводятся к целым: addCell сама округляет размеры до клеток,
    // поэтому макет корректно масштабируется на любую сетку (7x5 / 8x6 / 9x7).
    const cell = (fx, fy, fw, fh, weight, opts) => L.addCell(fx * L.cols, fy * L.rows, fw * L.cols, fh * L.rows, weight, opts);
    const gate = (fx, fy, kind) => L.addSingleUseGate(Math.floor(fx * L.cols), Math.floor(fy * L.rows), kind);

    if (archetype === 'boss') {
      // Мега-Босс по центру + крыша сверху + TNT по бокам
      cell(2 / 7, 1 / 5, 3 / 7, 2 / 5, 4.8, { boss: true });
      // Верхняя крыша-отражатель (чтобы нельзя было зажать шары над боссом бесконечно)
      cell(0, 0, 1 / 7, 1 / 5, 1.4, { type: 'tri', cut: 'bl' });
      cell(2 / 7, 0, 1 / 7, 1 / 5, 1.5);
      cell(4 / 7, 0, 1 / 7, 1 / 5, 1.5);
      cell(6 / 7, 0, 1 / 7, 1 / 5, 1.4, { type: 'tri', cut: 'br' });
      // Боковые колонны и TNT
      cell(1 / 7, 2 / 5, 1 / 7, 1 / 5, 0.7, { tnt: true });
      cell(5 / 7, 2 / 5, 1 / 7, 1 / 5, 0.7, { tnt: true });
      cell(0, 3 / 5, 2 / 7, 1 / 5, 1.8, { shielded: true });
      cell(5 / 7, 3 / 5, 2 / 7, 1 / 5, 1.8, { shielded: true });
      cell(3 / 7, 4 / 5, 1 / 7, 1 / 5, 1.1);
      gate(3.5 / 7, 0.5 / 5, 'LASER');
    } else if (archetype === 'bunker') {
      // Бункер с крышей, бочкой TNT внутри и слабой пробкой снизу
      cell(1 / 7, 0, 5 / 7, 1 / 5, 1.8); // Сплошная крыша бункера
      cell(0, 0, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'bl' });
      cell(6 / 7, 0, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'br' });
      cell(1 / 7, 1 / 5, 1 / 7, 3 / 5, 1.6); // Левая стена
      cell(5 / 7, 1 / 5, 1 / 7, 3 / 5, 1.6); // Правая стена
      cell(3 / 7, 2 / 5, 1 / 7, 1 / 5, 0.65, { tnt: true }); // TNT в сердце бункера
      gate(2.5 / 7, 1.5 / 5, '+4 BALLS');
      gate(4.5 / 7, 1.5 / 5, 'LASER');
      // Передний щит бункера со слабой пробкой по центру
      cell(2 / 7, 3 / 5, 1 / 7, 1 / 5, 1.7, { shielded: true });
      cell(4 / 7, 3 / 5, 1 / 7, 1 / 5, 1.7, { shielded: true });
      cell(3 / 7, 3 / 5, 1 / 7, 1 / 5, 0.55); // Слабая пробка для пробития!
    } else if (archetype === 'diamond') {
      // Плинко-ромб с треугольными скосами и крышей
      cell(1 / 7, 0, 2 / 7, 1 / 5, 1.5);
      cell(4 / 7, 0, 2 / 7, 1 / 5, 1.5);
      cell(3 / 7, 0, 1 / 7, 1 / 5, 1.4);
      cell(0, 1 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'br' });
      cell(2 / 7, 1 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'bl' });
      cell(4 / 7, 1 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'br' });
      cell(6 / 7, 1 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'bl' });
      cell(3 / 7, 2 / 5, 1 / 7, 1 / 5, 0.65, { tnt: true });
      gate(1.5 / 7, 2.5 / 5, '+3 BALLS');
      gate(5.5 / 7, 2.5 / 5, 'LASER');
      cell(1 / 7, 3 / 5, 1 / 7, 1 / 5, 1.3, { type: 'tri', cut: 'tr' });
      cell(5 / 7, 3 / 5, 1 / 7, 1 / 5, 1.3, { type: 'tri', cut: 'tl' });
      cell(2 / 7, 4 / 5, 1 / 7, 1 / 5, 1.4);
      cell(4 / 7, 4 / 5, 1 / 7, 1 / 5, 1.4);
    } else if (archetype === 'phalanx') {
      // Бронированная фаланга: снизу щиты (надо рикошетить от стен за спину!)
      cell(1 / 7, 0, 5 / 7, 1 / 5, 1.5);
      cell(2 / 7, 1 / 5, 1 / 7, 1 / 5, 0.65, { tnt: true });
      cell(4 / 7, 1 / 5, 1 / 7, 1 / 5, 0.65, { tnt: true });
      gate(3.5 / 7, 1.5 / 5, '+5 BALLS');
      for (let c = 1; c <= 5; c++) {
        cell(c / 7, 3 / 5, 1 / 7, 1 / 5, 1.6, { shielded: true });
      }
      cell(0, 2 / 5, 1 / 7, 1 / 5, 1.1, { type: 'tri', cut: 'br' });
      cell(6 / 7, 2 / 5, 1 / 7, 1 / 5, 1.1, { type: 'tri', cut: 'bl' });
    } else if (archetype === 'citadels') {
      // Две башни по бокам и лазерный карман в центре
      for (let r = 0; r < 4; r++) {
        cell(0, r / 5, 2 / 7, 1 / 5, 1.5 + (r === 3 ? 0.3 : 0), { shielded: r === 3 });
        cell(5 / 7, r / 5, 2 / 7, 1 / 5, 1.5 + (r === 3 ? 0.3 : 0), { shielded: r === 3 });
      }
      cell(2 / 7, 0, 3 / 7, 1 / 5, 1.6); // Крыша над центральным карманом
      cell(3 / 7, 2 / 5, 1 / 7, 1 / 5, 0.6, { tnt: true });
      gate(3.5 / 7, 1.5 / 5, 'LASER');
      cell(2 / 7, 3 / 5, 1 / 7, 1 / 5, 1.1, { type: 'tri', cut: 'tr' });
      cell(4 / 7, 3 / 5, 1 / 7, 1 / 5, 1.1, { type: 'tri', cut: 'tl' });
    } else {
      // Hourglass (Песочные часы)
      cell(0, 0, 1, 1 / 5, 1.5); // Закрытый свод сверху
      cell(0, 1 / 5, 2 / 7, 1 / 5, 1.3);
      cell(5 / 7, 1 / 5, 2 / 7, 1 / 5, 1.3);
      cell(1 / 7, 2 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'tr' });
      cell(5 / 7, 2 / 5, 1 / 7, 1 / 5, 1.2, { type: 'tri', cut: 'tl' });
      cell(3 / 7, 2 / 5, 1 / 7, 1 / 5, 0.65, { tnt: true });
      gate(2.5 / 7, 1.5 / 5, '+4 BALLS');
      gate(4.5 / 7, 1.5 / 5, 'LASER');
      cell(1 / 7, 4 / 5, 2 / 7, 1 / 5, 1.4, { shielded: wave >= 4 });
      cell(4 / 7, 4 / 5, 2 / 7, 1 / 5, 1.4, { shielded: wave >= 4 });
    }
  }

  /** Тактическая фаза (волны 10-24): добавляем треугольные отражатели в свободные клетки */
  function addTacticalTriangles(L, rng, count) {
    const cuts = ['tl', 'tr', 'bl', 'br'];
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 12) {
      const col = Math.floor(rng() * L.cols);
      const row = Math.floor(rng() * L.rows);
      if (L.isFree(col, row)) {
        if (L.addCell(col, row, 1, 1, 1.2 + rng() * 0.4, { type: 'tri', cut: cuts[Math.floor(rng() * 4)] })) placed++;
      }
    }
  }

  /** Киберспортивная фаза (волны 25+): бронещиты на нижнем ряду — надо заходить через рикошет */
  function addHardcoreShields(L, rng, count) {
    let placed = 0, guard = 0;
    while (placed < count && guard++ < count * 12) {
      const col = Math.floor(rng() * L.cols);
      const row = L.rows - 1 - Math.floor(rng() * 2);
      const b = L.findBlockAtCell(col, row);
      if (b && !b.shielded && !b.tnt && !b.boss && !b.healer) {
        b.shielded = true;
        b.weight += 0.4;
        placed++;
      }
    }
  }

  /** Элитный блок-целитель (только волны 25+): лечит соседей на 15% HP в конце каждого хода */
  function addHealers(L, rng, count) {
    const cand = [];
    for (const b of L.blocks) {
      if (!b.boss && !b.tnt && !b.healer && b.type !== 'tri') cand.push(b);
    }
    for (let i = cand.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [cand[i], cand[j]] = [cand[j], cand[i]];
    }
    let placed = 0;
    for (const b of cand) {
      if (placed >= count) break;
      // Требование "убей его первым": у целителя должен быть хотя бы один живой сосед-блок
      let neighbors = 0;
      for (const o of L.blocks) {
        if (o === b) continue;
        if (Math.abs(o.col - b.col) <= 1 && Math.abs(o.row - b.row) <= 1) neighbors++;
      }
      if (neighbors < 2) continue;
      b.healer = true;
      placed++;
    }
    return placed;
  }

  /**
   * Создает осмысленные уровни с закрытыми крышами (без сквозного прострела потолка),
   * бочками TNT, одноразовыми бустами и точной калибровкой суммарного HP под 6-8 выстрелов.
   */
  Spawner.buildWave = function (wave, area, seed) {
    const C = global.RF.Config;
    seed = (seed === undefined ? ((wave * 2654435761) ^ Date.now()) >>> 0 : seed >>> 0);
    const rng = makeRng(seed);
    const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));

    const gs = C.gridSize(wave);
    const cols = gs.cols;
    const rows = gs.rows;
    const cellW = (area.w - (cols + 1) * C.CELL_GAP) / cols;
    const cellH = cellW * 0.88;

    const rawBlocks = [];
    const gates = [];
    const occ = Array.from({ length: cols }, () => new Array(rows).fill(false));

    function addCell(col, row, wCells, hCells, weight, opts) {
      opts = opts || {};
      col = Math.round(col); row = Math.round(row);
      wCells = Math.max(1, Math.round(wCells)); hCells = Math.max(1, Math.round(hCells));
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
        healer: !!opts.healer,
        wCells, hCells,
        tnt: !!opts.tnt,
        dead: false, flash: 0, squash: 0
      };
      rawBlocks.push(b);
      return b;
    }

    function addSingleUseGate(col, row, kind) {
      col = Math.floor(col); row = Math.floor(row);
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

    // Единый макет-архетип, масштабируемый под динамическую сетку (7x5 / 8x6 / 9x7)
    const L = {
      cols, rows,
      blocks: rawBlocks,
      addCell, addSingleUseGate,
      isFree: (col, row) => col >= 0 && col < cols && row >= 0 && row < rows && !occ[col][row],
      findBlockAtCell: (col, row) => {
        for (const b of rawBlocks) {
          if (!b.dead && col >= b.col && col < b.col + b.wCells && row >= b.row && row < b.row + b.hCells) return b;
        }
        return null;
      }
    };
    layoutArchetype(L, archetype, isBoss, wave);

    // Фазы сложности: плотность поля растет от расслабона к хардкору
    if (wave >= 10 && wave < 25) {
      addTacticalTriangles(L, rng, ri(3, 5));       // тактика: треугольные отражатели
      addHardcoreShields(L, rng, ri(1, 2));         // и немного бронещитов
    } else if (wave >= 25) {
      addTacticalTriangles(L, rng, ri(4, 7));       // киберспорт: лабиринты из скосов
      addHardcoreShields(L, rng, ri(3, 5));         // плотная броня снизу
      addHealers(L, rng, wave >= 40 ? 2 : 1);       // элитные целители — убивать первыми!
    }

    // Калибровка HP каждого блока так, чтобы суммарное HP волны строго попадало в 6-8 выстрелов
    const totalTargetHp = C.targetWaveTotalHp(wave, isBoss);
    let weightSum = 0;
    for (const b of rawBlocks) weightSum += b.weight;
    weightSum = Math.max(1, weightSum);

    let maxBlockHp = 10;
    for (const b of rawBlocks) {
      const effW = b.weight * (b.healer ? 1.35 : 1); // элитный целитель — жирная приоритетная цель
      const hp = Math.max(8, Math.round((effW / weightSum) * totalTargetHp));
      b.hp = hp;
      b.maxHp = hp;
      if (hp > maxBlockHp && !b.boss) maxBlockHp = hp;
    }

    return { blocks: rawBlocks, gates, seed, maxBlockHp, cellH: cellH + C.CELL_GAP };
  };

  /** Доспавн верхнего ряда подкрепления в режиме выбывания (волна 10+) */
  Spawner.spawnReinforcementRow = function (wave, area, yTop) {
    const C = global.RF.Config;
    const cols = C.gridSize(wave).cols;
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