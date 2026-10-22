(function (global) {
  'use strict';

  const C = () => global.RF.Config;
  const Physics = {};

  function circleVsRoundedRect(cx, cy, r, rx, ry, rw, rh, rad) {
    const halfW = rw / 2, halfH = rh / 2;
    const dx = cx - rx, dy = cy - ry;
    const ix = Math.max(0, halfW - rad), iy = Math.max(0, halfH - rad);

    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx <= ix && ady <= iy) {
      const gapX = halfW - adx, gapY = halfH - ady;
      if (gapX < gapY) {
        return { nx: Math.sign(dx) || 1, ny: 0, depth: r + gapX };
      } else {
        return { nx: 0, ny: Math.sign(dy) || 1, depth: r + gapY };
      }
    }

    const ccx = Math.min(ix, Math.max(-ix, dx));
    const ccy = Math.min(iy, Math.max(-iy, dy));
    const qx = dx - ccx, qy = dy - ccy;
    const dist = Math.hypot(qx, qy);
    const maxR = r + rad;
    if (dist >= maxR || dist === 0) return null;
    return { nx: qx / dist, ny: qy / dist, depth: maxR - dist };
  }

  function reflect(ball, nx, ny, rest) {
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= (1 + rest) * vn * nx;
      ball.vy -= (1 + rest) * vn * ny;
    }
  }

  // Истинная форма треугольного (половинчатого блока).
  // ВАЖНО: координаты центра triCx/triCy и радиус triR задают ОКРУЖНОСТЬ,
  // полностью покрывающую реальный треугольник (гипотенуза = диаметр).
  // Поэтому broadphase (широкая фаза) больше не использует весь прямоугольник
  // блока — там, где раньше был «невидимый квадратный коллайдер».
  // Вершины ниже — В ТОЧНОСТИ те же, что рисует drawTriShape в game.js.
  function triVerts(blk) {
    const x = blk.x, y = blk._sy !== undefined ? blk._sy : blk.y;
    const w = blk.w, h = blk.h;
    let v;
    switch (blk.cut) {
      case 'tl': v = [{ x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }]; break;
      case 'tr': v = [{ x: x, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }]; break;
      case 'bl': v = [{ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }]; break;
      case 'br': v = [{ x: x, y: y }, { x: x + w, y: y }, { x: x, y: y + h }]; break;
      default: return null;
    }
    // кешируем центр/радиус описанной окружности для быстрой широкой фазы
    blk.triCx = (v[0].x + v[1].x + v[2].x) / 3;
    blk.triCy = (v[0].y + v[1].y + v[2].y) / 3;
    blk.triR = Math.max(w, h) / 2 + 0.5;
    return v;
  }

  // Быстрая грубая проверка «шар рядом с треугольником?».
  // Важно: это ДОЛЖНА быть консервативная (расширенная) граница самого
  // треугольника, иначе шар пролетает мимо «зоны интереса» и физика его
  // теряет. Поэтому расширяем AABB блока на r+pad и дополнительно проверяем
  // расстояние до каждой стороны — так срезанный угол остаётся пустым, а
  // реальные грани гарантированно попадают в узкую фазу.
  function nearTriBall(ball, blk, pad) {
    const x = blk.x, w = blk.w;
    const y = blk._sy !== undefined ? blk._sy : blk.y, h = blk.h;
    const R = ball.r + pad;
    // быстрый AABB-отсев
    if (ball.x < x - R || ball.x > x + w + R || ball.y < y - R || ball.y > y + h + R) return false;
    const v = triVerts(blk);
    if (!v) return true;
    for (let i = 0; i < 3; i++) {
      const a = v[i], b = v[(i + 1) % 3];
      if (closestOnSeg(ball.x, ball.y, a.x, a.y, b.x, b.y).d <= R) return true;
    }
    return pointInTri(ball.x, ball.y, v);
  }

  // Индексы двух вершин, образующих ГИПОТЕНУЗУ (скошенную сторону).
  // Порядок обхода вершин у разных срезов разный, поэтому гипотенуза — это
  // просто САМАЯ ДЛИННАЯ сторона треугольника (для прямоугольного = k·√2).
  function triHypEdge(verts) {
    let best = [0, 1], bestD = -1;
    for (let i = 0; i < 3; i++) {
      const a = verts[i], b = verts[(i + 1) % 3];
      const d = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
      if (d > bestD) { bestD = d; best = [i, (i + 1) % 3]; }
    }
    return best;
  }

  // Ближайшая точка на отрезке AB к точке P + вектор расталкивания
  function closestOnSeg(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + abx * t, cy = ay + aby * t;
    let dx = px - cx, dy = py - cy;
    const d = Math.hypot(dx, dy);
    if (d === 0) { dx = -aby; dy = abx; const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n; }
    else { dx /= d; dy /= d; }
    return { cx, cy, d, nx: dx, ny: dy };
  }

  function pointInTri(px, py, v) {
    const d1 = (px - v[0].x) * (v[1].y - v[0].y) - (py - v[0].y) * (v[1].x - v[0].x);
    const d2 = (px - v[1].x) * (v[2].y - v[1].y) - (py - v[1].y) * (v[2].x - v[1].x);
    const d3 = (px - v[2].x) * (v[0].y - v[2].y) - (py - v[2].y) * (v[0].x - v[2].x);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  // Нормаль ГИПОТЕНУЗЫ, направленная ВНЕ треугольника (т.е. в сторону
  // срезанного угла). Вычисляется из самих вершин, поэтому не зависит от
  // порядка обхода и не может «смотреть» внутрь блока.
  function triHypNormal(verts) {
    const [ia, ib] = triHypEdge(verts);
    const a = verts[ia], b = verts[ib];
    const ux = b.x - a.x, uy = b.y - a.y;
    const len = Math.hypot(ux, uy) || 1;
    let nx = uy / len, ny = -ux / len;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    // если нормаль указывает внутрь (в сторону третьей вершины) — разворачиваем
    if ((verts[3 - ia - ib].x - cx) * nx + (verts[3 - ia - ib].y - cy) * ny > 0) {
      nx = -nx; ny = -ny;
    }
    return [nx, ny];
  }

  // Честный коллайдер для половинчатых блоков: круг против РЕАЛЬНОГО треугольника.
  // Если центр шара оказался ВНУТРИ треугольника (туннелирование) — выталкиваем
  // через ближайшую внешнюю сторону наружу. Снаружи — контакт только с реальными
  // гранями; касание гипотенузы дополнительно верифицируется (см. triHypContact),
  // поэтому ни мяч, ни прицел не «ныряют» за уголок полублока.
  function triSurfaceHit(px, py, r, verts) {
    let best = null, bestPen = -Infinity, bestI = -1;
    for (let i = 0; i < 3; i++) {
      const a = verts[i], b = verts[(i + 1) % 3];
      const c = closestOnSeg(px, py, a.x, a.y, b.x, b.y);
      const pen = r - c.d;
      if (pen > bestPen) { bestPen = pen; best = { nx: c.nx, ny: c.ny, depth: pen }; bestI = i; }
    }
    if (!best || bestPen <= 0) return null;
    best.i = bestI;
    return best;
  }

  // Отрезок AB, точка P -> проекция на AB (в пределах отрезка)
  function projOnSeg(px, py, ax, ay, bx, by) {
    const abx = bx - ax, aby = by - ay;
    const l2 = abx * abx + aby * aby;
    let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + abx * t, y: ay + aby * t };
  }

  // Проверяет, что круг (px,py,r) реально касается ГИПОТЕНУЗЫ полублока, а не
  // «фантастически» пересекает её где-то далеко от блока. Два независимых теста:
  //  1) ближайшая к центру точка самой границы треугольника должна лежать на
  //     гипотенузе (иначе contact идёт через прямоугольные стороны — мимо скоса);
  //  2) проекция центра шара на гипотенузу обязана попадать в сам отрезок с
  //     небольшим допуском (иначе шар пролетает мимо конца скошенного края,
  //     и линия прицела «ныряла» за уголок полублока).
  // Эта проверка одинакова и для живых шаров, и для previewPath (обе идут через
  // Physics.triHit), поэтому прицел больше не рисует отскоков внутри пустого угла.
  function triHypContact(edgeI, px, py, r, verts) {
    const [ia, ib] = triHypEdge(verts);
    if (edgeI !== ia && edgeI !== ib) return true; // контакт не со скосом — ок
    const a = verts[ia], b = verts[ib];
    const pr = projOnSeg(px, py, a.x, a.y, b.x, b.y);
    const pad = r + 1;
    if (pr.x < Math.min(a.x, b.x) - pad || pr.x > Math.max(a.x, b.x) + pad) return false;
    if (pr.y < Math.min(a.y, b.y) - pad || pr.y > Math.max(a.y, b.y) + pad) return false;
    return true;
  }

  // Сторона треугольника, лежащая на внешней (прямоугольной) границе блока.
  // Возвращает [i, j] или null, если сторона полностью скошенная/диагональная.
  function triRectEdge(verts, blk) {
    const x = blk.x, w = blk.w;
    const y = blk._sy !== undefined ? blk._sy : blk.y, h = blk.h;
    const eps = 0.51;
    for (let i = 0; i < 3; i++) {
      const a = verts[i], b = verts[(i + 1) % 3];
      if (Math.abs(a.x - x) < eps && Math.abs(b.x - x) < eps) return [i, (i + 1) % 3];
      if (Math.abs(a.x - (x + w)) < eps && Math.abs(b.x - (x + w)) < eps) return [i, (i + 1) % 3];
      if (Math.abs(a.y - y) < eps && Math.abs(b.y - y) < eps) return [i, (i + 1) % 3];
      if (Math.abs(a.y - (y + h)) < eps && Math.abs(b.y - (y + h)) < eps) return [i, (i + 1) % 3];
    }
    return null;
  }

  Physics.triHit = function (ball, blk) {
    const verts = triVerts(blk);
    if (!verts) return null;
    // ВАЖНО: проверка «внутри» должна учитывать РАДИУС шара, а не только центр.
    // Если весь круг шара лежит внутри треугольника (туннелирование на высокой
    // скорости — шар проскочил грань за один подшаг), центр может оказаться
    // глубоко внутри, при этом ближайшая ГРАНИЦА будет дальше, чем r. Раньше в
    // этот момент возвращался null, выталкивание не срабатывало, и шар навсегда
    // оставался внутри полублока («шарики залетают внутрь»). Теперь такой случай
    // выталкиваем через ближайшую сторону наружу независимо от расстояния.
    if (pointInTri(ball.x, ball.y, verts)) {
      let edge = triRectEdge(verts, blk);
      if (!edge) edge = triHypEdge(verts);
      const a = verts[edge[0]], b = verts[edge[1]];
      const c = closestOnSeg(ball.x, ball.y, a.x, a.y, b.x, b.y);
      let nx = c.nx, ny = c.ny;
      // нормаль должна смотреть ВНЕ треугольника
      const third = verts[3 - edge[0] - edge[1]];
      if ((third.x - c.cx) * nx + (third.y - c.cy) * ny > 0) { nx = -nx; ny = -ny; }
      const depth = ball.r + c.d + 0.5;
      return { nx, ny, depth };
    }
    // снаружи: честный контакт со скошенной формой (никаких невидимых стен)
    const surf = triSurfaceHit(ball.x, ball.y, ball.r, verts);
    if (!surf) return null;
    // Если контакт идёт через ГИПОТЕНУЗУ, дополнительно убеждаемся, что шар
    // реально её касается (проекция центра попадает на отрезок скоса).
    // Это исключает фантомные отскоки прицела и мячей за уголком полублока.
    if (!triHypContact(surf.i, ball.x, ball.y, ball.r, verts)) return null;
    return surf;
  };

  // Столкновение шара с треугольным блоком.
  function collideTriBlock(ball, blk, by) {
    const cfg = C();
    const v0 = triVerts(blk);
    const wasInside = v0 ? pointInTri(ball.x, ball.y, v0) : false;
    const hit = Physics.triHit(ball, blk);
    if (hit) {
      ball.x += hit.nx * hit.depth;
      ball.y += hit.ny * hit.depth;
      reflect(ball, hit.nx, hit.ny, cfg.RESTITUTION);

      // Трение по касательной к грани. Без него шар «скользит» по скосу
      // полублока как по лыжне и улетает за его край. Здесь же — переход в
      // состояние покоя: если после отражения скорость вдоль грани мала, а
      // нормальная составляющая почти нулевая, гасим остаток, чтобы мяч не
      // дрейфовал сквозь острие.
      const tx = -hit.ny, ty = hit.nx;
      let vt = ball.vx * tx + ball.vy * ty;
      const vn = ball.vx * hit.nx + ball.vy * hit.ny;
      // тангенциальное трение (только для скошенных/боковых граней)
      const fr = Math.max(0, 1 - cfg.TRI_FRICTION);
      vt *= fr;
      ball.vx = hit.nx * vn + tx * vt;
      ball.vy = hit.ny * vn + ty * vt;

      if (wasInside) {
        // шар был внутри стены — тащим скорость строго наружу нормали выталкивания
        const vn2 = ball.vx * hit.nx + ball.vy * hit.ny;
        if (vn2 < 0) {
          const ttx = -hit.ny, tty = hit.nx;
          const vtt = ball.vx * ttx + ball.vy * tty;
          ball.vx = hit.nx * Math.abs(vn2) + ttx * vtt * 0.5;
          ball.vy = hit.ny * Math.abs(vn2) + tty * vtt * 0.5;
        }
      }
      return { nx: hit.nx, ny: hit.ny };
    }
    return null;
  }

  // Экстренное выталкивание из ВСЕХ треугольных блоков сразу после шага позиции:
  // гарантирует, что ни один шар не остаётся внутри полублока (невидимая стена).
  function resolveInsideTris(ball, blocks) {
    for (let k = 0; k < 6; k++) {
      let moved = false;
      for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i];
        if (blk.dead || blk.type !== 'tri') continue;
        const v = triVerts(blk);
        if (!v || !pointInTri(ball.x, ball.y, v)) continue;
        const hit = Physics.triHit(ball, blk);
        if (!hit) continue;
        ball.x += hit.nx * hit.depth;
        ball.y += hit.ny * hit.depth;
        reflect(ball, hit.nx, hit.ny, C().RESTITUTION);
        moved = true;
      }
      if (!moved) break;
    }
  }

  // Подшаги для быстрых шаров: за один подшаг шар не может пройти больше ~r/2
  // пикселей — иначе он «телепортируется» сквозь тонкие стенки и застревает
  // внутри блоков. Раньше шаг был фиксированным (dt/2), при скорости ~1000
  // это давало ~4 px/шаг против шара радиусом 6.5 — отсюда залёты внутрь.
  function substepsFor(ball, dt) {
    const sp = Math.hypot(ball.vx, ball.vy);
    const maxMove = Math.max(2, ball.r * 0.5);
    const need = Math.ceil((sp * dt) / maxMove);
    return Math.min(8, Math.max(C().SUBSTEPS_PER_STEP, need));
  }

  Physics.stepBall = function (ball, dt, blocks, worldW, worldH, floorY, events) {
    const cfg = C();
    const subs = substepsFor(ball, dt);
    const h = dt / subs;

    for (let s = 0; s < subs; s++) {
      ball.vy += cfg.GRAVITY * h;

      const sp = Math.hypot(ball.vx, ball.vy);
      if (sp > 1 && Math.abs(ball.vy) < sp * 0.16) {
        ball.vy += cfg.ANTI_STUCK_GRAVITY * h;
      }

      const drag = 1 - cfg.AIR_DRAG;
      ball.vx *= drag;
      ball.vy *= drag;

      const sp2 = Math.hypot(ball.vx, ball.vy);
      if (sp2 > cfg.MAX_SPEED) {
        const k = cfg.MAX_SPEED / sp2;
        ball.vx *= k; ball.vy *= k;
      } else if (sp2 < cfg.MIN_SPEED && sp2 > 0.001) {
        const k = cfg.MIN_SPEED / sp2;
        ball.vx *= k; ball.vy *= k;
      }

      ball.x += ball.vx * h;
      ball.y += ball.vy * h;

      // если центр ушёл внутрь треугольного блока — немедленно наружу (без «стен»)
      resolveInsideTris(ball, blocks);

      const r = ball.r;
      if (ball.x - r < 0) {
        ball.x = r;
        if (ball.vx < 0) { ball.vx = -ball.vx * cfg.WALL_RESTITUTION; if (events && events.onBounce) events.onBounce(ball.x, ball.y, sp2); }
      }
      if (ball.x + r > worldW) {
        ball.x = worldW - r;
        if (ball.vx > 0) { ball.vx = -ball.vx * cfg.WALL_RESTITUTION; if (events && events.onBounce) events.onBounce(ball.x, ball.y, sp2); }
      }
      if (ball.y - r < 0) {
        ball.y = r;
        if (ball.vy < 0) { ball.vy = -ball.vy * cfg.WALL_RESTITUTION; if (events && events.onBounce) events.onBounce(ball.x, ball.y, sp2); }
      }

      for (let i = 0; i < blocks.length; i++) {
        const blk = blocks[i];
        if (blk.dead) continue;

        let contact = null;
        if (blk.type === 'tri') {
          // Широкая фаза для половинчатых блоков — по описанной окружности
          // реального треугольника, а НЕ по всему прямоугольнику. Именно это
          // убирало «квадратную невидимую стену» вокруг скошенного угла:
          // раньше блок проходил broadphase в пустоте и там шар/прицел
          // чудесным образом отскакивал.
          if (!nearTriBall(ball, blk, 2)) continue;
          const by = blk._sy !== undefined ? blk._sy : blk.y;
          contact = collideTriBlock(ball, blk, by);
        } else {
          const by = blk._sy !== undefined ? blk._sy : blk.y;
          if (ball.x + r < blk.x || ball.x - r > blk.x + blk.w || ball.y + r < by || ball.y - r > by + blk.h) continue;
          const res = circleVsRoundedRect(ball.x, ball.y, r, blk.x + blk.w / 2, by + blk.h / 2, blk.w, blk.h, cfg.BLOCK_RADIUS);
          if (res) {
            ball.x += res.nx * res.depth;
            ball.y += res.ny * res.depth;
            reflect(ball, res.nx, res.ny, cfg.RESTITUTION);
            contact = { nx: res.nx, ny: res.ny };
          }
        }
        if (contact) {
          if (events && events.onBounce) events.onBounce(ball.x, ball.y, sp2);
          if (events && events.onHitBlock) events.onHitBlock(ball, blk, contact.nx, contact.ny);
        }
      }

      if (ball.y - r > floorY) {
        ball.collected = true;
        return;
      }
    }
  };

  Physics.previewPath = function (launchX, launchY, angle, blocks, worldW, worldH) {
    const cfg = C();
    const MO = cfg.MUZZLE_OFFSET;
    const fake = {
      x: launchX + Math.cos(angle) * MO,
      y: launchY + Math.sin(angle) * MO,
      vx: Math.cos(angle) * cfg.LAUNCH_SPEED,
      vy: Math.sin(angle) * cfg.LAUNCH_SPEED,
      r: cfg.BALL_BASE_RADIUS,
      collected: false
    };
    const seg = [{ x: fake.x, y: fake.y }];
    const h = cfg.FIXED_DT;
    const maxSteps = 220;
    let bounced = false;

    for (let i = 0; i < maxSteps; i++) {
      bounced = false;
      Physics.stepBall(fake, h, blocks, worldW, worldH, worldH - 8, {
        onBounce: function () { bounced = true; }
      });
      if (fake.collected || fake.y > worldH) {
        seg.push({ x: fake.x, y: worldH });
        break;
      }
      if (bounced) {
        seg.push({ x: fake.x, y: fake.y });
        break;
      }
      if ((i & 1) === 0) seg.push({ x: fake.x, y: fake.y });
    }
    return [seg];
  };

  global.RF = global.RF || {};
  global.RF.Physics = Physics;
})(window);