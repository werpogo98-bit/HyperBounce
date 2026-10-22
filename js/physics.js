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

  // Истинная форма треугольного (половинчатого) блока — те же вершины,
  // что рисует игра. Раньше физика (и прицел) использовала ВЕСЬ прямоугольник:
  // шар и preview-траектория «врезались» в пустоту срезанного угла, из-за чего
  // прицел показывал попадание в блок, которого там нет.
  function triVerts(blk) {
    const x = blk.x, y = blk._sy !== undefined ? blk._sy : blk.y;
    const w = blk.w, h = blk.h;
    switch (blk.cut) {
      case 'tl': return [{ x: x + w, y: y }, { x: x + w, y: y + h }, { x: x, y: y + h }];
      case 'tr': return [{ x: x, y: y }, { x: x + w, y: y + h }, { x: x + w, y: y }];
      case 'bl': return [{ x: x, y: y }, { x: x + w, y: y }, { x: x, y: y + h }];
      case 'br': return [{ x: x, y: y }, { x: x + w, y: y }, { x: x + w, y: y + h }];
      default: return null;
    }
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

  // Честный коллайдер для половинчатых блоков: круг против РЕАЛЬНОГО треугольника
  Physics.triHit = function (ball, blk) {
    const verts = triVerts(blk);
    if (!verts) return null;
    const inside = pointInTri(ball.x, ball.y, verts);
    if (inside) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < 3; i++) {
        const a = verts[i], b = verts[(i + 1) % 3];
        const c = closestOnSeg(ball.x, ball.y, a.x, a.y, b.x, b.y);
        if (c.d < bestD) { bestD = c.d; best = c; }
      }
      if (!best) return null;
      const depth = ball.r + bestD;
      return { nx: -best.nx, ny: -best.ny, depth };
    }
    let best = null, bestD = Infinity;
    for (let i = 0; i < 3; i++) {
      const a = verts[i], b = verts[(i + 1) % 3];
      const c = closestOnSeg(ball.x, ball.y, a.x, a.y, b.x, b.y);
      if (c.d < bestD) { bestD = c.d; best = c; }
    }
    if (!best || bestD >= ball.r) return null;
    return { nx: best.nx, ny: best.ny, depth: ball.r - bestD };
  };

  function collideTriBlock(ball, blk, by) {
    const cfg = C();
    const hit = Physics.triHit(ball, blk);
    if (hit) {
      ball.x += hit.nx * hit.depth;
      ball.y += hit.ny * hit.depth;
      reflect(ball, hit.nx, hit.ny, cfg.RESTITUTION);
      return { nx: hit.nx, ny: hit.ny };
    }
    return null;
  }

  Physics.stepBall = function (ball, dt, blocks, worldW, worldH, floorY, events) {
    const cfg = C();
    const subs = cfg.SUBSTEPS_PER_STEP;
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
        const by = blk._sy !== undefined ? blk._sy : blk.y;
        if (ball.x + r < blk.x || ball.x - r > blk.x + blk.w || ball.y + r < by || ball.y - r > by + blk.h) continue;

        let contact = null;
        if (blk.type === 'tri') {
          contact = collideTriBlock(ball, blk, by);
        } else {
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