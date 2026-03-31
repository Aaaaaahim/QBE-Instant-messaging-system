(function () {
  'use strict';

  // Settings: default off unless explicitly enabled
  try {
    var raw = localStorage.getItem('qbe.ui.settings');
    var settings = raw ? JSON.parse(raw) : null;
    if (!settings || !settings.cursor_fx) return;
  } catch (_) { return; }

  // Do not run on touch-only devices
  try {
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
  } catch (_) {}

  // Perf guard removed for smoother feel (user controls toggle)

  var cursor = document.createElement('div');
  cursor.id = 'qbe-cursor';

  var trail = document.createElement('div');
  trail.id = 'qbe-trail';
  document.addEventListener('DOMContentLoaded', function () {
    try {
      document.body.appendChild(trail);
      document.body.appendChild(cursor);
    } catch (_) {}
  });

  var x = 0, y = 0;
  var tx = 0, ty = 0;
  var raf = 0;
  var visible = false;

  var lastBubbleAt = 0;
  var lastBx = 0, lastBy = 0;
  var bubbleKind = 'left';
  var lastKindUntil = 0;
  var bubbleRaf = 0;
  var pendingMove = false;
  var MAX_BUBBLES = 28;

  function lerp(a, b, t) { return a + (b - a) * t; }

  function tick() {
    raf = 0;
    x = lerp(x, tx, 0.35);
    y = lerp(y, ty, 0.35);
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    if (Math.abs(x - tx) + Math.abs(y - ty) > 0.1) raf = requestAnimationFrame(tick);
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function setMode(mode) {
    cursor.classList.toggle('qbe-cursor--pointer', mode === 'pointer');
    cursor.classList.toggle('qbe-cursor--text', mode === 'text');
  }

  function classifyTarget(t) {
    if (!t || t === document.documentElement) return 'default';
    if (t.closest && t.closest('input[type="text"],input[type="email"],input[type="password"],textarea,[contenteditable="true"]')) return 'text';
    if (t.closest && t.closest('a,button,.btn,.icon-btn,[role="button"],[role="switch"],label,.user,.pill,.tab,.status-item,.emoji-item')) return 'pointer';
    return 'default';
  }

  function pulse(kind) {
    var cls = kind === 'right' ? 'qbe-cursor--pulse-right' : 'qbe-cursor--pulse-left';
    cursor.classList.remove('qbe-cursor--pulse-left');
    cursor.classList.remove('qbe-cursor--pulse-right');
    // restart animation
    void cursor.offsetWidth;
    cursor.classList.add(cls);
    window.setTimeout(function () {
      cursor.classList.remove(cls);
    }, 650);
  }

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function spawnBubble(kind, sizePx, dxPx, risePx, durMs, blurPx, rotDeg, opacity) {
    if (!trail) return;
    var b = document.createElement('div');
    b.className = 'qbe-bubble';
    if (kind === 'right') b.setAttribute('data-kind', 'right');
    b.style.left = tx + 'px';
    b.style.top = ty + 'px';
    b.style.setProperty('--bs', sizePx + 'px');
    b.style.setProperty('--dx', dxPx + 'px');
    b.style.setProperty('--rise', risePx + 'px');
    b.style.setProperty('--dur', durMs + 'ms');
    b.style.setProperty('--blur', blurPx + 'px');
    b.style.setProperty('--rot', rotDeg + 'deg');
    b.style.setProperty('--op', String(opacity));
    trail.appendChild(b);
    window.setTimeout(function () {
      try { b.remove(); } catch (_) {}
    }, 900);
  }

  function maybeSpawnBubble() {
    bubbleRaf = 0;
    if (!pendingMove) return;
    pendingMove = false;
    if (document.hidden) return;

    // Bubble trail on movement (no need to drag).
    var now = performance.now ? performance.now() : Date.now();
    var dxm = tx - lastBx;
    var dym = ty - lastBy;
    var dist2 = dxm * dxm + dym * dym;
    if (dist2 > 90 && (now - lastBubbleAt) > 32) {
      if (trail && trail.childElementCount > MAX_BUBBLES) return;

      var dist = Math.sqrt(dist2);
      var speed = clamp(dist / Math.max(12, (now - lastBubbleAt)), 0.0, 2.2);

      // Size gradient: slower -> larger; faster -> smaller
      var size = clamp(16 - speed * 5.2, 8.5, 16.5);
      // Slight sideways drift + float up
      var drift = (Math.random() * 2 - 1) * (10 + speed * 10);
      var rise = 18 + Math.random() * 16 + speed * 10;
      var dur = clamp(520 + (1.0 - speed) * 240 + Math.random() * 160, 460, 980);
      var blur = clamp((speed - 0.8) * 0.2, 0, 0.5);
      var rot = (Math.random() * 2 - 1) * 14;
      var op = clamp(0.92 - speed * 0.18, 0.55, 0.92);

      var kind = (now < lastKindUntil) ? bubbleKind : 'left';
      spawnBubble(kind, size, drift, rise, dur, blur, rot, op);

      // Occasional split (reduced)
      if (Math.random() < 0.10) {
        var s2 = clamp(size * (0.55 + Math.random() * 0.25), 6, 12);
        spawnBubble(kind, s2,
          drift * 0.7 + (Math.random() * 2 - 1) * 10,
          rise * (0.85 + Math.random() * 0.25),
          dur * (0.9 + Math.random() * 0.25),
          blur,
          rot + (Math.random() * 2 - 1) * 12,
          op * 0.95);
      }
      if (Math.random() < 0.04) {
        var s3 = clamp(size * 0.45, 5, 10);
        spawnBubble(kind, s3,
          drift * 0.35 + (Math.random() * 2 - 1) * 16,
          rise * (0.70 + Math.random() * 0.25),
          dur * (0.8 + Math.random() * 0.2),
          blur,
          rot + (Math.random() * 2 - 1) * 18,
          op * 0.85);
      }

      lastBubbleAt = now;
      lastBx = tx;
      lastBy = ty;
    }
  }

  document.addEventListener('mousemove', function (e) {
    tx = e.clientX;
    ty = e.clientY;
    if (!visible) {
      visible = true;
      x = tx;
      y = ty;
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
    }
    setMode(classifyTarget(e.target));
    pendingMove = true;
    if (!bubbleRaf) bubbleRaf = requestAnimationFrame(maybeSpawnBubble);
    schedule();
  }, { passive: true });

  document.addEventListener('mouseover', function (e) {
    setMode(classifyTarget(e.target));
  }, { passive: true });

  document.addEventListener('mousedown', function (e) {
    if (!cursor) return;
    if (e.button === 2) {
      pulse('right');
      bubbleKind = 'right';
      lastKindUntil = (performance.now ? performance.now() : Date.now()) + 1200;
    } else if (e.button === 0) {
      pulse('left');
      bubbleKind = 'left';
      lastKindUntil = (performance.now ? performance.now() : Date.now()) + 900;
    }
  }, true);

  document.addEventListener('mouseleave', function () {
    // Keep it hidden if pointer leaves window
    cursor.style.left = '-9999px';
    cursor.style.top = '-9999px';
  });
})();
