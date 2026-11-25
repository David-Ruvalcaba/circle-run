"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

class ArrowInput {
  static keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  pressed = new Set();
  touchDirections = new Map();

  constructor(onDash, onPause) {
    for (const type of ["keydown", "keyup"]) {
      window.addEventListener(type, event => {
        if (!ArrowInput.keys.includes(event.key)) {
          if (type === "keydown" && !event.repeat) {
            const key = event.key.toLowerCase();
            if (key === "d") onDash();
            if (key === "p") onPause();
          }
          return;
        }
        event.preventDefault();
        if (type === "keydown") this.pressed.add(event.key);
        else this.pressed.delete(event.key);
      });
    }
    window.addEventListener("blur", () => {
      this.pressed.clear();
      this.clearTouch();
    });
  }

  clearTouch() {
    for (const button of this.touchDirections.values()) button.removeAttribute("data-held");
    this.touchDirections.clear();
  }

  setTouchDirection(id, button) {
    const previous = this.touchDirections.get(id);
    this.touchDirections.delete(id);
    if (previous && ![...this.touchDirections.values()].includes(previous)) {
      previous.removeAttribute("data-held");
    }
    if (button) {
      this.touchDirections.set(id, button);
      button.setAttribute("data-held", "");
    }
  }

  direction() {
    let x = Number(this.pressed.has("ArrowRight")) - Number(this.pressed.has("ArrowLeft"));
    let y = Number(this.pressed.has("ArrowDown")) - Number(this.pressed.has("ArrowUp"));
    for (const button of new Set(this.touchDirections.values())) {
      const [dx, dy] = button.dataset.direction.split(",").map(Number);
      x += dx;
      y += dy;
    }
    x = Math.sign(x);
    y = Math.sign(y);
    const length = Math.hypot(x, y) || 1;
    return { x: x / length, y: y / length };
  }
}

