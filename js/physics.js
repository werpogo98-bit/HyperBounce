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

  function triPlane(blk) {
    const x = blk.x, y = blk._sy !== undefined ? blk._sy : blk.y;
    const w = blk.w, h = blk.h;
    switch (blk.cut) {
      case 'tl': return { px: x + w, py: y, nx: -Math.SQRT1_2, ny: -Math.SQRT1_2, ex: x, ey: y + h };
      case 'tr': return { px: x, py: y, nx: Math.SQRT1_2, ny: -Math.SQRT1_2, ex: x + w, ey: y + h };
      case 'bl': return { px: x, py: y, nx: -Math.SQRT1_2, ny: Math.SQRT1_2, ex: x + w, ey: y + h };
      case 'br': return { px: x + w, py: y, nx: Math.SQRT1_2, ny: Math.SQRT1_2, ex: x, ey: y + h };
      default: return null;
    }
  }

  function reflect(ball, nx, ny, rest) {
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= (1 + rest) * vn * nx;
      ball.vy -= (1 + rest) * vn * ny;
    }
  }

  function collideTriBlock(ball, blk, by) {
    const cfg = C();
    const plane = triPlane(blk);
    if (plane) {
      const d = (ball.x - plane.px) * plane.nx + (ball.y - plane.py) * plane.ny;
      if (d > 0 && d < ball.r) {
        const vx = plane.ex - plane.px, vy = plane.ey - plane.py;
        const t = ((ball.x - plane.px) * vx + (ball.y - plane.py) * vy) / (vx * vx + vy * vy);
        if (t >= 0 && t <= 1) {
          ball.x += plane.nx * (ball.r - d);
          ball.y += plane.ny * (ball.r - d);
          reflect(ball, plane.nx, plane.ny, cfg.RESTITUTION);
          return { nx: plane.nx, ny: plane.ny };
        }
      }
    }
    const res = circleVsRoundedRect(ball.x, ball.y, ball.r, blk.x + blk.w / 2, by + blk.h / 2, blk.w, blk.h, cfg.BLOCK_RADIUS);
    if (res) {
      ball.x += res.nx * res.depth;
      ball.y += res.ny * res.depth;
      reflect(ball, res.nx, res.ny, cfg.RESTITUTION);
      return { nx: res.nx, ny: res.ny };
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