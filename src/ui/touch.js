import { el, setStyle } from './util.js';

/**
 * TouchControls — Android web remix.
 *
 * A CoD:Mobile-style overlay wired straight into the existing `Input`:
 *   - left virtual joystick  -> `input.touchStick` (merged in moveVector())
 *   - right-half drag        -> `input.addTouchLook()` (same path as the mouse)
 *   - buttons                -> `input.touchDown/touchUp()` with the standard
 *     codes (Mouse0 fire, Mouse2 ADS, Space jump, KeyR reload, ...) so the
 *     whole keyboard/mouse pipeline — edges, latching, weapons, movement —
 *     works untouched.
 *
 * Shown only on touch hardware (or `?touch=1` for desktop testing, `?touch=0`
 * to force it off). No per-frame allocation: all DOM nodes are built once.
 */
export class TouchControls {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.input = ctx.input;
    this.root = el('div', 'ow-touch', parent);

    const params = new URLSearchParams(location.search);
    const force = params.get('touch');
    this.enabled =
      force === '1' ? true : force === '0' ? false : !!this.input.isTouch;
    // `input.isTouch` is set in attach(), which runs before ui.init — but a
    // late fallback keeps `?touch` testing and odd webviews working.
    if (!this.enabled) {
      try {
        this.enabled =
          navigator.maxTouchPoints > 0 ||
          matchMedia('(pointer: coarse)').matches;
      } catch {
        /* stay hidden */
      }
    }
    if (force === '0') this.enabled = false;

    this.visible = false;
    this._lookId = null;
    this._lookX = 0;
    this._lookY = 0;
    this._stickId = null;
    this._stickCX = 0;
    this._stickCY = 0;
    this._adsSticky = false;
    this._adsDownAt = 0;
    this._buttons = [];

    this.lookGain = 2.4;
    this.stickRadius = 64;