class MobileControls {
  static enabled(navigator) {
    return navigator.userAgentData?.mobile === true ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  constructor(game) {
    this.input = game.input;
    this.portrait = window.matchMedia("(orientation: portrait)");
    this.menu = document.querySelector("#menu");
    this.dashButton = document.querySelector("#touch-dash");
    const pad = document.querySelector("#direction-pad");
    const buttonAt = element => {
      const button = element?.closest("button[data-direction]");
      return pad.contains(button) ? button : null;
    };

    pad.addEventListener("pointerdown", event => {
      const button = buttonAt(event.target);
      if (!button || game.paused || this.portrait.matches) return;
      event.preventDefault();
      pad.setPointerCapture(event.pointerId);
      this.input.setTouchDirection(event.pointerId, button);
    });
    pad.addEventListener("pointermove", event => {
      if (!this.input.touchDirections.has(event.pointerId) && !pad.hasPointerCapture(event.pointerId)) return;
      if (game.paused || this.portrait.matches) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      this.input.setTouchDirection(event.pointerId, buttonAt(target));
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
      pad.addEventListener(type, event => this.input.setTouchDirection(event.pointerId, null));
    }
    this.dashButton.addEventListener("pointerdown", event => {
      if (this.dashButton.disabled) return;
      event.preventDefault();
      game.dash();
    });
    this.dashButton.addEventListener("click", event => {
      if (event.detail === 0) game.dash();
    });
    this.menu.addEventListener("click", () => game.togglePause());
    document.querySelector("#resume").addEventListener("click", () => {
      game.togglePause();
      this.menu.focus();
    });
    this.portrait.addEventListener("change", () => {
      this.input.clearTouch();
      game.resize();
    });
  }

  update(paused, dashes) {
    this.menu.setAttribute("aria-expanded", String(paused));
    this.menu.setAttribute("aria-label", paused ? "Resume game" : "Pause and show instructions");
    this.dashButton.disabled = paused || dashes === 0;
  }
}

class ProgressStore {
  static key = "circle-run-v1";

  constructor() {
    this.stores = [];
    for (const name of ["localStorage", "sessionStorage"]) {
      try {
        this.stores.push(window[name]);
      } catch {
        // A browser may disable either storage area.
      }
    }
  }

  load() {
    for (const store of this.stores) {
      try {
        const progress = JSON.parse(store.getItem(ProgressStore.key));
        if (progress && Array.isArray(progress.obstacles) &&
            progress.obstacles.every(Obstacle.isValidSpawn)) return progress;
      } catch {
        // Try the other storage area if this save is unavailable.
      }
    }
    return { obstacles: [] };
  }

  save(progress) {
    for (const store of this.stores) {
      try {
        store.setItem(ProgressStore.key, JSON.stringify(progress));
      } catch {
        // The current run remains playable without storage.
      }
    }
  }
}

class Entity {
  constructor(width, height, spawn) {
    this.width = width;
    this.height = height;
    this.spawn = spawn;
  }

  reset(bounds) {
    const start = this.spawn(bounds);
    this.place(start.x, start.y, bounds);
  }

  place(x, y, bounds) {
    const halfWidth = Math.min(this.width, bounds.width) / 2;
    const halfHeight = Math.min(this.height, bounds.height) / 2;
    this.x = clamp(x, halfWidth, bounds.width - halfWidth);
    this.y = clamp(y, halfHeight, bounds.height - halfHeight);
  }

  clearance(other) {
    return {
      x: (this.width + other.width) / 2,
      y: (this.height + other.height) / 2
    };
  }

  // Sweep the bounding box along a segment so fast obstacles cannot cross a blocker.
  crosses(other, x, y, start = this) {
    const clearance = this.clearance(other);
    let enter = 0;
    let exit = 1;
    for (const [axis, target] of [["x", x], ["y", y]]) {
      const offset = start[axis] - other[axis];
      const travel = target - start[axis];
      const half = clearance[axis];
      if (!travel) {
        if (Math.abs(offset) >= half) return false;
        continue;
      }
      const a = (-half - offset) / travel;
      const b = (half - offset) / travel;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
    return enter < exit;
  }

  move(x, y, bounds, blockers) {
    const previous = { x: this.x, y: this.y };
    this.place(x, y, bounds);
    const target = { x: this.x, y: this.y };
    Object.assign(this, previous);
    if (blockers.some(other => other !== this && this.crosses(other, target.x, target.y))) {
      return false;
    }
    Object.assign(this, target);
    return target.x !== previous.x || target.y !== previous.y;
  }
}

class Player extends Entity {
  constructor(spawnY = 0.5) {
    super(20, 20, bounds => ({ x: 24, y: bounds.height * spawnY }));
    this.radius = 10;
    this.speed = 240;
  }

  update(seconds, bounds, direction) {
    this.place(this.x + direction.x * this.speed * seconds,
      this.y + direction.y * this.speed * seconds, bounds);
  }

  draw(context) {
    context.beginPath();
    context.arc(this.x, this.y, this.radius - context.lineWidth / 2, 0, Math.PI * 2);
    context.stroke();
  }
}

class Rectangle extends Entity {
  hits(player) {
    const dx = Math.max(0, Math.abs(player.x - this.x) - this.width / 2);
    const dy = Math.max(0, Math.abs(player.y - this.y) - this.height / 2);
    return Math.hypot(dx, dy) <= player.radius;
  }

  draw(context) {
    const inset = context.lineWidth / 2;
    context.strokeRect(this.x - this.width / 2 + inset, this.y - this.height / 2 + inset,
      this.width - 2 * inset, this.height - 2 * inset);
  }
}

class Goal extends Rectangle {
  constructor(spawnY = 0.5) {
    super(64, 48, bounds => ({ x: bounds.width - 46, y: bounds.height * spawnY }));
  }

  draw(context) {
    super.draw(context);
    context.font = "bold 15px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("GOAL", this.x, this.y);
  }
}

class Patrol extends Rectangle {
  constructor(spawn, axis) {
    super(axis === "y" ? 22 : 66, axis === "y" ? 66 : 22, spawn);
    this.axis = axis;
  }

  reset(bounds) {
    super.reset(bounds);
    this.origin = this[this.axis];
    this.elapsed = 0;
  }

  update(seconds, bounds, blockers) {
    this.elapsed += seconds;
    const size = this.axis === "x" ? bounds.width : bounds.height;
    const offset = Math.sin(this.elapsed * 1.5) * Math.min(85, size * 0.13);
    const x = this.axis === "x" ? this.origin + offset : this.x;
    const y = this.axis === "y" ? this.origin + offset : this.y;
    this.move(x, y, bounds, blockers);
  }
}

class Triangle extends Entity {
  constructor(spawn) {
    super(32, 32, spawn);
  }

  static speed(score) {
    // Increase every level while keeping pursuit below the player's top speed.
    return 52 + 128 * score / (score + 12);
  }

  vertices() {
    return [
      { x: this.x, y: this.y - 15 },
      { x: this.x + 15, y: this.y + 15 },
      { x: this.x - 15, y: this.y + 15 }
    ];
  }

  update(seconds, bounds, blockers, player, score) {
    const target = this.pursuitTarget(player, bounds, blockers);
    const x = target.x - this.x;
    const y = target.y - this.y;
    const distance = Math.hypot(x, y);
    if (distance === 0) return;
    const step = Math.min(Triangle.speed(score) * seconds, distance) / distance;
    const nextX = this.x + x * step;
    const nextY = this.y + y * step;
    if (!this.move(nextX, nextY, bounds, blockers)) {
      this.move(nextX, this.y, bounds, blockers);
      this.move(this.x, nextY, bounds, blockers);
    }
  }

  pursuitTarget(player, bounds, blockers) {
    const blocker = blockers.find(other => other !== this && this.crosses(other, player.x, player.y));
    if (!blocker) {
      this.detour = null;
      return player;
    }
    if (this.detour?.blocker === blocker) {
      const point = this.detour.point;
      if (Math.hypot(this.x - point.x, this.y - point.y) > 1 &&
          !blockers.some(other => other !== this && this.crosses(other, point.x, point.y))) {
        return point;
      }
    }

    const gap = this.clearance(blocker);
    const left = blocker.x - gap.x - 3;
    const right = blocker.x + gap.x + 3;
    const top = blocker.y - gap.y - 3;
    const bottom = blocker.y + gap.y + 3;
    const corners = [{x: left, y: top}, {x: right, y: top},
      {x: right, y: bottom}, {x: left, y: bottom}];
    const usable = point => point.x >= this.width / 2 && point.x <= bounds.width - this.width / 2 &&
      point.y >= this.height / 2 && point.y <= bounds.height - this.height / 2;
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let best = null;
    let cost = Infinity;
    for (const [index, corner] of corners.entries()) {
      if (!usable(corner) || distance(this, corner) <= 1 ||
          blockers.some(other => other !== this && this.crosses(other, corner.x, corner.y))) continue;
      for (const end of [corner, corners[(index + 1) % 4], corners[(index + 3) % 4]]) {
        if (!usable(end)) continue;
        if (this.crosses(blocker, player.x, player.y, end)) continue;
        const length = distance(this, corner) + distance(corner, end) + distance(end, player);
        if (length < cost) {
          cost = length;
          best = corner;
        }
      }
    }
    this.detour = best ? { blocker, point: best } : null;
    return best || player;
  }

  reset(bounds) {
    super.reset(bounds);
    this.detour = null;
  }

  hits(player) {
    const vertices = this.vertices();
    let inside = true;
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];
      const x = b.x - a.x;
      const y = b.y - a.y;
      const dx = player.x - a.x;
      const dy = player.y - a.y;
      if (x * dy - y * dx < 0) inside = false;
      const t = clamp((dx * x + dy * y) / (x * x + y * y), 0, 1);
      if (Math.hypot(dx - t * x, dy - t * y) <= player.radius + 1) return true;
    }
    return inside;
  }

  draw(context) {
    const [first, second, third] = this.vertices();
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(second.x, second.y);
    context.lineTo(third.x, third.y);
    context.closePath();
    context.stroke();
  }
}

class Projectile extends Rectangle {
  constructor(turret, player) {
    super(8, 8);
    const dx = player.x - turret.x;
    const dy = player.y - turret.y;
    const distance = Math.hypot(dx, dy) || 1;
    this.direction = { x: dx / distance, y: dy / distance };
    const gap = this.clearance(turret);
    const muzzle = Math.min(gap.x / Math.abs(this.direction.x),
      gap.y / Math.abs(this.direction.y)) + 0.01;
    this.x = turret.x + this.direction.x * muzzle;
    this.y = turret.y + this.direction.y * muzzle;
    this.speed = player.speed * 3;
  }

