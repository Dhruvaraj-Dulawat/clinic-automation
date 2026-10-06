/* ==========================================================================
   clinic-automation — ambient 3D particle field (public/js/particles.js)
   A slow-rotating depth field of gold/cream/teal dust behind the hero,
   rendered with raw WebGL (no library, no network, no build step).

   Any <canvas class="particles" data-particles> element becomes a field:
     data-density  particles (default 700 desktop / 320 small screens)
     data-speed    rotation speed multiplier (default 1)

   Behaviour contract (also the accessibility contract):
     * prefers-reduced-motion -> exactly ONE static frame, then stop.
     * document.hidden OR the canvas off-screen -> pause the loop entirely
       (no background GPU/battery burn).
     * No WebGL, or any error at any point -> remove the canvas and leave the
       CSS gradients underneath. The page must never look broken.
   ========================================================================== */
'use strict';

(function () {
  var canvases = document.querySelectorAll('canvas.particles[data-particles]');
  if (!canvases.length) return;

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) { /* matchMedia unavailable: animate */ }

  for (var i = 0; i < canvases.length; i += 1) {
    try { startField(canvases[i], reduceMotion); } catch (_) { removeCanvas(canvases[i]); }
  }

  function removeCanvas(canvas) {
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function startField(canvas, frozen) {
    var gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) { removeCanvas(canvas); return; }

    var smallScreen = false;
    try { smallScreen = window.matchMedia('(max-width: 720px)').matches; } catch (_) {}

    var density = parseInt(canvas.getAttribute('data-density'), 10);
    if (!isFinite(density) || density <= 0) density = smallScreen ? 320 : 700;
    density = Math.min(density, 1400);

    var speedMul = parseFloat(canvas.getAttribute('data-speed'));
    if (!isFinite(speedMul) || speedMul <= 0) speedMul = 1;

    // -- Shaders ------------------------------------------------------------
    var vertSrc = [
      'attribute vec3 aPos;',
      'attribute float aSize;',
      'attribute float aPhase;',
      'attribute vec3 aColor;',
      'uniform float uTime;',
      'uniform float uRotY;',
      'uniform float uTilt;',
      'uniform vec2 uRes;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main(void) {',
      '  float c = cos(uRotY), s = sin(uRotY);',
      '  vec3 p = vec3(c * aPos.x + s * aPos.z, aPos.y, -s * aPos.x + c * aPos.z);',
      '  p.y += uTilt * p.z;',
      '  float depth = (p.z * 0.5 + 0.5);',          // 0 (far) .. 1 (near)
      '  vec4 clip = vec4(p.xy, 0.0, 2.2 - p.z);',
      '  gl_Position = clip;',
      '  float tw = 0.62 + 0.38 * sin(uTime * (0.5 + fract(aPhase) * 1.2) + aPhase * 17.0);',
      '  vAlpha = tw * (0.18 + 0.82 * depth);',
      '  float px = aSize * (1400.0 / uRes.y) * (0.55 + 0.75 * depth);',
      '  gl_PointSize = clamp(px, 1.0, 9.0);',
      '  vColor = aColor;',
      '}',
    ].join('\n');

    var fragSrc = [
      'precision mediump float;',
      'varying vec3 vColor;',
      'varying float vAlpha;',
      'void main(void) {',
      '  vec2 d = gl_PointCoord - vec2(0.5);',
      '  float r2 = dot(d, d);',
      '  if (r2 > 0.25) discard;',
      '  float soft = smoothstep(0.25, 0.02, r2);',
      '  gl_FragColor = vec4(vColor, vAlpha * soft);',
      '}',
    ].join('\n');

    function shader(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader');
      return sh;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
    gl.useProgram(prog);

    // -- Particle data: two populations ------------------------------------
    // 70% fine gold/cream dust on a wide shell, 30% larger teal motes nearer.
    function rand(min, max) { return min + Math.random() * (max - min); }
    var pos = new Float32Array(density * 3);
    var size = new Float32Array(density);
    var phase = new Float32Array(density);
    var color = new Float32Array(density * 3);
    var GOLD = [0.984, 0.843, 0.518];
    var CREAM = [0.992, 0.965, 0.890];
    var TEAL = [0.25, 0.72, 0.66];
    for (var n = 0; n < density; n += 1) {
      var mote = Math.random() < 0.3;
      var radius = mote ? rand(0.45, 0.95) : rand(0.7, 1.35);
      var theta = Math.random() * Math.PI * 2;
      var y = rand(-0.85, 0.85) * (mote ? 0.7 : 1.0);
      pos[n * 3] = Math.cos(theta) * radius;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = Math.sin(theta) * radius * 0.6;
      size[n] = mote ? rand(2.2, 4.2) : rand(0.8, 2.4);
      phase[n] = Math.random() * 100;
      var pick = Math.random();
      var c = pick < 0.55 ? GOLD : (pick < 0.85 ? CREAM : TEAL);
      color[n * 3] = c[0]; color[n * 3 + 1] = c[1]; color[n * 3 + 2] = c[2];
    }

    function buffer(data, sizeN, name) {
      var loc = gl.getAttribLocation(prog, name);
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, sizeN, gl.FLOAT, false, 0, 0);
      return buf;
    }
    buffer(pos, 3, 'aPos');
    buffer(size, 1, 'aSize');
    buffer(phase, 1, 'aPhase');
    buffer(color, 3, 'aColor');

    var uTime = gl.getUniformLocation(prog, 'uTime');
    var uRotY = gl.getUniformLocation(prog, 'uRotY');
    var uTilt = gl.getUniformLocation(prog, 'uTilt');
    var uRes = gl.getUniformLocation(prog, 'uRes');

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    // -- Sizing: canvas fills its positioned parent, DPR capped at 2 --------
    function resize() {
      var parent = canvas.parentNode;
      var w = parent ? parent.clientWidth : window.innerWidth;
      var h = parent ? parent.clientHeight : 480;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var W = Math.max(1, Math.floor(w * dpr));
      var H = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W; canvas.height = H;
      }
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      gl.viewport(0, 0, W, H);
      gl.uniform2f(uRes, W, H);
    }

    // -- Pointer parallax: the field leans a few degrees toward the cursor ---
    var targetTiltX = 0;
    var targetRotExtra = 0;
    var tiltX = 0;
    var rotExtra = 0;
    function onPointer(e) {
      var r = canvas.getBoundingClientRect();
      var nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
      var ny = ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1;
      targetRotExtra = nx * 0.35;
      targetTiltX = ny * 0.12;
    }
    try { window.addEventListener('pointermove', onPointer, { passive: true }); } catch (_) {}

    // -- Frame loop ----------------------------------------------------------
    var running = true;
    var rotY = Math.random() * Math.PI * 2;
    var start = performance.now();

    function frame(now) {
      if (!running) return;
      var t = (now - start) / 1000;
      rotY += 0.0009 * speedMul;
      // Ease the parallax toward the pointer so motion feels weighted.
      rotExtra += (targetRotExtra - rotExtra) * 0.03;
      tiltX += (targetTiltX - tiltX) * 0.03;

      resize();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, t);
      gl.uniform1f(uRotY, rotY + rotExtra);
      gl.uniform1f(uTilt, tiltX);
      gl.drawArrays(gl.POINTS, 0, density);

      if (!frozen) requestAnimationFrame(frame);
    }

    function setRunning(on) {
      if (on === running) return;
      running = on;
      if (running) requestAnimationFrame(frame);
    }

    // Pause when the tab hides or the field scrolls out of view.
    try {
      document.addEventListener('visibilitychange', function () {
        setRunning(!document.hidden && !frozen);
      });
    } catch (_) {}
    try {
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
          if (!frozen) setRunning(entries[0].isIntersecting && !document.hidden);
        }, { threshold: 0 }).observe(canvas);
      }
    } catch (_) {}
    try { window.addEventListener('resize', resize); } catch (_) {}

    resize();
    requestAnimationFrame(frame);
  }
})();