    this._build();
    this.setVisible(this.enabled);
    this._bindWakeLock();
  }

  _build() {
    // ---- look surface (right ~62% of the screen, under the buttons) -------
    this.lookZone = el('div', 'ow-tz-look', this.root);
    this.lookZone.addEventListener('pointerdown', (e) => this._onLookDown(e));
    this.lookZone.addEventListener('pointermove', (e) => this._onLookMove(e));
    const lookEnd = (e) => this._onLookEnd(e);
    this.lookZone.addEventListener('pointerup', lookEnd);
    this.lookZone.addEventListener('pointercancel', lookEnd);

    // ---- joystick (left, fixed base — predictable under the thumb) ---------
    const stick = el('div', 'ow-tz-stick', this.root);
    this.stickBase = el('div', 'ow-tz-base', stick);
    this.stickKnob = el('div', 'ow-tz-knob', this.stickBase);
    stick.addEventListener('pointerdown', (e) => this._onStickDown(e));
    stick.addEventListener('pointermove', (e) => this._onStickMove(e));
    const stickEnd = (e) => this._onStickEnd(e);
    stick.addEventListener('pointerup', stickEnd);
    stick.addEventListener('pointercancel', stickEnd);

    // ---- buttons -----------------------------------------------------------
    // [label, code, class, sticky-behaviour]
    this._mkBtn('FIRE', 'Mouse0', 'ow-tb-fire');
    this._mkBtn('ADS', 'Mouse2', 'ow-tb-ads', 'ads');
    this._mkBtn('JUMP', 'Space', 'ow-tb-jump');
    this._mkBtn('RLD', 'KeyR', 'ow-tb-reload');
    this._mkBtn('CRCH', 'ControlLeft', 'ow-tb-crouch');
    this._mkBtn('SPRNT', 'ShiftLeft', 'ow-tb-sprint');
    this._mkBtn('USE', 'KeyF', 'ow-tb-use');
    this._mkBtn('WPN', 'Tab', 'ow-tb-swap');

    // ---- deploy veil: first tap unlocks audio + fullscreen -----------------
    this.veil = el('div', 'ow-tz-veil', this.root);
    el('div', 'ow-tz-title', this.veil, 'OVERWATCH');
    el('div', 'ow-tz-sub', this.veil, 'TAP TO DEPLOY');
    this.veil.addEventListener(
      'pointerdown',
      (e) => {
        e.preventDefault();
        this._deploy();
      },
      { passive: false }
    );
    this._deployed = false;

    // Pause chip (top-right, safe-area aware).
    this.pauseBtn = el('button', 'ow-tz-pause', this.root, 'II');
    this.pauseBtn.type = 'button';
    this.pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.peek('ui')?.menu?.toggle?.();
    });
  }

  _mkBtn(label, code, cls, mode) {
    const b = el('button', 'ow-tb ' + cls, this.root, label);
    b.type = 'button';
    const rec = { node: b, code, mode, downAt: 0 };
    if (mode === 'ads') {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rec.downAt = performance.now();
        this._adsDownAt = rec.downAt;
        this.input.touchDown(code);
        b.classList.add('held');
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* noop */
        }
      });
      const up = (e) => {
        e.stopPropagation();
        const held = performance.now() - rec.downAt;
        this.input.touchUp(code);
        b.classList.remove('held');
        // Quick tap toggles sticky ADS (stays on until the next tap).
        if (held < 240) {
          this._adsSticky = !this._adsSticky;
          if (this._adsSticky) this.input.touchDown(code);
          b.classList.toggle('sticky', this._adsSticky);
        } else if (this._adsSticky) {
          this._adsSticky = false;
          b.classList.remove('sticky');
        }
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    } else {
      b.addEventListener(
        'pointerdown',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.input.touchDown(code);
          b.classList.add('held');
          try {
            b.setPointerCapture(e.pointerId);
          } catch {
            /* noop */
          }
        },
        { passive: false }
      );
      const up = (e) => {
        e.stopPropagation();
        this.input.touchUp(code);
        b.classList.remove('held');
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
    // Long-press context menu (Android) must never fire mid-gunfight.
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    this._buttons.push(rec);
    return rec;
  }

  /* -------------------------------------------------------------- stick --- */

  _onStickDown(e) {
    if (this._stickId !== null) return;
    e.preventDefault();
    this._stickId = e.pointerId;
    const r = this.stickBase.getBoundingClientRect();
    this._stickCX = r.left + r.width / 2;
    this._stickCY = r.top + r.height / 2;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    this._moveStick(e.clientX, e.clientY);
  }

  _onStickMove(e) {
    if (e.pointerId !== this._stickId) return;
    e.preventDefault();
    this._moveStick(e.clientX, e.clientY);
  }

  _onStickEnd(e) {
    if (e.pointerId !== this._stickId) return;
    this._stickId = null;
    this.input.touchStick.moveX = 0;
    this.input.touchStick.moveY = 0;
    setStyle(this.stickKnob, 'transform', 'translate(-50%,-50%)');
  }

  _moveStick(px, py) {
    const R = this.stickRadius;
    let dx = (px - this._stickCX) / R;
    let dy = (py - this._stickCY) / R;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // moveVector convention: y+ = forward, so flip screen-y.
    this.input.touchStick.moveX = dx;
    this.input.touchStick.moveY = -dy;
    const ox = (dx * R * 0.62).toFixed(1);
    const oy = (dy * R * 0.62).toFixed(1);
    setStyle(
      this.stickKnob,
      'transform',
      `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`
    );
  }

  /* ---------------------------------------------------------------- look --- */

  _onLookDown(e) {
    if (this._lookId !== null) return;
    this._lookId = e.pointerId;
    this._lookX = e.clientX;
    this._lookY = e.clientY;
  }

  _onLookMove(e) {
    if (e.pointerId !== this._lookId) return;
    e.preventDefault();
    const dx = (e.clientX - this._lookX) * this.lookGain;
    const dy = (e.clientY - this._lookY) * this.lookGain;
    this._lookX = e.clientX;
    this._lookY = e.clientY;
    this.input.addTouchLook(dx, dy);
  }

  _onLookEnd(e) {
    if (e.pointerId !== this._lookId) return;
    this._lookId = null;
  }

  /* --------------------------------------------------------------- misc --- */

  _deploy() {
    if (this._deployed) return;
    this._deployed = true;
    setStyle(this.veil, 'display', 'none');
    // Audio unlock (a gesture is required on Android Chrome; the audio
    // subsystem also self-starts on pointerdown/touchstart — this is belt
    // and braces for webviews that swallow the first gesture).
    try {
      this.ctx.peek('audio')?.start?.()?.catch?.(() => {});
    } catch {
      /* audio is optional */
    }
    // Best-effort fullscreen + wake lock; both may reject — the game runs fine.
    try {
      document.documentElement.requestFullscreen?.().catch?.(() => {});
    } catch {
      /* not eligible */
    }
    this._requestWakeLock();
    // Dismiss the pause menu if it opened on lock-loss at boot.
    this.ctx.peek('ui')?.resume?.();
  }

  _bindWakeLock() {
    this._wakeLock = null;
    const req = () => this._requestWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') req();
    });
  }

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') {
        this._wakeLock?.release?.().catch?.(() => {});
        this._wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {
      /* unsupported — ignore */
    }
  }

  setVisible(v) {
    this.visible = !!v && this.enabled;
    setStyle(this.root, 'display', this.visible ? '' : 'none');
  }

  update() {
    // Re-evaluate coarse-pointer on the fly (DevTools docking, DeX, ...).
    if (!new URLSearchParams(location.search).get('touch')) {
      const touchNow =
        this.input.isTouch ||
        ((() => {
          try {
            return (
              navigator.maxTouchPoints > 0 ||
              matchMedia('(pointer: coarse)').matches
            );
          } catch {
            return false;
          }
        })());
      if (touchNow !== this.enabled) {
        this.enabled = touchNow;
        this.setVisible(touchNow);
      }
    }
  }

  dispose() {
    this._wakeLock?.release?.().catch?.(() => {});
    this._wakeLock = null;
    this.root.remove();
  }
}
