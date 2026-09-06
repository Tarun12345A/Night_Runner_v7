// =========================================================================
// input.js — every mobile control scheme (Swipe, Tap, Buttons, Tilt) lives
// here, and every one of them calls the exact same two functions on the
// game object: tryLaneMove(delta) and trySetLane(lane) (see game.js).
// There is no separate movement logic per input method — this file only
// decides WHEN to call them.
//
// Keyboard input is handled directly in game.js's updatePlaying() since it
// naturally belongs to the per-frame update; everything else (being
// event-driven) lives here.
// =========================================================================
(function (NR) {
  "use strict";

  function game() { return window.__NR_GAME || null; }
  function playing() {
    const g = game();
    return !!g && g.state === NR.State.PLAYING && g.countdown <= 0;
  }

  const SENSITIVITY_PX = { low: 58, medium: 40, high: 26 };
  function swipeThreshold() {
    return SENSITIVITY_PX[NR.saved.settings.swipeSensitivity] || SENSITIVITY_PX.medium;
  }

  // ---- Swipe (default) -----------------------------------------------------
  // One finger, one gesture, one lane change — the gesture is "consumed"
  // the instant a threshold is crossed so a long continued drag can't fire
  // multiple lane changes from a single swipe.
  const swipeState = new Map(); // pointerId -> { startX, startY, consumed, brakeEngaged, accelEngaged }
  // Horizontal swipe -> one lane change (consumed on threshold cross).
  // Vertical swipe -> hold-style: drag down = brake, drag up = accelerate,
  // both released on pointerup/cancel, same as holding W/Up or S/Down.

  function onSwipeDown(e) {
    if (NR.saved.settings.controlMode !== "swipe") return;
    swipeState.set(e.pointerId, { startX: e.clientX, startY: e.clientY, consumed: false, brakeEngaged: false, accelEngaged: false });
  }
  function onSwipeMove(e) {
    if (NR.saved.settings.controlMode !== "swipe") return;
    const st = swipeState.get(e.pointerId);
    if (!st || st.consumed || !playing()) return;
    const dx = e.clientX - st.startX, dy = e.clientY - st.startY;
    const threshold = swipeThreshold();
    if (Math.abs(dy) > threshold && Math.abs(dy) > Math.abs(dx)) {
      if (dy > 0) { NR.press("ArrowDown"); st.brakeEngaged = true; }
      else { NR.press("ArrowUp"); st.accelEngaged = true; }
      st.consumed = true;
      return;
    }
    if (Math.abs(dx) > threshold) {
      game().tryLaneMove(dx > 0 ? 1 : -1);
      st.consumed = true;
    }
  }
  function onSwipeUp(e) {
    const st = swipeState.get(e.pointerId);
    if (st && st.brakeEngaged) NR.release("ArrowDown");
    if (st && st.accelEngaged) NR.release("ArrowUp");
    swipeState.delete(e.pointerId);
  }

  // ---- Tap (absolute lane zones) --------------------------------------------
  // The canvas width is divided into LANE_COUNT equal zones; tapping a zone
  // jumps straight to that lane. A quick double-tap still brakes, same as
  // in Swipe mode, so players don't lose that gesture when they switch modes.
  let lastTap = { time: 0, x: 0, y: 0 };
  const DOUBLE_TAP_MS = 300, DOUBLE_TAP_DIST = 44, BRAKE_PULSE_MS = 260;

  function onTapDown(e) {
    if (NR.saved.settings.controlMode !== "tap") return;
    const p = NR.pointerToCanvas(e.clientX, e.clientY);
    const now = performance.now();
    const isDouble = (now - lastTap.time < DOUBLE_TAP_MS) && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < DOUBLE_TAP_DIST;
    lastTap = isDouble ? { time: 0, x: 0, y: 0 } : { time: now, x: p.x, y: p.y };
    if (!playing()) return;
    if (isDouble) { NR.press("ArrowDown"); setTimeout(() => NR.release("ArrowDown"), BRAKE_PULSE_MS); return; }
    const zone = Math.floor((p.x / NR.W) * NR.LANE_COUNT);
    game().trySetLane(Math.max(0, Math.min(NR.LANE_COUNT - 1, zone)));
  }

  // ---- Tilt (best-effort; device/browser support varies) -------------------
  // Uses window.deviceorientation's gamma (left/right tilt in degrees).
  // Hysteresis: must return near-level before the next tilt can trigger, so
  // holding the phone tilted doesn't spam lane changes every frame.
  const TILT_TRIGGER_DEG = 13, TILT_RESET_DEG = 6;
  let tiltArmed = true, tiltPermissionRequested = false, tiltListenerAttached = false;

  function onDeviceOrientation(e) {
    if (NR.saved.settings.controlMode !== "tilt" || !playing()) return;
    const gamma = e.gamma; // -90 (left) .. +90 (right)
    if (gamma == null) return;
    if (Math.abs(gamma) < TILT_RESET_DEG) { tiltArmed = true; return; }
    if (!tiltArmed) return;
    if (gamma <= -TILT_TRIGGER_DEG) { game().tryLaneMove(-1); tiltArmed = false; }
    else if (gamma >= TILT_TRIGGER_DEG) { game().tryLaneMove(1); tiltArmed = false; }
  }

  function ensureTiltActive() {
    if (NR.saved.settings.controlMode !== "tilt" || tiltListenerAttached) return;
    const attach = () => { window.addEventListener("deviceorientation", onDeviceOrientation); tiltListenerAttached = true; };
    // iOS 13+ requires an explicit user-gesture permission prompt; other
    // browsers expose deviceorientation directly with no such API at all.
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      if (tiltPermissionRequested) return;
      tiltPermissionRequested = true;
      DeviceOrientationEvent.requestPermission().then((r) => { if (r === "granted") attach(); }).catch(() => {});
    } else {
      attach();
    }
  }

  // ---- Wheel mode: virtual circular steering wheel + accelerator/brake --
  // pedals. Continuous analog output, not discrete lane changes — see the
  // "Wheel mode" section of player.js for how this value is consumed.
  //
  // Implementation note: rather than tracking true circular grab-angle
  // (which has awkward edge cases — wraparound past ±180°, multiple turns,
  // ambiguous angle when the finger is near the hub center — all hard to
  // validate without a physical touchscreen), steering magnitude is the
  // finger's horizontal offset from the wheel's center, clamped to the
  // wheel radius. The knob still rotates visually based on the true
  // grab angle for a physically-convincing look; only the OUTPUT value
  // uses the simpler, more robust horizontal-ratio approach. This is the
  // same simplification many browser racing games use.
  const WHEEL_DEADZONE = 0.08;
  const WHEEL_CURVE_POWER = 1.6; // >1 = fine control near center, stronger at the extremes
  let wheelPointerId = null, wheelRect = null, wheelRawInput = 0;
  const wheelEl = document.getElementById("wheel-widget");
  const wheelKnobEl = document.getElementById("wheel-knob");

  function wheelPointerDown(e) {
    if (wheelPointerId !== null) return; // one finger on the wheel at a time
    wheelPointerId = e.pointerId;
    wheelRect = wheelEl.getBoundingClientRect();
    try { wheelEl.setPointerCapture(e.pointerId); } catch (err) { /* capture is best-effort */ }
    wheelEl.classList.add("active");
    e.preventDefault();
  }
  function wheelPointerMove(e) {
    if (e.pointerId !== wheelPointerId || !wheelRect) return;
    const cx = wheelRect.left + wheelRect.width / 2, cy = wheelRect.top + wheelRect.height / 2;
    const radius = wheelRect.width / 2;
    const dx = e.clientX - cx, dy = e.clientY - cy;
    const raw = Math.max(-1, Math.min(1, dx / radius));
    wheelRawInput = Math.abs(raw) < WHEEL_DEADZONE ? 0 : raw;
  }
  function wheelPointerEnd(e) {
    if (e.pointerId !== wheelPointerId) return;
    wheelPointerId = null; wheelRect = null; wheelRawInput = 0;
    wheelEl.classList.remove("active");
  }
  wheelEl.addEventListener("pointerdown", wheelPointerDown);
  wheelEl.addEventListener("pointermove", wheelPointerMove);
  wheelEl.addEventListener("pointerup", wheelPointerEnd);
  wheelEl.addEventListener("pointercancel", wheelPointerEnd);

  // Per-frame: apply the response curve, smooth toward it, and auto-recenter
  // (spring back toward 0) whenever the wheel isn't currently held. Only
  // called via updateWheelVisual() below, which owns the actual DOM write.
  let wheelSmoothed = 0;
  const WHEEL_RECENTER_RATE = 9, WHEEL_SMOOTH_RATE = 14;
  function tickWheel(dt) {
    const target = wheelPointerId !== null
      ? Math.sign(wheelRawInput) * Math.pow(Math.abs(wheelRawInput), WHEEL_CURVE_POWER)
      : 0; // released — spring back to center
    const rate = wheelPointerId !== null ? WHEEL_SMOOTH_RATE : WHEEL_RECENTER_RATE;
    wheelSmoothed += (target - wheelSmoothed) * Math.min(1, dt * rate);
    NR.wheelSteeringInput = wheelSmoothed;
  }

  // ---- Pedals (held, like the existing brake button) --------------------
  function bindPedal(id, code) {
    const el = document.getElementById(id);
    const down = (e) => { e.preventDefault(); NR.press(code); el.classList.add("pressed"); };
    const up = () => { NR.release(code); el.classList.remove("pressed"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("pointercancel", up);
  }
  bindPedal("pedal-accel", "ArrowUp");
  bindPedal("pedal-brake", "ArrowDown");

  // ---- Buttons/Wheel mode: show/hide the right overlay -------------------
  function refreshControlModeUI() {
    const mode = NR.saved.settings.controlMode;
    const laneButtons = document.getElementById("lane-buttons");
    const wheelControls = document.getElementById("wheel-controls");
    if (laneButtons) laneButtons.classList.toggle("show", mode === "buttons");
    if (wheelControls) wheelControls.classList.toggle("show", mode === "wheel");
    if (mode === "tilt") ensureTiltActive();
    if (mode !== "wheel") { wheelPointerId = null; wheelRect = null; wheelRawInput = 0; wheelSmoothed = 0; NR.wheelSteeringInput = 0; }
  }
  NR.Input = { refreshControlModeUI, tickWheel, updateWheelVisual: (steerValue, dt) => {
    if (NR.saved.settings.controlMode !== "wheel") return; // nothing to update/draw otherwise
    tickWheel(dt);
    // While actively held, show the live drag angle (most direct feel);
    // otherwise show whatever value is actually driving the car right now
    // (keyboard steering, or the spring recentering back toward 0).
    const displayValue = wheelPointerId !== null ? wheelRawInput : steerValue;
    wheelKnobEl.style.transform = `rotate(${Math.max(-70, Math.min(70, displayValue * 70))}deg)`;
  } };

  // ---- wiring ----------------------------------------------------------
  // Pointer Events unify touch/mouse/pen into one stream, so touch can
  // never double-fire as a separate synthetic mouse/click event here.
  NR.canvas.addEventListener("pointerdown", (e) => { onSwipeDown(e); onTapDown(e); });
  NR.canvas.addEventListener("pointermove", onSwipeMove);
  NR.canvas.addEventListener("pointerup", onSwipeUp);
  NR.canvas.addEventListener("pointercancel", onSwipeUp);
  NR.canvas.addEventListener("pointerleave", onSwipeUp);

  // Safety net: if focus is lost mid-gesture (app switch, alert, etc.)
  // there's no pointerup to clean up with — release everything held.
  window.addEventListener("blur", () => {
    for (const id of Array.from(swipeState.keys())) onSwipeUp({ pointerId: id });
    NR.release("ArrowDown"); NR.release("ArrowUp");
    wheelPointerEnd({ pointerId: wheelPointerId });
  });

  document.addEventListener("DOMContentLoaded", refreshControlModeUI);
})(window.NR);
