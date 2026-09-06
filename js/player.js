// =========================================================================
// player.js — supports TWO movement models, selected by control mode:
//
//   Lane mode (Swipe/Tap/Buttons/Tilt/keyboard-default): discrete lane-snap
//   movement — moveToLane(delta)/setLane(lane) nudge a target lane index,
//   and this file eases the car toward that lane's center every frame.
//
//   Wheel mode: continuous analog steering — setSteeringInput(-1..1) sets a
//   target lateral velocity each frame; the car drives freely across the
//   road instead of snapping between fixed lanes, closer to a real
//   steering wheel. Speed-based sensitivity reduction and smoothing are
//   applied here so every steering source (keyboard held in Wheel mode, or
//   the virtual wheel widget) shares one physics implementation.
//
// Speed is automatic: the car eases toward a rising "cruise" target that
// game.js derives from level/progression. Up/W (or drag-up / accelerator
// pedal) adds extra speed on top of cruise; Down/S (or drag-down / brake
// pedal) cuts it. The speedometer (ui.js) reads Player.speedFactor/kmh.
// =========================================================================
(function (NR) {
  "use strict";
  const { ROAD_LEFT, ROAD_RIGHT, LANE_COUNT, LANE_WIDTH, CAR_W, CAR_H, H, ctx } = NR;

  // Base gameplay speed multiplier range, and the realistic km/h range it
  // maps to for the speedometer. Garage "Top Speed" upgrades raise both
  // ceilings; see garage.js effectiveMaxS()/effectiveKmhMax().
  const BASE_MIN_S = 0.55, BASE_MAX_S = 1.85;
  const BASE_KMH_MIN = 35, BASE_KMH_MAX = 235;
  const LANE_TWEEN_RATE = 13;     // per second; higher = snappier lane changes

  // ---- Wheel-mode steering tuning (all centralized here, per the "don't
  // scatter tunables" requirement) ----
  const STEER_MAX_VX = 620;           // px/sec of lateral speed at full steering lock
  const STEER_RESPONSE_RATE = 11;     // how fast actual vx chases the target — smoothing
  const STEER_HIGH_SPEED_REDUCTION = 0.28; // up to 28% less sensitive at max speedFactor

  class Player {
    constructor() { this.reset(); }
    reset() {
      // Re-read garage upgrades at the start of every run — they only
      // change between runs (in the Garage screen), never mid-run.
      this.minS = BASE_MIN_S;
      this.maxS = NR.Garage ? NR.Garage.effectiveMaxS(BASE_MAX_S) : BASE_MAX_S;
      this.kmhMin = BASE_KMH_MIN;
      this.kmhMax = NR.Garage ? NR.Garage.effectiveKmhMax(BASE_KMH_MAX) : BASE_KMH_MAX;
      this.accelMul = NR.Garage ? NR.Garage.effectiveAccelMul() : 1;
      this.handlingMul = NR.Garage ? NR.Garage.effectiveHandlingMul() : 1;
      this.color = NR.Garage ? NR.Garage.colorHex(NR.saved.carColor) : "#2fe6c9";

      this.wheelMode = NR.saved.settings.controlMode === "wheel";
      this.lane = Math.min(LANE_COUNT - 1, 1); // start in the second-from-left lane
      this.x = this.wheelMode ? (ROAD_LEFT + ROAD_RIGHT) / 2 - CAR_W / 2 : this.laneCenterX(this.lane) - CAR_W / 2;
      this.y = H - CAR_H - 26;
      this.tilt = 0;
      this.steeringInput = 0;   // -1..1, set continuously by input.js in Wheel mode
      this.vx = 0;              // lateral velocity, Wheel mode only
      this.speedFactor = 1.0;
      this.kmh = this.kmhMin + ((this.speedFactor - this.minS) / (this.maxS - this.minS)) * (this.kmhMax - this.kmhMin);
      this.braking = false;
      this._lastX = this.x;
    }

    laneCenterX(lane) { return ROAD_LEFT + lane * LANE_WIDTH + LANE_WIDTH / 2; }

    // ---- Lane-mode movement API (Swipe/Tap/Buttons/Tilt/keyboard) --------
    // The one shared entry point for every discrete input method. delta is
    // -1 or +1. Returns true if the lane actually changed (false if already
    // at the road edge), so callers can skip haptics/sound/trail effects.
    moveToLane(delta) {
      const next = Math.max(0, Math.min(LANE_COUNT - 1, this.lane + delta));
      if (next === this.lane) return false;
      this.lane = next;
      return true;
    }
    // Absolute jump used by Tap mode (tapping a specific lane zone).
    setLane(lane) {
      const next = Math.max(0, Math.min(LANE_COUNT - 1, lane));
      if (next === this.lane) return false;
      this.lane = next;
      return true;
    }

    // ---- Wheel-mode movement API ------------------------------------------
    // Called continuously (every frame) with the current analog value,
    // already deadzone/curve-processed by input.js (or computed directly
    // from held keyboard state in game.js when Wheel mode + keyboard).
    setSteeringInput(value) { this.steeringInput = Math.max(-1, Math.min(1, value)); }

    update(dt, braking, cruiseTarget, nitro, accelerating) {
      this._lastX = this.x;

      if (this.wheelMode) {
        // Continuous analog steering: target lateral velocity is
        // proportional to the (already-curved) steering input, reduced
        // slightly at high speed for stability, then smoothed so raw
        // touch/keyboard input can't make the car twitch.
        const speedRatio = Math.max(0, Math.min(1, (this.speedFactor - this.minS) / (this.maxS - this.minS)));
        const sensitivity = 1 - STEER_HIGH_SPEED_REDUCTION * speedRatio;
        const targetVx = this.steeringInput * STEER_MAX_VX * sensitivity * this.handlingMul;
        this.vx += (targetVx - this.vx) * Math.min(1, dt * STEER_RESPONSE_RATE);
        this.x += this.vx * dt;
        const minX = ROAD_LEFT + 6, maxX = ROAD_RIGHT - CAR_W - 6;
        if (this.x < minX) { this.x = minX; this.vx = 0; }
        if (this.x > maxX) { this.x = maxX; this.vx = 0; }
      } else {
        const targetX = this.laneCenterX(this.lane) - CAR_W / 2;
        const tweenRate = LANE_TWEEN_RATE * this.handlingMul;
        this.x += (targetX - this.x) * Math.min(1, dt * tweenRate);
      }
      const visualVx = (this.x - this._lastX) / Math.max(dt, 1 / 240);
      this.tilt += ((visualVx / 460) * 0.22 - this.tilt) * Math.min(1, dt * 10);

      // Nitro power-up: raises the ceiling and pulls speed toward it fast,
      // without touching the permanent garage-upgraded maxS.
      const ceiling = nitro ? this.maxS * 1.22 : this.maxS;
      const cruise = Math.min(ceiling, cruiseTarget == null ? 1.0 : cruiseTarget);
      this.braking = !!braking && !nitro && !accelerating;
      if (nitro) this.speedFactor += 3.2 * this.accelMul * dt;
      else if (accelerating && !braking) this.speedFactor += 1.5 * this.accelMul * dt; // Up/W (or drag-up / accel pedal)
      else if (this.braking) this.speedFactor -= 1.9 * this.accelMul * dt;
      else this.speedFactor += (cruise - this.speedFactor) * Math.min(1, dt * (1.1 * this.accelMul));
      this.speedFactor = Math.max(this.minS, Math.min(ceiling, this.speedFactor));

      // Smoothly-updating real-time km/h reading, directly derived from speedFactor.
      const targetKmh = this.kmhMin + ((this.speedFactor - this.minS) / (this.maxS - this.minS)) * (this.kmhMax - this.kmhMin);
      this.kmh += (targetKmh - this.kmh) * Math.min(1, dt * 6);
    }
    bounds() { return { x: this.x, y: this.y, w: CAR_W, h: CAR_H }; }
    draw() {
      ctx.save();
      ctx.translate(this.x + CAR_W / 2, this.y + CAR_H / 2);
      ctx.rotate(this.tilt);
      ctx.translate(-CAR_W / 2, -CAR_H / 2);
      NR.drawCar(0, 0, CAR_W, CAR_H, this.color, "#e6fffa", this.braking);
      ctx.restore();
    }
  }

  NR.Player = Player;
  NR.SPEED_RANGE = { MIN_S: BASE_MIN_S, MAX_S: BASE_MAX_S, KMH_MIN: BASE_KMH_MIN, KMH_MAX: BASE_KMH_MAX };
})(window.NR);
