(function (global) {
  'use strict';

  const C = global.RF.Config;
  const Phys = global.RF.Physics;
  const Sfx = global.RF.Audio;
  const Spawner = global.RF.Spawner;

  const ST = {
    AIMING: 'AIMING',
    FIRING: 'FIRING',
    SIMULATING: 'SIMULATING',
    DESCENDING: 'DESCENDING',
    GAMEOVER: 'GAMEOVER'
  };

  let canvas, ctx, stageEl;
  let dpr = 1, cssW = 0, cssH = 0, viewW = 0, viewH = 0, uiScale = 1;
  let floorY = 0, launchX = 0, launchY = 0;
  let fieldArea = { x: 0, y: 0, w: 0, h: 0 };

  const G = {
    state: ST.AIMING,
    wave: 1,
    score: 0,
    highScore: 0,
    coins: 0,
    shotsLeftInWave: 8,
    maxShotsInWave: 8,
    ballsTotal: 0,
    balls: [],
    blocks: [],
    gates: [],
    lasers: [],
    particles: [],
    floaters: [],
    upgrades: { count: 0, damage: 0, crit: 0, blast: 0 },
    volleyCount: C.START_BALLS,
    baseDamage: C.START_DAMAGE,
    dmgMult: 1,
    critChance: C.START_CRIT,
    comboHits: 0,      // удары по блокам за текущий залп (для фонового комбо-счётчика)
    comboPulse: 0,     // время последнего удара — для пульсации текста
    hitstopT: 0,       // остаток микро-заморозки кадра (hitstop) при больших комбо
    aimAngle: -Math.PI / 2,
    aiming: false,
    hasPointer: false,
    shootTimer: 0,
    shotsLeft: 0,
    simTime: 0,
    simClock: 0, // физическое время симуляции (учитывает ff-ускорение) — для честных кулдаунов ударов
    hitAccum: null,
    ffIndex: 0,
    descendOffset: 0,
    targetDescendOffset: 0,
    cellStepPx: 48,
    maxWaveBlockHp: 30,
    hitCounter: 0,
    dangerPulse: 0,
    shake: 0,
    overShown: false,
    waveSeed: 0,
    lastTs: 0,
    running: true
  };

  function saveBest() {
    try {
      localStorage.setItem(C.STORAGE_KEY, JSON.stringify({ highScore: G.highScore }));
    } catch (e) {}
  }

  function loadBest() {
    try {
      const raw = localStorage.getItem(C.STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        G.highScore = d.highScore || 0;
      }
    } catch (e) {}
    recomputeStats();
  }

  function recomputeStats() {
    G.volleyCount = C.START_BALLS + G.upgrades.count;
    // Milestone: каждые 5 уровней damage — мультипликативный бонус x1.25 к базовому урону
    const milestones = Math.floor(G.upgrades.damage / C.DMG_MILESTONE_EVERY);
    G.dmgMult = Math.pow(C.DMG_MILESTONE_MULT, milestones);
    G.baseDamage = (C.START_DAMAGE + G.upgrades.damage * 1.5) * G.dmgMult;
    G.critChance = C.START_CRIT + G.upgrades.crit * 0.04;
  }

  function resize() {
    const rect = stageEl.getBoundingClientRect();
    cssW = Math.max(280, rect.width);
    cssH = Math.max(320, rect.height);
    dpr = Math.min(2.2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    uiScale = Math.max(1, Math.min(1.5, Math.sqrt((cssW * cssH) / (420 * 720))));
    ctx.setTransform(dpr * uiScale, 0, 0, dpr * uiScale, 0, 0);

    viewW = cssW / uiScale;
    viewH = cssH / uiScale;
    floorY = viewH - 8;
    launchX = viewW / 2;
    launchY = viewH - 48;

    const fieldBottom = Math.min(viewH * C.GRID_BOTTOM_FRAC, launchY - C.LAUNCH_ZONE_H);
    fieldArea = {
      x: 8,
      y: viewH * C.GRID_TOP_FRAC,
      w: viewW - 16,
      h: Math.max(140, fieldBottom - viewH * C.GRID_TOP_FRAC)
    };
  }

  function nextWave() {
    const built = Spawner.buildWave(G.wave, fieldArea, G.waveSeed || undefined);
    G.waveSeed = built.seed;
    G.blocks = built.blocks;
    G.gates = built.gates;
    G.maxWaveBlockHp = built.maxBlockHp || 30;
    G.cellStepPx = built.cellH || 48;
    G.descendOffset = 0;
    G.targetDescendOffset = 0;

    const isBoss = Spawner.isBossWave(G.wave);
    G.maxShotsInWave = isBoss ? C.BOSS_SHOT_LIMIT : C.WAVE_SHOT_LIMIT;
    G.shotsLeftInWave = G.maxShotsInWave;
    uiSetWave();
  }

  function aliveBlocks() {
    for (let i = 0; i < G.blocks.length; i++) {
      if (!G.blocks[i].dead) return true;
    }
    return false;
  }

  /** Элитные целители (healer): в конце каждого хода лечат живых соседей на 15% maxHp */
  function healerEndOfTurn() {
    let anyHealed = false;
    for (const h of G.blocks) {
      if (h.dead || !h.healer) continue;
      for (const b of G.blocks) {
        if (b.dead || b === h) continue;
        // соседство по сетке: касается или стоит вплотную (зазор <= CELL_GAP*2)
        const nearX = Math.abs((h.x + h.w / 2) - (b.x + b.w / 2)) <= (h.w + b.w) / 2 + C.CELL_GAP * 2;
        const nearY = Math.abs((h.y + h.h / 2) - (b.y + b.h / 2)) <= (h.h + b.h) / 2 + C.CELL_GAP * 2;
        if (!(nearX && nearY)) continue;
        const before = b.hp;
        b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.15);
        if (b.hp > before + 0.5) {
          anyHealed = true;
          b.flash = 1;
          addFloater(b.x + b.w / 2, b.y + G.descendOffset, '+HEAL', '#7FBF8A', 12);
        }
      }
    }
    if (anyHealed) {
      addFloater(viewW / 2, launchY - C.LAUNCH_ZONE_H, '➕ HEALER RESTORED NEIGHBORS — KILL IT FIRST!', '#7FBF8A', 13);
    }
  }

  let _ballId = 1;
  function makeBall(x, y, vx, vy, damage) {
    return {
      id: _ballId++, x, y, vx, vy,
      r: C.BALL_BASE_RADIUS,
      damage: damage,
      virtual: 1,
      color: C.BALL_COLORS[_ballId % C.BALL_COLORS.length],
      tier: Math.floor(G.upgrades.damage / C.DMG_MILESTONE_EVERY), // визуальная эволюция шара (milestone damage)
      collected: false,
      squash: 0, stretch: 0,
      trail: [],
      _hitTimes: {}
    };
  }

  function addBallBounded(b) {
    if (G.balls.length < C.PHYS_BALL_CAP) {
      G.balls.push(b);
      return b;
    }
    const target = G.balls[Math.floor(Math.random() * G.balls.length)];
    target.damage += b.damage * C.MERGE_DAMAGE_RATIO;
    target.virtual += b.virtual;
    target.r = Math.min(C.BALL_MAX_RADIUS, target.r * 1.12);
    target.color = C.SUPER_BALL_COLOR;
    Sfx.merge();
    return target;
  }

  /** Одноразовые бусты: срабатывают строго от первого шара и сразу исчезают */
  function checkGates(ball) {
    const off = G.descendOffset;
    for (let i = 0; i < G.gates.length; i++) {
      const g = G.gates[i];
      if (g.spent) continue;
      const gy = g.y + off;
      if (Math.hypot(ball.x - g.x, ball.y - gy) > g.r + ball.r + 3) continue;

      g.spent = true; // Мгновенное одноразовое потребление!
      if (g.kind === 'LASER') {
        fireLaserCross(g.x, gy);
      } else {
        const extra = g.kind === '+5 BALLS' ? 5 : 3;
        for (let k = 0; k < extra; k++) {
          const ang = -Math.PI / 2 + (k - (extra - 1) / 2) * 0.22;
          const sp = C.LAUNCH_SPEED * 0.9;
          const nb = makeBall(g.x, gy, Math.cos(ang) * sp, Math.sin(ang) * sp, ball.damage);
          G.ballsTotal += 1;
          addBallBounded(nb);
        }
        Sfx.gate(2);
        spawnParticles(g.x, gy, '#4CC9F0', 16, 160);
        addFloater(g.x, gy - 12, g.kind + '!', '#4CC9F0', 16);
      }
    }
  }

  function fireLaserCross(lx, ly) {
    Sfx.gate(3);
    G.shake = Math.min(10, G.shake + 6);
    G.lasers.push({ x: lx, y: ly, t: 0, life: 0.28 });
    addFloater(lx, ly - 14, '⚡ LASER CROSS!', '#FFD166', 17);

    const laserDmg = Math.round(G.baseDamage * 3.8);
    const off = G.descendOffset;
    for (const blk of G.blocks) {
      if (blk.dead) continue;
      const by = blk.y + off;
      const hitRow = Math.abs((by + blk.h / 2) - ly) < blk.h * 0.75;
      const hitCol = Math.abs((blk.x + blk.w / 2) - lx) < blk.w * 0.75;
      if (hitRow || hitCol) {
        blk.hp -= laserDmg;
        blk.flash = 1;
        addFloater(blk.x + blk.w / 2, by + blk.h / 2, '-' + laserDmg, '#4CC9F0', 14);
        if (blk.hp <= 0) destroyBlock(blk);
      }
    }
  }

  function triggerTntExplosion(tntBlk) {
    const off = G.descendOffset;
    const cx = tntBlk.x + tntBlk.w / 2;
    const cy = tntBlk.y + off + tntBlk.h / 2;
    const rad = tntBlk.w * 1.85;

    G.shake = 12;
    spawnParticles(cx, cy, '#FF6348', 45, 280);
    addFloater(cx, cy - 10, '💥 TNT BLAST!', '#FFD166', 20);

    for (const other of G.blocks) {
      if (other.dead || other === tntBlk) continue;
      const ox = other.x + other.w / 2;
      const oy = other.y + off + other.h / 2;
      if (Math.hypot(ox - cx, oy - cy) <= rad) {
        const blastDmg = Math.max(Math.round(other.maxHp * 0.38), Math.round(G.baseDamage * 4));
        other.hp -= blastDmg;
        other.flash = 1;
        other.squash = 1;
        addFloater(ox, oy, '-' + blastDmg, '#FF7F50', 15);
        if (other.hp <= 0) destroyBlock(other);
      }
    }
  }

  function hitBlock(ball, blk, nx, ny) {
    if (blk.dead) return;
    // Анти-спам привязан строго к паре (шар + блок) и измеряется в ФИЗИЧЕСКОМ
    // времени симуляции, а не в wall-clock. Старая версия на performance.now()
    // теряла попадания при ускорении игры (ff x2/x3.5) и при залпе из многих
    // шаров — теперь каждое попадание каждого шара засчитывается честно.
    const nowSim = G.simClock;
    const last = ball._hitTimes && ball._hitTimes[blk.id];
    if (last !== undefined && nowSim - last < 0.045) return;
    if (!ball._hitTimes) ball._hitTimes = {};
    ball._hitTimes[blk.id] = nowSim;

    let dmg = ball.damage * ball.virtual;
    let isCrit = Math.random() < G.critChance;
    let isBackstab = false;

    // Тактика бронированных блоков: удар снизу = 50% урона, удар сверху (со спины) = 200% урона!
    if (blk.shielded) {
      if (ny < -0.35) {
        dmg *= 2.0;
        isBackstab = true;
      } else if (ny > 0.35) {
        const armorPierce = Math.min(0.4, G.upgrades.crit * 0.04);
        dmg *= (0.5 + armorPierce);
      }
    }
    if (isCrit) dmg *= C.CRIT_MULT;

    // Взрывной финишер (4-й апгрейд магазина): каждый 8-й удар бьет соседей
    G.hitCounter++;
    if (G.upgrades.blast > 0 && G.hitCounter % 8 === 0) {
      const splash = Math.round(G.baseDamage * (0.6 + G.upgrades.blast * 0.35));
      const off = G.descendOffset;
      spawnParticles(ball.x, ball.y, '#FFD166', 14, 150);
      for (const nb of G.blocks) {
        if (!nb.dead && nb !== blk && Math.hypot((nb.x + nb.w / 2) - ball.x, (nb.y + off + nb.h / 2) - ball.y) < blk.w * 1.4) {
          nb.hp -= splash;
          nb.flash = 0.8;
          if (nb.hp <= 0) destroyBlock(nb);
        }
      }
      // Milestone blast Lv5+: цепная молния в случайный блок на карте
      if (G.upgrades.blast >= C.CHAIN_LIGHTNING_BLAST_LVL) {
        const alive = G.blocks.filter((b) => !b.dead && b !== blk);
        if (alive.length) {
          const target = alive[Math.floor(Math.random() * alive.length)];
          const zOff = G.descendOffset;
          const tx = target.x + target.w / 2, ty = target.y + zOff + target.h / 2;
          addZap(ball.x, ball.y, tx, ty);
          const zDmg = Math.max(1, Math.round(splash * C.CHAIN_LIGHTNING_DMG_RATIO));
          target.hp -= zDmg;
          target.flash = 1;
          addFloater(tx, ty, '-' + zDmg, '#FFE9A8', 13);
          spawnParticles(tx, ty, '#FFE9A8', 8, 130);
          if (target.hp <= 0) destroyBlock(target);
        }
      }
    }

    dmg = Math.max(1, Math.round(dmg));
    blk.hp -= dmg;
    blk.flash = 1;
    blk.squash = 1;
    ball.stretch = 0.5;

    const off = G.descendOffset;
    // Залп шаров по одному блоку схлопывается в одну суммарную цифру (см. registerBlockHit)
    const shown = registerBlockHit(blk, dmg, isCrit, isBackstab);
    if (shown) {
      const a = G.hitAccum.get(blk.id);
      a.x = blk.x + blk.w / 2;
      a.y = blk.y + off + 6;
    }
    spawnParticles(ball.x, ball.y, isBackstab ? '#FFCE7A' : (isCrit ? '#FF8FAE' : '#FFF6EA'), 4, 100);
    Sfx.hit();

    G.score += dmg;

    // Комбо за залп: +1 на каждый удар шарика по живому блоку.
    // На порогах комбо включается hitstop — крошечная микро-заморозка кадра
    // (только визуал: физическое время и кулдауны считаются по simClock).
    if (!blk.dead) {
      G.comboHits++;
      G.comboPulse = performance.now();
      const c = G.comboHits;
      if (c === 50 || c === 120 || c === 250) G.hitstopT = 0.035;
      else if (c > 250 && c % 40 === 0) G.hitstopT = 0.03;
    }

    if (blk.hp <= 0) { flushBlockAccum(blk.id); destroyBlock(blk); }
  }

  function destroyBlock(blk) {
    if (blk.dead) return;
    blk.dead = true;
    const off = G.descendOffset;
    const cx = blk.x + blk.w / 2, cy = blk.y + off + blk.h / 2;

    spawnParticles(cx, cy, blk.tnt ? C.TNT_COLOR : (blk.boss ? C.BOSS_COLOR : '#FFD166'), blk.boss ? 36 : 14, 180);
    Sfx.destroy();
    G.shake = Math.min(10, G.shake + (blk.boss ? 7 : 2));

    const gold = C.GOLD_PER_BLOCK * (blk.boss ? 8 : 1);
    G.coins += gold;
    addFloater(cx, cy, '+' + gold + ' 💰', '#FFD166', 13);

    if (blk.tnt) triggerTntExplosion(blk);
  }

  function spawnParticles(x, y, color, n, speed) {
    if (G.particles.length > 600) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      G.particles.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40,
        life: 0.45 + Math.random() * 0.3, t: 0,
        size: 2.5 + Math.random() * 3, color
      });
    }
  }

  /**
   * Всплывающие цифры урона. Если несколько шаров бьют один блок почти
   * одновременно — вместо кучи наложенных друг на друга цифр показывается
   * ОДНА суммарная ("3×12"), которая приподнимается над предыдущими,
   * чтобы залп читался глазом, а не превращался в кашу.
   */
  function addFloater(x, y, text, color, size) {
    if (G.floaters.length > 55) G.floaters.shift();
    // Небольшой случайный горизонтальный дрейф — даже одиночные цифры не слипаются в одну точку
    const dx = (Math.random() - 0.5) * 46;
    G.floaters.push({ x, y, text: String(text), color, size, t: 0, life: 0.9, vy: -45, dx });
  }

  /** Визуальная цепная молния (blast Lv5+): зигзаг от точки A к точке B */
  function addZap(x1, y1, x2, y2) {
    if (!G.zaps) G.zaps = [];
    if (G.zaps.length > 8) G.zaps.shift();
    const pts = [{ x: x1, y: y1 }];
    const segs = 5;
    for (let i = 1; i < segs; i++) {
      const k = i / segs;
      const px = x1 + (x2 - x1) * k + (Math.random() - 0.5) * 22;
      const py = y1 + (y2 - y1) * k + (Math.random() - 0.5) * 22;
      pts.push({ x: px, y: py });
    }
    pts.push({ x: x2, y: y2 });
    G.zaps.push({ pts, t: 0, life: 0.25 });
  }

  const FLOOD_WINDOW = 0.3; // сек — окно «одновременных» попаданий по блоку
  function registerBlockHit(blk, dmg, isCrit, isBackstab) {
    if (!G.hitAccum) G.hitAccum = new Map();
    const prev = G.hitAccum.get(blk.id);
    if (prev && G.simClock - prev.t < FLOOD_WINDOW) {
      prev.n++; prev.dmg += dmg; prev.t = G.simClock;
      prev.crit = prev.crit || isCrit; prev.back = prev.back || isBackstab;
      return null; // цифра уже на экране — копить, не спамить
    }
    G.hitAccum.set(blk.id, { n: 1, dmg, t: G.simClock, crit: isCrit, back: isBackstab });
    return { key: blk.id };
  }

  function flushFloodFloaters() {
    if (!G.hitAccum) return;
    for (const [key, a] of G.hitAccum) {
      if (G.simClock - a.t >= FLOOD_WINDOW) {
        const tag = (a.n > 1 ? a.n + '×' : '') + (a.back ? '🛡BREAK ' : a.crit ? 'CRIT ' : '') + Math.round(a.dmg);
        const col = a.back ? '#FFCE7A' : a.crit ? '#FF8FAE' : '#FFF6EA';
        let fx = a.x, fy = a.y;
        if (fx === undefined) {
          const blk = G.blocks.find((b) => b.id === key);
          if (blk) { fx = blk.x + blk.w / 2; fy = blk.y + G.descendOffset + 6; } else { fx = viewW / 2; fy = viewH * 0.3; }
        }
        // подсветка накопленного залапа
        const lift = Math.min(3, a.n - 1) * 13;
        addFloater(fx, fy - lift, tag, col, a.n > 1 ? 17 : (a.crit || a.back ? 16 : 13));
        G.hitAccum.delete(key);
      }
    }
  }

  /** Немедленно показать накопленный урон по блоку (используется при его разрушении) */
  function flushBlockAccum(blkId) {
    if (!G.hitAccum) return;
    const a = G.hitAccum.get(blkId);
    if (!a) return;
    const tag = (a.n > 1 ? a.n + '×' : '') + (a.back ? '🛡BREAK ' : a.crit ? 'CRIT ' : '') + Math.round(a.dmg);
    const col = a.back ? '#FFCE7A' : a.crit ? '#FF8FAE' : '#FFF6EA';
    const blk = G.blocks.find((b) => b.id === blkId);
    const fx = blk ? blk.x + blk.w / 2 : viewW / 2;
    const fy = (blk ? blk.y + G.descendOffset + 6 : viewH * 0.3) - Math.min(3, a.n - 1) * 13;
    addFloater(fx, fy, tag, col, a.n > 1 ? 17 : (a.crit || a.back ? 16 : 13));
    G.hitAccum.delete(blkId);
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const p = e.touches && e.touches.length ? e.touches[0] : e;
    return { x: (p.clientX - rect.left) / uiScale, y: (p.clientY - rect.top) / uiScale };
  }

  function onDown(e) {
    Sfx.unlock();
    if (G.state === ST.GAMEOVER) { restartRun(); return; }
    if (G.state !== ST.AIMING) return;
    G.aiming = true;
    hideTutorial();
    updateAim(pointerPos(e));
    e.preventDefault();
  }

  function onMove(e) {
    const p = pointerPos(e);
    if ((e.pointerType || 'mouse') === 'mouse') G.hasPointer = true;
    if (!G.aiming) {
      if (G.hasPointer && G.state === ST.AIMING) updateAim(p);
      return;
    }
    updateAim(p);
    e.preventDefault();
  }

  function onUp() {
    if (!G.aiming) return;
    G.aiming = false;
    if (G.state === ST.AIMING) startFiring();
  }

  function updateAim(p) {
    let dx = p.x - launchX, dy = p.y - launchY;
    if (Math.hypot(dx, dy) < 6) return;
    if (dy > -1) dy = -1;
    let ang = Math.atan2(dy, dx);
    const minElev = C.AIM_MIN_ELEV_DEG * Math.PI / 180;
    if (ang > -minElev) ang = -minElev;
    if (ang < -(Math.PI - minElev)) ang = -(Math.PI - minElev);
    G.aimAngle = ang;
  }

  function startFiring() {
    G.shotsLeftInWave = Math.max(0, G.shotsLeftInWave - 1);
    G.shotsLeft = G.volleyCount;
    G.shootTimer = 0;
    G.simTime = 0;
    G.comboHits = 0;   // новый залп — комбо-счётчик начинается с нуля
    G.ffIndex = 0;
    G.ballsTotal = G.volleyCount;
    setState(ST.FIRING);
    Sfx.shoot();
  }

  function fireOneBall() {
    const idx = G.volleyCount - G.shotsLeft;
    const spread = idx === 0 ? 0 : (Math.random() - 0.5) * 0.025;
    const a = G.aimAngle + spread;
    const mx = launchX + Math.cos(a) * C.MUZZLE_OFFSET;
    const my = launchY + Math.sin(a) * C.MUZZLE_OFFSET;
    const b = makeBall(mx, my, Math.cos(a) * C.LAUNCH_SPEED, Math.sin(a) * C.LAUNCH_SPEED, G.baseDamage);
    addBallBounded(b);
  }

  function recallBalls() {
    for (const b of G.balls) b.collected = true;
    uiRecall(false);
    uiFF(0);
  }

  function endRound() {
    if (!aliveBlocks()) {
      // Волна зачищена! Начисляем награду + скилл-бонус за сэкономленные выстрелы
      const skillBonus = G.shotsLeftInWave * C.GOLD_PER_SAVED_SHOT;
      const totalReward = C.GOLD_WAVE_CLEAR + skillBonus;
      G.coins += totalReward;
      G.score += 150 * G.wave + skillBonus * 10;
      addFloater(viewW / 2, viewH * 0.38, 'WAVE CLEAR! +' + totalReward + ' 💰', '#FFD166', 20);
      if (skillBonus > 0) {
        addFloater(viewW / 2, viewH * 0.38 + 26, 'SKILL BONUS (' + G.shotsLeftInWave + ' shots saved): +' + skillBonus + ' 💰', '#3DDC97', 14);
      }
      Sfx.waveClear();
      G.wave++;
      G.waveSeed = 0;
      nextWave();
      setState(ST.AIMING);
      return;
    }

    // Волна еще НЕ зачищена: вычисляем честный необратимый шаг опускания стены вниз
    const isElimination = G.wave >= C.ELIMINATE_FROM_WAVE || G.shotsLeftInWave <= 0;
    const step = isElimination ? G.cellStepPx : G.cellStepPx * 0.45;
    G.targetDescendOffset = G.descendOffset + step;

    // В режиме выбывания (волна 10+) сверху доспавнивается ряд подкрепления
    if (G.wave >= C.ELIMINATE_FROM_WAVE) {
      const topY = fieldArea.y - G.targetDescendOffset + C.CELL_GAP;
      const reinf = Spawner.spawnReinforcementRow(G.wave, fieldArea, topY);
      for (const rb of reinf) G.blocks.push(rb);
      addFloater(viewW / 2, launchY - C.LAUNCH_ZONE_H, '⚠️ REINFORCEMENTS!', '#FF5D8F', 15);
    } else if (G.shotsLeftInWave <= 0) {
      addFloater(viewW / 2, launchY - C.LAUNCH_ZONE_H, '⚠️ OUT OF SHOTS — WALL DROPS FAST!', '#E5484D', 14);
    }

    setState(ST.DESCENDING);
  }

  function setState(s) {
    G.state = s;
    uiState(s);
    if (s === ST.AIMING) {
      uiFF(0);
      uiRecall(false);
    }
    if (s === ST.GAMEOVER && !G.overShown) {
      G.overShown = true;
      if (G.score > G.highScore) G.highScore = G.score;
      saveBest();
      Sfx.gameOver();
      uiGameOver(G.score, G.highScore, G.wave);
    }
  }

  /** Честный Roguelike-рестарт: новая игра с 1-й волны и чистым магазином */
  function restartRun() {
    G.score = 0;
    G.wave = 1;
    G.coins = 0;
    G.upgrades = { count: 0, damage: 0, crit: 0, blast: 0 };
    recomputeStats();
    G.balls = [];
    G.particles = [];
    G.floaters = [];
    G.lasers = [];
    G.zaps = [];
    G.overShown = false;
    G.waveSeed = 0;
    G.comboHits = 0;
    G.hitstopT = 0;
    nextWave();
    setState(ST.AIMING);
    uiHideGameOver();
    refreshShop();
  }

  function update(dtReal) {
    // Hitstop: микро-заморозка кадра при больших комбо (визуальный «вес» удара).
    // Физическое время (simClock) и таймеры залпа в этот момент не идут,
    // поэтому траектории и кулдауны остаются абсолютно идентичными.
    if (G.hitstopT > 0) {
      G.hitstopT = Math.max(0, G.hitstopT - dtReal);
      return;
    }
    const dt = dtReal * C.FF_LEVELS[G.ffIndex];
    G.simClock += dt; // физическое время — эталон для кулдаунов и схлопывания цифр урона
    flushFloodFloaters();
    updateEffects(dtReal);
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dtReal * 28);

    switch (G.state) {
      case ST.AIMING:
        // Никакого самоотката G.descendOffset! Стена стоит там, куда опустилась.
        break;

      case ST.FIRING:
        G.shootTimer -= dtReal;
        while (G.shootTimer <= 0 && G.shotsLeft > 0) {
          fireOneBall();
          G.shotsLeft--;
          G.shootTimer += C.SHOOT_INTERVAL;
          if (G.shotsLeft % 2 === 0) Sfx.shoot();
        }
        if (G.shotsLeft <= 0) setState(ST.SIMULATING);
        break;

      case ST.SIMULATING:
        G.simTime += dtReal;
        stepPhysics(dt);
        if (G.simTime > C.FF_AFTER_S) {
          uiRecall(true);
          const nextIdx = Math.min(G.ffIndex + 1, C.FF_LEVELS.length - 1);
          uiFF(C.FF_LEVELS[nextIdx]);
        }
        if (G.balls.length === 0) endRound();
        break;

      case ST.DESCENDING: {
        // Плавная анимация опускания стены до targetDescendOffset (за ~0.25 сек)
        const dropSpeed = 190;
        if (G.descendOffset < G.targetDescendOffset) {
          G.descendOffset = Math.min(G.targetDescendOffset, G.descendOffset + dropSpeed * dtReal);
        }

        // Проверяем нижнюю границу живых блоков относительно красной линии поражения
        const dangerY = launchY - 52; // синхронно с отрисовкой: линия отделена от пушки
        let maxY = -Infinity;
        for (const blk of G.blocks) {
          if (blk.dead) continue;
          const by = blk.y + G.descendOffset + blk.h;
          if (by > maxY) maxY = by;
        }
        G.dangerPulse = maxY > dangerY - 65 ? Math.min(1, (maxY - (dangerY - 65)) / 65) : 0;

        if (maxY >= dangerY) {
          setState(ST.GAMEOVER);
        } else if (G.descendOffset >= G.targetDescendOffset - 0.5) {
          healerEndOfTurn();
          setState(ST.AIMING);
        }
        break;
      }

      case ST.GAMEOVER:
        break;
    }
  }

  function stepPhysics(dt) {
    if (dt <= 0) return;
    // При активном ускорении (2x/3.5x SPEED) число макро-шагов физики в кадре
    // масштабируется вместе с множителем, иначе sdt растёт и быстрые шары
    // могут проскакивать тонкие углы треугольных блоков на слабых телефонах.
    const ffMult = C.FF_LEVELS[G.ffIndex] || 1;
    const maxSteps = C.FF_STEPS_SCALE ? Math.ceil(C.MAX_STEPS_PER_FRAME * Math.max(1, ffMult)) : C.MAX_STEPS_PER_FRAME;
    const steps = Math.min(maxSteps, Math.max(1, Math.ceil(dt / C.FIXED_DT)));
    const sdt = dt / steps;
    const shifted = liveBlocksShifted();

    const events = {
      onBounce: function (x, y, sp) {
        if (Math.random() < 0.3) Sfx.bounce(sp);
      },
      onHitBlock: function (ball, blk, nx, ny) {
        hitBlock(ball, blk, nx, ny);
      }
    };

    for (let s = 0; s < steps; s++) {
    for (let i = G.balls.length - 1; i >= 0; i--) {
        const b = G.balls[i];
        Phys.stepBall(b, sdt, shifted, viewW, viewH, floorY, events);
        checkGates(b);
        // Обновление шлейфа: позиция добавляется раз в кадр физики
        if (!b.trail) b.trail = [];
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > 6) b.trail.shift();
        if (b.collected) G.balls.splice(i, 1);
      }
    }
  }

  function liveBlocksShifted() {
    const list = [];
    const off = G.descendOffset;
    for (const blk of G.blocks) {
      if (blk.dead) continue;
      blk._sy = blk.y + off;
      list.push(blk);
    }
    return list;
  }

  function updateEffects(dt) {
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const p = G.particles[i];
      p.t += dt;
      if (p.t >= p.life) { G.particles.splice(i, 1); continue; }
      p.vy += 800 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
    for (let i = G.floaters.length - 1; i >= 0; i--) {
      const f = G.floaters[i];
      f.t += dt;
      // Замедление всплытия + лёгкий «дрейф» в сторону — цифры не слипаются в колонну
      const ease = Math.max(0.25, 1 - f.t / f.life);
      f.y += f.vy * dt * ease;
      f.x += (f.dx || 0) * dt * ease;
      if (f.t >= f.life) G.floaters.splice(i, 1);
    }
    for (let i = G.lasers.length - 1; i >= 0; i--) {
      G.lasers[i].t += dt;
      if (G.lasers[i].t >= G.lasers[i].life) G.lasers.splice(i, 1);
    }
    if (G.zaps) {
      for (let i = G.zaps.length - 1; i >= 0; i--) {
        G.zaps[i].t += dt;
        if (G.zaps[i].t >= G.zaps[i].life) G.zaps.splice(i, 1);
      }
    }
    for (const blk of G.blocks) {
      if (blk.flash > 0) blk.flash = Math.max(0, blk.flash - dt * 4);
      if (blk.squash > 0) blk.squash = Math.max(0, blk.squash - dt * 6);
    }
    for (const b of G.balls) {
      if (b.stretch > 0) b.stretch = Math.max(0, b.stretch - dt * 8);
    }
  }

  function roundRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawTriShape(x, y, w, h, cut) {
    ctx.beginPath();
    if (cut === 'tl')      { ctx.moveTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); }
    else if (cut === 'tr') { ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); }
    else if (cut === 'bl') { ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); }
    else                   { ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h); }
    ctx.closePath();
  }

  function render() {
    ctx.save();
    if (G.shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * G.shake, (Math.random() - 0.5) * G.shake);
    }

    // Мягкий тёплый градиент вместо плоского фона (щадит глаза, без кислотно-неона)
    const bgGrad = ctx.createLinearGradient(0, 0, 0, viewH);
    bgGrad.addColorStop(0, C.BG_TOP);
    bgGrad.addColorStop(1, C.BG);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(-40, -40, viewW + 80, viewH + 80);

    // Зона пушки — отдельный «карман», визуально отделённый от поля и линии поражения
    const dangerY = launchY - 52; // раньше было launchY - 26: линия липла к пушке
    ctx.save();
    const zoneGrad = ctx.createLinearGradient(0, dangerY, 0, viewH);
    zoneGrad.addColorStop(0, 'rgba(255,255,255,0.025)');
    zoneGrad.addColorStop(1, 'rgba(255,255,255,0.07)');
    ctx.fillStyle = zoneGrad;
    ctx.fillRect(0, dangerY, viewW, viewH - dangerY);
    ctx.restore();

    // Линия поражения: пунктир + мягкое свечение, усиливается при опасности
    const pulseNow = performance.now() / 1000;
    const glow = 0.3 + G.dangerPulse * (0.45 + Math.sin(pulseNow * 6) * 0.15);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,122,110,' + Math.min(0.95, glow + 0.15) + ')';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([9, 7]);
    ctx.shadowColor = 'rgba(255,122,110,0.8)';
    ctx.shadowBlur = 6 + G.dangerPulse * 14;
    ctx.beginPath(); ctx.moveTo(6, dangerY); ctx.lineTo(viewW - 6, dangerY); ctx.stroke();
    ctx.restore();
    // Тонкая разделительная линия между зоной поля и зоной пушки
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, dangerY + 7); ctx.lineTo(viewW, dangerY + 7); ctx.stroke();
    ctx.restore();

    drawBlocks();
    drawGates();
    drawLasers();
    drawZaps();
    drawLauncher();
    if (G.state === ST.AIMING) drawAimPreview();
    drawBalls();
    drawParticles();
    drawComboMeter();
    drawFloaters();

    ctx.restore();
    uiHud();
  }

  function drawBlocks() {
    const off = G.descendOffset;
    for (const blk of G.blocks) {
      if (blk.dead) continue;
      const y = blk.y + off;
      if (y + blk.h < -10) continue;

      const sq = blk.squash * 0.14;
      const w = blk.w * (1 + sq), h = blk.h * (1 - sq);
      const x = blk.x - (w - blk.w) / 2;
      const col = blk.tnt ? C.TNT_COLOR : (blk.boss ? C.BOSS_COLOR : C.heatColor(blk.hp, G.maxWaveBlockHp));
      // Плавное «подтаивание» цвета при уроне: блок светлеет пропорционально flash
      const dmgShade = Math.max(0, blk.flash) * 0.55;

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      if (blk.type === 'tri') { drawTriShape(x + 2, y + 4, w, h, blk.cut); ctx.fill(); }
      else { roundRectPath(x + 2, y + 4, w, h, C.BLOCK_RADIUS); ctx.fill(); }

      // Мягкое внутреннее свечение вместо криичного неона
      ctx.shadowColor = col;
      ctx.shadowBlur = 4 + blk.flash * 10;
      ctx.fillStyle = col;
      if (blk.type === 'tri') { drawTriShape(x, y, w, h, blk.cut); ctx.fill(); }
      else { roundRectPath(x, y, w, h, C.BLOCK_RADIUS); ctx.fill(); }
      ctx.shadowBlur = 0;

      // Верхний блик — блок выглядит объёмным
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#FFFFFF';
      if (blk.type !== 'tri') { roundRectPath(x + 3, y + 3, w - 6, h * 0.34, C.BLOCK_RADIUS - 2); ctx.fill(); }
      ctx.globalAlpha = 1;

      // Вспышка от попадания (полупрозрачная, не «выбеливает» блок целиком)
      if (dmgShade > 0.02) {
        ctx.globalAlpha = dmgShade;
        ctx.fillStyle = '#FFF3E4';
        if (blk.type === 'tri') { drawTriShape(x, y, w, h, blk.cut); ctx.fill(); }
        else { roundRectPath(x, y, w, h, C.BLOCK_RADIUS); ctx.fill(); }
        ctx.globalAlpha = 1;
      }

      // Нижний бронещит (показывает, что снизу бить невыгодно, а сверху — 2x урон!)
      if (blk.shielded) {
        ctx.fillStyle = '#D9CBB8';
        ctx.fillRect(x + 2, y + h - 5, w - 4, 5);
      }

      // Элитный блок-целитель: зеленая рамка + крест ➕
      if (blk.healer) {
        ctx.strokeStyle = '#7FBF8A';
        ctx.lineWidth = 2.5;
        roundRectPath(x + 1.5, y + 1.5, w - 3, h - 3, C.BLOCK_RADIUS);
        ctx.stroke();
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('➕', x + 3, y + 2);
      }

      let tx = x + w / 2, ty = y + h / 2;
      if (blk.type === 'tri') {
        tx = x + w * (blk.cut === 'tl' || blk.cut === 'bl' ? 0.65 : 0.35);
        ty = y + h * (blk.cut === 'tl' || blk.cut === 'tr' ? 0.68 : 0.32);
      }
      const label = blk.tnt ? '🧨' + Math.ceil(blk.hp) : String(Math.ceil(blk.hp));
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(26,23,20,0.85)';
      ctx.strokeText(label, tx, ty);
      ctx.fillStyle = '#FFFDF7';
      ctx.fillText(label, tx, ty);
      ctx.restore();
    }
  }

  function drawGates() {
    const off = G.descendOffset;
    const t = performance.now() / 1000;
    for (const g of G.gates) {
      if (g.spent) continue;
      const y = g.y + off;
      const pulse = 1 + Math.sin(t * 4 + g.pulse) * 0.08;
      const col = g.kind === 'LASER' ? '#FFD166' : '#4CC9F0';

      ctx.save();
      ctx.translate(g.x, y);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = 'rgba(20,24,44,0.92)';
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      roundRectPath(-g.w / 2, -g.h / 2, g.w, g.h, 8);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = col;
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(g.kind === 'LASER' ? '⚡LASER' : g.kind.replace(' BALLS', '⚪'), 0, 1);
      ctx.restore();
    }
  }

  function drawLasers() {
    for (const l of G.lasers) {
      const k = 1 - l.t / l.life;
      ctx.save();
      ctx.globalAlpha = k;
      ctx.fillStyle = '#4CC9F0';
      ctx.fillRect(0, l.y - 6 * k, viewW, 12 * k);
      ctx.fillRect(l.x - 6 * k, 0, 12 * k, viewH);
      ctx.restore();
    }
  }

  function drawZaps() {
    if (!G.zaps || !G.zaps.length) return;
    for (const z of G.zaps) {
      const k = 1 - z.t / z.life;
      ctx.save();
      ctx.globalAlpha = Math.max(0, k);
      ctx.strokeStyle = '#FFE9A8';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = '#FFD9A0';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(z.pts[0].x, z.pts[0].y);
      for (let i = 1; i < z.pts.length; i++) ctx.lineTo(z.pts[i].x, z.pts[i].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawLauncher() {
    const t = performance.now() / 1000;
    ctx.save();
    // Основание пушки — тёплый шоколадный, отделён от линии поражения зазором
    ctx.fillStyle = C.BG_PANEL;
    roundRectPath(launchX - 32, launchY - 4, 64, 28, 10);
    ctx.fill();
    ctx.strokeStyle = C.CANNON;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Дуло: скруглённый «ствол» с мягким свечением и лёгким дыханием в режиме прицела
    ctx.translate(launchX, launchY - 2);
    const breathe = G.state === ST.AIMING ? 1 + Math.sin(t * 3) * 0.03 : 1;
    ctx.rotate(G.aimAngle + Math.PI / 2);
    ctx.scale(breathe, breathe);
    ctx.shadowColor = C.CANNON;
    ctx.shadowBlur = 8;
    ctx.fillStyle = C.CANNON;
    roundRectPath(-7, -30, 14, 32, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Срез дула
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRectPath(-4.5, -30, 9, 6, 3);
    ctx.fill();
    ctx.restore();
  }

  function drawAimPreview() {
    const segs = Phys.previewPath(launchX, launchY, G.aimAngle, liveBlocksShifted(), viewW, viewH);
    const pts = segs[0];
    if (!pts || pts.length < 2) return;
    const t = performance.now() / 1000;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,246,234,0.85)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.setLineDash([2, 10]);
    ctx.lineDashOffset = -t * 26; // «бегущий» пунктир — видно направление полёта
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // Маркер точки первого касания — дышащее кольцо + мягкое свечение
    const last = pts[pts.length - 1];
    const pr = 6 + Math.sin(t * 5) * 1.4;
    ctx.setLineDash([]);
    ctx.shadowColor = '#FFCE7A';
    ctx.shadowBlur = 10;
    ctx.strokeStyle = '#FFCE7A';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(last.x, last.y, pr, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,206,122,0.9)';
    ctx.beginPath(); ctx.arc(last.x, last.y, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawBalls() {
    for (const b of G.balls) {
      // Хвост-шлейф для приятного движения
      if (b.trail && b.trail.length) {
        ctx.save();
        for (let i = 0; i < b.trail.length; i++) {
          const p = b.trail[i];
          const k = (i + 1) / (b.trail.length + 1);
          ctx.globalAlpha = 0.16 * k;
          ctx.fillStyle = b.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, b.r * k * 0.9, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      ctx.save();
      const tier = b.tier || 0;
      // Эволюция шара по milestone'ам урона: цвет, свечение, обводка и искры
      if (tier >= 3) {
        ctx.shadowColor = '#FFD9A0'; ctx.shadowBlur = 16;
        ctx.fillStyle = '#F4A261';
      } else if (tier === 2) {
        ctx.shadowColor = '#E9C46A'; ctx.shadowBlur = 13;
        ctx.fillStyle = '#E76F51';
      } else if (tier === 1) {
        ctx.shadowColor = '#FFF0D0'; ctx.shadowBlur = 10;
        ctx.fillStyle = '#E9C46A';
      } else {
        ctx.shadowColor = b.color; ctx.shadowBlur = 6;
        ctx.fillStyle = b.color;
      }
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (tier > 0) {
        // светящаяся золотая обводка
        ctx.strokeStyle = 'rgba(255,232,170,' + (0.45 + 0.18 * tier) + ')';
        ctx.lineWidth = 1.5 + tier * 0.5;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 1.2, 0, Math.PI * 2); ctx.stroke();
      }
      // Блик
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath(); ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.34, b.r * 0.34, 0, Math.PI * 2); ctx.fill();
      if (tier >= 2) {
        // искры вокруг продвинутых шаров
        const a = performance.now() * 0.007 + (b.id || 0) * 2.4;
        ctx.fillStyle = 'rgba(255,240,200,0.85)';
        for (let s = 0; s < 2; s++) {
          const ang = a + s * Math.PI;
          const rr = b.r + 3 + Math.sin(performance.now() * 0.009 + s * 2) * 1.5;
          ctx.beginPath();
          ctx.arc(b.x + Math.cos(ang) * rr, b.y + Math.sin(ang) * rr, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /** Гигантский фоновый счётчик комбо: удары за текущий залп */
  function comboTier(hits) {
    if (hits >= 250) return { label: '👑 GODLIKE', bangs: '!!!' };
    if (hits >= 120) return { label: '⚡️ UNSTOPPABLE', bangs: '!!' };
    if (hits >= 50) return { label: '🔥 FRENZY', bangs: '!' };
    if (hits >= 15) return { label: 'NICE COMBO', bangs: '' };
    return null;
  }

  function drawComboMeter() {
    const tier = comboTier(G.comboHits);
    if (!tier) return;
    // Полупрозрачно и только во время полёта шаров — не мешаем прицеливанию
    const active = G.state === ST.FIRING || G.state === ST.SIMULATING;
    if (!active) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Пульс от каждого удара: короткий всплеск масштаба после последнего хита
    const since = performance.now() - G.comboPulse;
    const pulse = Math.max(0, 1 - since / 140);          // 0..1, гаснет за ~140 мс
    const size = (48 + Math.min(G.comboHits, 300) * 0.08) * (1 + pulse * 0.12);
    ctx.globalAlpha = 0.18;
    ctx.font = '900 ' + Math.round(size) + 'px system-ui, sans-serif';
    const cx = viewW / 2;
    const cy = viewH * 0.30;
    ctx.fillStyle = '#FFEFD2';
    ctx.fillText(tier.label + ' x' + G.comboHits + tier.bangs, cx, cy);
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    for (const p of G.particles) {
      ctx.globalAlpha = Math.max(0, 1 - p.t / p.life);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.restore();
  }

  function drawFloaters() {
    ctx.save();
    ctx.textAlign = 'center';
    for (const f of G.floaters) {
      const k = f.t / f.life;
      // Появление с «отскоком»: первые 12% жизни цифра подрастает в размере
      const pop = k < 0.12 ? 0.7 + (k / 0.12) * 0.35 : 1.05 - (k - 0.12) * 0.05;
      const alpha = k > 0.6 ? Math.max(0, 1 - (k - 0.6) / 0.4) : 1;
      ctx.globalAlpha = alpha;
      ctx.font = 'bold ' + Math.round(f.size * pop) + 'px system-ui, sans-serif';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(26,23,20,0.85)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.restore();
  }

  /* --- DOM UI --- */
  let els = {};
  const $ = (id) => document.getElementById(id);

  function bindUI() {
    els = {
      hudWave: $('hud-wave'), hudShots: $('hud-shots'), hudScore: $('hud-score'),
      hudHigh: $('hud-high'), hudCoins: $('hud-coins'), hudBalls: $('hud-balls'),
      hudPhys: $('hud-phys'), stateTag: $('state-tag'),
      ffBadge: $('ff-badge'), btnRecall: $('btn-recall'),
      shop: $('shop'), toast: $('toast'), tutorial: $('tutorial'),
      overlay: $('overlay'), ovScore: $('ov-score'), ovHigh: $('ov-high'), ovWave: $('ov-wave'),
      btnMute: $('btn-mute')
    };

    els.btnRecall.addEventListener('click', (e) => { e.stopPropagation(); recallBalls(); });
    els.ffBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      if (G.state === ST.SIMULATING) {
        G.ffIndex = (G.ffIndex + 1) % C.FF_LEVELS.length;
        uiFF(C.FF_LEVELS[G.ffIndex]);
      }
    });
    $('btn-restart').addEventListener('click', (e) => { e.stopPropagation(); restartRun(); });
    els.btnMute.addEventListener('click', (e) => {
      e.stopPropagation();
      Sfx.enabled = !Sfx.enabled;
      els.btnMute.textContent = Sfx.enabled ? '🔊' : '🔇';
    });
    buildShop();
  }

  function buildShop() {
    els.shop.innerHTML = '';
    ['count', 'damage', 'crit', 'blast'].forEach((key) => {
      const u = C.UPGRADES[key];
      const btn = document.createElement('button');
      btn.className = 'shop-btn';
      btn.dataset.key = key;
      btn.innerHTML =
        '<span class="shop-icon">' + u.icon + '</span>' +
        '<span class="shop-label">' + u.label + '</span>' +
        '<span class="shop-meta"><span class="shop-cost">💰0</span><span class="shop-lvl">Lv0</span></span>' +
        '<span class="shop-effect">' + u.desc + '</span>';
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => { e.stopPropagation(); buyUpgrade(key); });
      els.shop.appendChild(btn);
    });
    refreshShop();
  }

  function buyUpgrade(key) {
    if (G.state !== ST.AIMING) { showToast('Upgrade while AIMING!'); return; }
    const u = C.UPGRADES[key];
    const lvl = G.upgrades[key];
    if (lvl >= u.maxLevel) return;
    const cost = C.upgradeCost(key, lvl);
    if (G.coins < cost) { showToast('Need ' + cost + ' 💰'); return; }
    G.coins -= cost;
    G.upgrades[key]++;
    recomputeStats();
    Sfx.buy();
    refreshShop();
  }

  function refreshShop() {
    const btns = els.shop.querySelectorAll('.shop-btn');
    btns.forEach((btn) => {
      const key = btn.dataset.key;
      const u = C.UPGRADES[key];
      const lvl = G.upgrades[key];
      const maxed = lvl >= u.maxLevel;
      const cost = C.upgradeCost(key, lvl);
      btn.querySelector('.shop-cost').textContent = maxed ? 'MAX' : '💰' + cost;
      btn.querySelector('.shop-lvl').textContent = 'Lv' + lvl;
      btn.classList.toggle('affordable', !maxed && G.coins >= cost && G.state === ST.AIMING);
      btn.classList.toggle('maxed', maxed);
    });
  }

  function hideTutorial() {
    if (els.tutorial) els.tutorial.classList.add('hidden');
  }

  let toastTimer = 0;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 1300);
  }

  function uiState(s) {
    els.stateTag.textContent = s;
    els.stateTag.setAttribute('data-state', s);
    els.shop.classList.toggle('locked', s !== ST.AIMING);
    if (s === ST.AIMING) refreshShop();
  }

  function uiFF(mult) {
    if (mult > 0 && G.state === ST.SIMULATING) {
      els.ffBadge.textContent = mult + 'x SPEED ⏩';
      els.ffBadge.classList.add('visible');
    } else {
      els.ffBadge.classList.remove('visible');
    }
  }

  function uiRecall(show) {
    els.btnRecall.classList.toggle('visible', !!show);
  }

  function uiSetWave() {
    const isBoss = Spawner.isBossWave(G.wave);
    els.hudWave.textContent = 'W' + G.wave + (isBoss ? ' 👑' : '') + (G.wave >= C.ELIMINATE_FROM_WAVE ? ' 💀' : '');
  }

  function uiGameOver(score, high, wave) {
    els.ovScore.textContent = score.toLocaleString();
    els.ovHigh.textContent = high.toLocaleString();
    els.ovWave.textContent = wave;
    els.overlay.classList.add('visible');
  }

  function uiHideGameOver() {
    els.overlay.classList.remove('visible');
  }

  function uiHud() {
    els.hudScore.textContent = G.score.toLocaleString();
    els.hudHigh.textContent = Math.max(G.highScore, G.score).toLocaleString();
    els.hudCoins.textContent = G.coins.toLocaleString();
    els.hudBalls.textContent = (G.state === ST.AIMING ? G.volleyCount : G.ballsTotal).toLocaleString();
    els.hudPhys.textContent = G.balls.length;
    if (els.hudShots) els.hudShots.textContent = G.shotsLeftInWave + '/' + G.maxShotsInWave;
  }

  function frame(ts) {
    if (!G.running) return;
    let dt = (ts - G.lastTs) / 1000;
    G.lastTs = ts;
    if (!(dt > 0)) dt = 1 / 60;
    dt = Math.min(dt, 0.05);
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  function boot() {
    stageEl = $('stage');
    canvas = $('game');
    ctx = canvas.getContext('2d');
    Sfx.init();
    loadBest();
    resize();
    bindUI();
    nextWave();
    uiState(ST.AIMING);

    canvas.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('resize', () => { resize(); });

    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) {
      try { tg.ready(); tg.expand(); tg.setHeaderColor('#1E2238'); tg.setBackgroundColor('#1E2238'); } catch (e) {}
    }
    global.RF.Game.booted = true;
    G.lastTs = performance.now();
    requestAnimationFrame(frame);
  }

  global.RF = global.RF || {};
  global.RF.Game = { boot: boot, G: G, ST: ST };

  // Отладочные хуки (только локально, см. dev/dev.html) — в проде не используются
  global.RF.debug = {
    /** Перепрыгнуть на волну N и перестроить поле */
    gotoWave(n) {
      G.wave = Math.max(1, n | 0);
      G.waveSeed = 0;
      G.descendOffset = 0;
      G.targetDescendOffset = 0;
      G.balls = [];
      nextWave();
      setState(ST.AIMING);
      refreshShop();
      return 'wave=' + G.wave;
    },
    addCoins(v) { G.coins += v | 0; uiHud(); refreshShop(); return 'coins=' + G.coins; },
    setBalls(v) {
      G.upgrades.count = Math.max(0, v | 0);
      recomputeStats(); uiHud(); refreshShop();
      return 'volley=' + G.volleyCount;
    },
    setDamage(v) {
      G.upgrades.damage = Math.max(0, v | 0);
      recomputeStats(); uiHud(); refreshShop();
      return 'dmg=' + G.baseDamage;
    },
    setBlast(v) {
      G.upgrades.blast = Math.max(0, Math.min(C.UPGRADES.blast.maxLevel, v | 0));
      uiHud(); refreshShop();
      return 'blast=' + G.upgrades.blast;
    },
    /** Мгновенно уничтожить все блоки текущей волны */
    clearWave() {
      for (const b of G.blocks) if (!b.dead) destroyBlock(b);
      return 'blocks cleared';
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);