  advance(seconds, bounds, blockers, player) {
    const distance = this.speed * seconds;
    const steps = Math.max(1, Math.ceil(distance / 2));
    for (let i = 0; i < steps; i++) {
      if (this.hits(player)) return "player";
      const x = this.x + this.direction.x * distance / steps;
      const y = this.y + this.direction.y * distance / steps;
      if (x < this.width / 2 || x > bounds.width - this.width / 2 ||
          y < this.height / 2 || y > bounds.height - this.height / 2 ||
          blockers.some(other => other !== this && this.crosses(other, x, y))) return "blocked";
      this.x = x;
      this.y = y;
    }
    return this.hits(player) ? "player" : "flying";
  }
}

class Turret extends Rectangle {
  constructor(spawn) {
    super(30, 36, spawn);
  }

  reset(bounds) {
    super.reset(bounds);
    this.cooldown = 1.25;
  }

  update(seconds, bounds, blockers, player) {
    this.cooldown -= seconds;
    if (this.cooldown > 0) return;
    this.cooldown += 1.25;
    return new Projectile(this, player);
  }

  draw(context) {
    const radius = (this.width - context.lineWidth) / 2;
    const cap = 5;
    const top = this.y - this.height / 2 + cap + context.lineWidth / 2;
    const bottom = this.y + this.height / 2 - cap - context.lineWidth / 2;
    context.beginPath();
    context.ellipse(this.x, top, radius, cap, 0, 0, Math.PI * 2);
    context.moveTo(this.x - radius, top);
    context.lineTo(this.x - radius, bottom);
    context.moveTo(this.x + radius, top);
    context.lineTo(this.x + radius, bottom);
    context.ellipse(this.x, bottom, radius, cap, 0, 0, Math.PI);
    context.stroke();
  }
}

class Obstacle {
  static types = ["triangle", "vertical", "horizontal", "cylinder"];

