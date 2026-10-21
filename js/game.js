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
    critChance: C.START_CRIT,
    aimAngle: -Math.PI / 2,
    aiming: false,
    hasPointer: false,
    shootTimer: 0,
    shotsLeft: 0,
    simTime: 0,
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
    G.baseDamage = C.START_DAMAGE + G.upgrades.damage * 1.5;
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

  let _ballId = 1;
  function makeBall(x, y, vx, vy, damage) {
    return {
      id: _ballId++, x, y, vx, vy,
      r: C.BALL_BASE_RADIUS,
      damage: damage,
      virtual: 1,
      color: C.BALL_COLORS[_ballId % C.BALL_COLORS.length],
      collected: false,
      squash: 0, stretch: 0
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
    const now = performance.now();
    if (blk.dead || (blk._hitCd && blk._hitCd > now)) return;
    blk._hitCd = now + 26;

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
    }

    dmg = Math.max(1, Math.round(dmg));
    blk.hp -= dmg;
    blk.flash = 1;
    blk.squash = 1;
    ball.stretch = 0.5;

    const off = G.descendOffset;
    const tag = isBackstab ? 'BACKSTAB ' + dmg : (isCrit ? 'CRIT ' + dmg : dmg);
    const col = isBackstab ? '#FFD166' : (isCrit ? '#FF5D8F' : '#F4F6FF');
    addFloater(blk.x + blk.w / 2, blk.y + off + 6, tag, col, isBackstab || isCrit ? 16 : 13);
    spawnParticles(ball.x, ball.y, col, 4, 100);
    Sfx.hit();

    G.score += dmg;
    if (blk.hp <= 0) destroyBlock(blk);
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

  function addFloater(x, y, text, color, size) {
    if (G.floaters.length > 55) G.floaters.shift();
    G.floaters.push({ x, y, text: String(text), color, size, t: 0, life: 0.8, vy: -45 });
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
    G.overShown = false;
    G.waveSeed = 0;
    nextWave();
    setState(ST.AIMING);
    uiHideGameOver();
    refreshShop();
  }

  function update(dtReal) {
    const dt = dtReal * C.FF_LEVELS[G.ffIndex];
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
        const dangerY = launchY - 26;
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
    const steps = Math.min(C.MAX_STEPS_PER_FRAME, Math.max(1, Math.ceil(dt / C.FIXED_DT)));
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
      f.t += dt; f.y += f.vy * dt;
      if (f.t >= f.life) G.floaters.splice(i, 1);
    }
    for (let i = G.lasers.length - 1; i >= 0; i--) {
      G.lasers[i].t += dt;
      if (G.lasers[i].t >= G.lasers[i].life) G.lasers.splice(i, 1);
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

    ctx.fillStyle = C.BG;
    ctx.fillRect(-40, -40, viewW + 80, viewH + 80);

    // Линия поражения
    const dangerY = launchY - 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(229,72,77,' + (0.35 + G.dangerPulse * 0.55) + ')';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(6, dangerY); ctx.lineTo(viewW - 6, dangerY); ctx.stroke();
    ctx.restore();

    drawBlocks();
    drawGates();
    drawLasers();
    drawLauncher();
    if (G.state === ST.AIMING) drawAimPreview();
    drawBalls();
    drawParticles();
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

      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      if (blk.type === 'tri') { drawTriShape(x + 2, y + 4, w, h, blk.cut); ctx.fill(); }
      else { roundRectPath(x + 2, y + 4, w, h, C.BLOCK_RADIUS); ctx.fill(); }

      ctx.fillStyle = blk.flash > 0.2 ? '#FFFFFF' : col;
      if (blk.type === 'tri') { drawTriShape(x, y, w, h, blk.cut); ctx.fill(); }
      else { roundRectPath(x, y, w, h, C.BLOCK_RADIUS); ctx.fill(); }

      // Нижний бронещит (показывает, что снизу бить невыгодно, а сверху — 2x урон!)
      if (blk.shielded) {
        ctx.fillStyle = '#E2E8F0';
        ctx.fillRect(x + 2, y + h - 5, w - 4, 5);
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
      ctx.strokeStyle = 'rgba(20,22,40,0.9)';
      ctx.strokeText(label, tx, ty);
      ctx.fillStyle = '#FFFFFF';
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

  function drawLauncher() {
    ctx.save();
    ctx.fillStyle = C.BG_PANEL;
    roundRectPath(launchX - 30, launchY - 6, 60, 26, 8);
    ctx.fill();
    ctx.strokeStyle = '#4CC9F0';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.translate(launchX, launchY);
    ctx.rotate(G.aimAngle + Math.PI / 2);
    ctx.fillStyle = '#4CC9F0';
    roundRectPath(-6, -28, 12, 28, 5);
    ctx.fill();
    ctx.restore();
  }

  function drawAimPreview() {
    const segs = Phys.previewPath(launchX, launchY, G.aimAngle, liveBlocksShifted(), viewW, viewH);
    const pts = segs[0];
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(244,246,255,0.88)';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([3, 9]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    const last = pts[pts.length - 1];
    ctx.setLineDash([]);
    ctx.strokeStyle = '#FFD166';
    ctx.beginPath(); ctx.arc(last.x, last.y, 6, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  function drawBalls() {
    for (const b of G.balls) {
      ctx.save();
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
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
      ctx.globalAlpha = Math.max(0, 1 - f.t / f.life);
      ctx.font = 'bold ' + f.size + 'px system-ui, sans-serif';
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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);