  static randomSpawn() {
    return {
      type: Obstacle.types[Math.floor(Math.random() * Obstacle.types.length)],
      x: Math.random(),
      y: Math.random()
    };
  }

  static isValidSpawn(spawn) {
    return spawn && Obstacle.types.includes(spawn.type) &&
      [spawn.x, spawn.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1);
  }

  static create(data) {
    const spawn = bounds => ({ x: bounds.width * data.x, y: bounds.height * data.y });
    if (data.type === "cylinder") return new Turret(spawn);
    return data.type === "triangle"
      ? new Triangle(spawn)
      : new Patrol(spawn, data.type === "vertical" ? "y" : "x");
  }
}

class CircleRun {
  constructor(canvas, score, level, dashCounter, pauseStatus, mobile = false) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.score = score;
    this.level = level;
    this.dashCounter = dashCounter;
    this.pauseStatus = pauseStatus;
    this.paused = false;
    this.input = new ArrowInput(() => this.dash(), () => this.togglePause());
    if (mobile) this.mobileControls = new MobileControls(this);
    this.store = new ProgressStore();
    this.progress = this.store.load();
    this.loadLayout();
    this.activeObstacles = [];
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    requestAnimationFrame(this.frame);
  }

  loadLayout() {
    this.player = new Player(this.progress.playerY);
    this.goal = new Goal(this.progress.goalY);
    this.obstacles = this.progress.obstacles.map(Obstacle.create);
  }

  resize() {
    if (this.bounds && this.mobileControls?.portrait.matches) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    if (this.bounds?.width === width && this.bounds?.height === height && this.scale === scale) return;
    this.bounds = { width, height };
    this.scale = scale;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.reset();
  }

  reset() {
    this.started = false;
    this.activeDash = null;
    this.projectiles = [];
    this.dashes = this.obstacles.length >= 4 ? 2 : 0;
    this.player.reset(this.bounds);
    this.goal.reset(this.bounds);
    this.activeObstacles = [];
    for (const obstacle of this.obstacles) {
      obstacle.reset(this.bounds);
      if (this.findSpawn(obstacle)) {
        if (obstacle instanceof Patrol) obstacle.origin = obstacle[obstacle.axis];
        this.activeObstacles.push(obstacle);
      }
    }
    this.updateHud();
  }

  findSpawn(obstacle) {
    const { width, height } = this.bounds;
    const minX = obstacle.width / 2 + 4;
    const minY = obstacle.height / 2 + 4;
    if (width < 2 * minX || height < 2 * minY) return false;
    const safeDistance = clamp(Math.min(width, height) * 0.35, 72, 160);
    const canSpawn = () => {
      const dx = Math.max(0, Math.abs(obstacle.x - this.player.x) - obstacle.width / 2);
      const dy = Math.max(0, Math.abs(obstacle.y - this.player.y) - obstacle.height / 2);
      if (Math.hypot(dx, dy) < safeDistance + this.player.radius) return false;
      return [this.goal, ...this.activeObstacles].every(other => {
        const gap = obstacle.clearance(other);
        return Math.abs(obstacle.x - other.x) >= gap.x + 24 ||
          Math.abs(obstacle.y - other.y) >= gap.y + 24;
      });
    };

    const preferred = { x: obstacle.x / width, y: obstacle.y / height };
    // Probe the full field in a repeatable order, starting at the saved random position.
    for (let i = 0; i < 160; i++) {
      const u = (preferred.x + i * 0.754877666) % 1;
      const v = (preferred.y + i * 0.569840291) % 1;
      obstacle.place(minX + u * (width - 2 * minX), minY + v * (height - 2 * minY), this.bounds);
      if (canSpawn()) return true;
    }
    return false;
  }

  updateHud() {
    this.score.textContent = this.obstacles.length;
    this.level.textContent = this.obstacles.length + 1;
    this.dashCounter.textContent = ">".repeat(this.dashes);
    this.dashCounter.setAttribute("aria-label", `${this.dashes} dashes available`);
    this.mobileControls?.update(this.paused, this.dashes);
  }

  togglePause() {
    this.paused = !this.paused;
    this.pauseStatus.hidden = !this.paused;
    this.input.clearTouch();
    this.mobileControls?.update(this.paused, this.dashes);
  }

  dash() {
    if (this.paused || this.mobileControls?.portrait.matches || this.activeDash || !this.dashes) return;
    const direction = this.input.direction();
    if (!direction.x && !direction.y) return;
    const { x, y } = this.player;
    this.player.place(x + direction.x, y + direction.y, this.bounds);
    const canMove = this.player.x !== x || this.player.y !== y;
    this.player.place(x, y, this.bounds);
    if (!canMove) return;

    this.activeDash = { direction, remaining: 150 };
    this.started = true;
    this.dashes--;
    this.updateHud();
  }

  advanceDash(seconds) {
    const dash = this.activeDash;
    let travel = Math.min(dash.remaining, 550 * seconds);
    while (travel > 0) {
      const step = Math.min(travel, 2);
      this.player.place(this.player.x + dash.direction.x * step,
        this.player.y + dash.direction.y * step, this.bounds);
      travel -= step;
      dash.remaining -= step;
      this.activeObstacles = this.activeObstacles.filter(obstacle => !obstacle.hits(this.player));
      this.projectiles = this.projectiles.filter(shot => !shot.hits(this.player));
      if (this.goal.hits(this.player)) {
        this.clearLevel();
        return true;
      }
      this.advanceObstacles(step / 550, true);
    }
    if (dash.remaining < 1e-6) {
      this.activeDash = null;
      return true;
    }
    return false;
  }

  clearLevel() {
    const obstacles = Array.from({ length: this.progress.obstacles.length + 1 },
      Obstacle.randomSpawn);
    this.progress = {
      obstacles,
      playerY: 0.15 + Math.random() * 0.7,
      goalY: 0.15 + Math.random() * 0.7
    };
    this.loadLayout();
    this.store.save(this.progress);
    this.reset();
  }

  update(seconds) {
    if (this.paused || this.mobileControls?.portrait.matches) return;
    const steps = Math.max(1, Math.ceil(seconds * this.player.speed / 2));
    for (let step = 0; step < steps; step++) {
      if (this.advance(seconds / steps)) break;
    }
  }

  advance(seconds) {
    if (this.activeDash) return this.advanceDash(seconds);
    const previousX = this.player.x;
    const previousY = this.player.y;
    this.player.update(seconds, this.bounds, this.input.direction());
    this.started ||= this.player.x !== previousX || this.player.y !== previousY;
    if (!this.started) return false;
    if ([...this.activeObstacles, ...this.projectiles].some(shape => shape.hits(this.player))) {
      this.reset();
      return true;
    }
    if (this.goal.hits(this.player)) {
      this.clearLevel();
      return true;
    }
    return this.advanceObstacles(seconds);
  }

  advanceObstacles(seconds, dashing = false) {
    const blockers = [this.goal, ...this.activeObstacles];
    const shots = [];
    for (const obstacle of this.activeObstacles) {
      const shot = obstacle.update(seconds, this.bounds, blockers, this.player, this.obstacles.length);
      if (shot) shots.push(shot);
      if (!dashing && obstacle.hits(this.player)) {
        this.reset();
        return true;
      }
    }
    if (dashing) {
      this.activeObstacles = this.activeObstacles.filter(obstacle => !obstacle.hits(this.player));
    }
    const solids = [this.goal, ...this.activeObstacles];
    const projectileBlockers = [...solids, ...this.projectiles];
    const survivors = [];
    for (const shot of this.projectiles) {
      const result = shot.advance(seconds, this.bounds, projectileBlockers, this.player);
      if (result === "player" && !dashing) {
        this.reset();
        return true;
      }
      if (result === "flying") survivors.push(shot);
      else projectileBlockers.splice(projectileBlockers.indexOf(shot), 1);
    }
    for (const shot of shots) {
      if (projectileBlockers.some(shape => shot.crosses(shape, shot.x, shot.y)) ||
          shot.x < shot.width / 2 || shot.x > this.bounds.width - shot.width / 2 ||
          shot.y < shot.height / 2 || shot.y > this.bounds.height - shot.height / 2) continue;
      if (shot.hits(this.player)) {
        if (dashing) continue;
        this.reset();
        return true;
      }
      projectileBlockers.push(shot);
      survivors.push(shot);
    }
    this.projectiles = survivors;
    return false;
  }

  frame = now => {
    const seconds = Math.min((now - (this.previousFrame ?? now)) / 1000, 1 / 30);
    this.previousFrame = now;
    this.update(seconds);
    const { width, height } = this.bounds;
    this.context.clearRect(0, 0, width, height);
    this.context.lineWidth = 2;
    this.context.lineJoin = "round";
    for (const entity of [this.goal, ...this.activeObstacles, ...this.projectiles, this.player]) {
      entity.draw(this.context);
    }
    requestAnimationFrame(this.frame);
  };
}

const mobile = MobileControls.enabled(navigator);
document.body.classList.toggle("mobile-game", mobile);
new CircleRun(document.querySelector("canvas"), document.querySelector("#score"),
  document.querySelector("#level"), document.querySelector("#dash"),
  document.querySelector("#pause"), mobile);
