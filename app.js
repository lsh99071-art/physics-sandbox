"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const DT = 1 / 240;
  const MAX_TIME = 300;
  const COLORS = ["#a5edbd", "#ffd293", "#a8caff", "#e0b8f0"];
  const TITLES = {
    body: "물체",
    platform: "수평 발판",
    ramp: "경사면",
    fixed: "고정 도르래",
    moving: "이동 도르래",
    anchor: "고정점",
    rope: "줄"
  };
  const DYNAMIC = n => n.kind === "body" || n.kind === "moving";
  const SURFACE = n => n.kind === "platform" || n.kind === "ramp";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const hypot = (x, y) => Math.hypot(x, y);
  const fmt = (x, n = 2) =>
    Number.isFinite(x)
      ? (Math.abs(x) < 0.5 * 10 ** -n ? 0 : x).toFixed(n)
      : "—";
  const copy = x => JSON.parse(JSON.stringify(x));
  const esc = x => String(x).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
  let serial = 0;
  const uid = () => "n" + Date.now().toString(36) + (++serial).toString(36);

  function node(kind, x, y, extra = {}) {
    return {
      id: uid(), kind, name: TITLES[kind], x, y,
      m: kind === "moving" ? 1 : 2,
      radius: kind === "moving" ? 0.25 : 0.35,
      mu: 0.2, fx: 0, fy: 0, vx: 0, vy: 0,
      length: 6, angle: kind === "ramp" ? 25 : 0,
      ...extra
    };
  }

  function rope(nodes, path) {
    const r = { id: uid(), kind: "rope", name: "줄", path, length: 0 };
    const map = new Map(nodes.map(n => [n.id, n]));
    for (let i = 1; i < path.length; i++) {
      const a = map.get(path[i - 1]), b = map.get(path[i]);
      r.length += hypot(b.x - a.x, b.y - a.y);
    }
    return r;
  }

  function example(kind = "train") {
    const s = { version: 1, g: 9.8, nodes: [], ropes: [] };
    const add = (...args) => {
      const n = node(...args);
      s.nodes.push(n);
      return n;
    };
    const link = list => s.ropes.push(rope(s.nodes, list.map(n => n.id)));

    if (kind === "train") {
      add("platform", 8, 1, { length: 14, mu: 0 });
      const a = add("body", 4, 1.35, { name: "A", m: 2, mu: 0 });
      const b = add("body", 7, 1.35, { name: "B", m: 3, mu: 0, fx: 12 });
      link([a, b]);
    } else if (kind === "incline") {
      const angle = 25 * Math.PI / 180;
      add("ramp", 8, 3, { length: 10, angle: 25, mu: 0.2 });
      add("body", 8 - Math.sin(angle) * 0.35,
        3 + Math.cos(angle) * 0.35, { name: "A", m: 2, mu: 0.2 });
    } else if (kind === "fall") {
      add("body", 8, 8, { name: "A", m: 2 });
      add("platform", 8, 0.5, { length: 14, mu: 0 });
    } else if (kind === "projectile") {
      add("body", 3, 2, { name: "A", vx: 5, vy: 7, mu: 0 });
      add("platform", 8, 0.5, { length: 15, mu: 0 });
    } else if (kind === "atwood") {
      const a = add("body", 5, 4, { name: "A", m: 2 });
      const p = add("fixed", 5, 8, { name: "P₁" });
      const q = add("fixed", 11, 8, { name: "P₂" });
      const b = add("body", 11, 4, { name: "B", m: 3 });
      link([a, p, q, b]);
    } else if (kind === "moving") {
      const anchor = add("anchor", 5, 9, { name: "고정점" });
      const moving = add("moving", 5, 4, { name: "P", m: 4 });
      const p = add("fixed", 5, 8, { name: "P₁" });
      const q = add("fixed", 11, 8, { name: "P₂" });
      const b = add("body", 11, 3, { name: "A", m: 1 });
      link([anchor, moving, p, q, b]);
    }
    return s;
  }

  let scene = example();
  let engine;
  let selected = scene.nodes.find(DYNAMIC).id;
  let tool = "select", route = [];
  let running = false, finished = false, lastTime = 0, accumulated = 0;
  let activeTab = "analysis", drag = null;
  let view = { x: 0, y: 0, w: 16, h: 10 };
  let renderAt = 0, learningAt = 0;
  let uiDirty = true;

  function addTerm(terms, id, x, y) {
    const old = terms.get(id) || { x: 0, y: 0 };
    terms.set(id, { x: old.x + x, y: old.y + y });
  }

  function geometry(r, map) {
    let length = 0;
    const terms = new Map();
    for (let i = 1; i < r.path.length; i++) {
      const a = map.get(r.path[i - 1]), b = map.get(r.path[i]);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = hypot(dx, dy);
      if (d < 1e-7) continue;
      length += d;
      const ux = dx / d, uy = dy / d;
      // J = -∇L. 양의 충격량이 줄 경로를 짧게 만든다.
      if (DYNAMIC(a)) addTerm(terms, a.id, ux, uy);
      if (DYNAMIC(b)) addTerm(terms, b.id, -ux, -uy);
    }
    return { length, terms };
  }

  function matrixEntry(a, b, map) {
    let sum = 0;
    a.terms.forEach((u, id) => {
      const v = b.terms.get(id), p = map.get(id);
      if (v && DYNAMIC(p)) sum += (u.x * v.x + u.y * v.y) / p.m;
    });
    return sum;
  }

  function rank(matrix, tolerance = 1e-8) {
    if (!matrix.length) return 0;
    const a = matrix.map(r => r.slice());
    let row = 0;
    for (let col = 0; col < a[0].length && row < a.length; col++) {
      let pivot = row;
      for (let r = row + 1; r < a.length; r++)
        if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
      if (Math.abs(a[pivot][col]) < tolerance) continue;
      [a[row], a[pivot]] = [a[pivot], a[row]];
      const div = a[row][col];
      for (let c = col; c < a[0].length; c++) a[row][c] /= div;
      for (let r = 0; r < a.length; r++) {
        if (r === row) continue;
        const factor = a[r][col];
        for (let c = col; c < a[0].length; c++) a[r][c] -= factor * a[row][c];
      }
      row++;
    }
    return row;
  }

  function validate(s) {
    const errors = [];
    if (!s || s.version !== 1 || !Array.isArray(s.nodes) ||
        !Array.isArray(s.ropes)) return ["지원하는 실험 파일 형식이 아닙니다."];
    if (!Number.isFinite(s.g) || s.g < 0 || s.g > 30)
      errors.push("중력가속도는 0~30 m/s²여야 합니다.");
    if (s.nodes.length > 40 || s.ropes.length > 12)
      errors.push("이 버전은 항목 40개와 줄 12개까지 지원합니다.");
    const ids = new Set();
    const allowed = ["body", "moving", "platform", "ramp", "fixed", "anchor"];
    for (const n of s.nodes) {
      if (!n || typeof n.id !== "string" || ids.has(n.id)) {
        errors.push("항목 ID가 없거나 중복됩니다."); continue;
      }
      ids.add(n.id);
      if (!allowed.includes(n.kind)) errors.push("지원하지 않는 항목 종류입니다.");
      if (typeof n.name !== "string" || n.name.length > 60)
        errors.push("항목 이름은 60자 이내여야 합니다.");
      if (![n.x, n.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1000))
        errors.push("위치는 −1000~1000 m 범위여야 합니다.");
      if (DYNAMIC(n)) {
        if (!Number.isFinite(n.m) || n.m < 0.05 || n.m > 100)
          errors.push("질량은 0.05~100 kg이어야 합니다.");
        if (!Number.isFinite(n.radius) || n.radius < 0.1 || n.radius > 1)
          errors.push("접촉 반지름은 0.1~1 m여야 합니다.");
        if (![n.fx, n.fy].every(v => Number.isFinite(v) && Math.abs(v) <= 200))
          errors.push("외력은 각 방향 −200~200 N이어야 합니다.");
        if (![n.vx, n.vy].every(v => Number.isFinite(v) && Math.abs(v) <= 30))
          errors.push("초기 속도는 각 방향 −30~30 m/s여야 합니다.");
      }
      if (DYNAMIC(n) || SURFACE(n)) {
        if (!Number.isFinite(n.mu) || n.mu < 0 || n.mu > 2)
          errors.push("마찰계수는 0~2여야 합니다.");
      }
      if (SURFACE(n)) {
        if (!Number.isFinite(n.length) || n.length < 0.5 || n.length > 40)
          errors.push("발판 길이는 0.5~40 m여야 합니다.");
        if (!Number.isFinite(n.angle) || Math.abs(n.angle) > 80 ||
            (n.kind === "platform" && n.angle !== 0))
          errors.push("발판 각도를 확인하세요. 수평 발판은 0°, 경사면은 ±80°입니다.");
      }
    }
    if (errors.length) return [...new Set(errors)];
    const map = new Map(s.nodes.map(n => [n.id, n]));
    const dynamics = s.nodes.filter(DYNAMIC);
    if (!dynamics.length) errors.push("물체 또는 이동 도르래를 한 개 이상 추가하세요.");
    if (dynamics.length > 12) errors.push("움직이는 항목은 12개까지 지원합니다.");

    const pulleyUse = new Map();
    const tautRows = [];
    const signatures = new Set();
    for (const r of s.ropes) {
      if (!r || typeof r.id !== "string" || ids.has(r.id)) {
        errors.push("줄 ID가 없거나 중복됩니다."); continue;
      }
      ids.add(r.id);
      if (typeof r.name !== "string" || r.name.length > 60)
        errors.push("줄 이름을 확인하세요.");
      if (!Array.isArray(r.path) || r.path.length < 2 || r.path.length > 12 ||
          r.path.some(id => !map.has(id))) {
        errors.push("줄의 연결점이 없거나 경로 길이가 지원 범위를 벗어났습니다.");
        continue;
      }
      if (new Set(r.path).size !== r.path.length)
        errors.push("한 줄이 같은 연결점을 반복해서 지나는 구조는 지원하지 않습니다.");
      for (let i = 0; i < r.path.length; i++) {
        const n = map.get(r.path[i]);
        if (SURFACE(n)) errors.push("줄은 발판에 직접 연결할 수 없습니다. 고정점을 사용하세요.");
        if (i > 0 && i < r.path.length - 1) {
          if (!["fixed", "moving"].includes(n.kind))
            errors.push("줄 경로 중간에는 고정·이동 도르래만 올 수 있습니다.");
          pulleyUse.set(n.id, (pulleyUse.get(n.id) || 0) + 1);
        }
        if (i) {
          const a = map.get(r.path[i - 1]);
          if (hypot(n.x - a.x, n.y - a.y) < 0.05)
            errors.push("인접한 줄 연결점은 0.05 m 이상 떨어져야 합니다.");
        }
      }
      const key = [r.path.join("|"), r.path.slice().reverse().join("|")].sort()[0];
      if (signatures.has(key)) errors.push("동일한 경로의 중복 줄은 지원하지 않습니다.");
      signatures.add(key);
      if (!Number.isFinite(r.length) || r.length < 0.1 || r.length > 200)
        errors.push("줄 길이는 0.1~200 m여야 합니다.");
      const geo = geometry(r, map);
      if (geo.length > r.length + 0.015)
        errors.push(`${r.name}: 줄이 현재 경로보다 짧습니다. 자동 길이를 누르세요.`);
      if (geo.terms.size === 0)
        errors.push(`${r.name}: 움직이는 물체가 연결되지 않았습니다.`);
      if (Math.abs(geo.length - r.length) <= 0.02)
        tautRows.push({ terms: geo.terms });
    }
    if ([...pulleyUse.values()].some(v => v > 1))
      errors.push("도르래 하나를 여러 줄이 통과하는 다중 홈 구조는 지원하지 않습니다.");
    if (tautRows.length) {
      const a = tautRows.map(r => tautRows.map(q => matrixEntry(r, q, map)));
      if (rank(a) < tautRows.length)
        errors.push("줄 구속이 중복되거나 특이합니다. 장력을 유일하게 구할 수 없어 실행하지 않습니다.");
    }

    for (let i = 0; i < dynamics.length; i++) {
      const b = dynamics[i];
      for (let j = i + 1; j < dynamics.length; j++) {
        const c = dynamics[j];
        if (hypot(b.x - c.x, b.y - c.y) < b.radius + c.radius - 0.025)
          errors.push(`${b.name}와 ${c.name}가 겹칩니다. 떨어뜨려 배치하세요.`);
      }
      for (const p of s.nodes.filter(SURFACE)) {
        const a = p.angle * Math.PI / 180;
        const tx = Math.cos(a), ty = Math.sin(a), nx = -ty, ny = tx;
        const dx = b.x - p.x, dy = b.y - p.y;
        const along = dx * tx + dy * ty, d = dx * nx + dy * ny;
        if (Math.abs(along) <= p.length / 2 && d >= 0 && d < b.radius - 0.025)
          errors.push(`${b.name}가 발판 윗면을 파고듭니다. 위로 옮기세요.`);
      }
    }
    return [...new Set(errors)];
  }

  function createEngine(s) {
    const e = {
      model: copy(s), nodes: copy(s.nodes), time: 0, rows: [], matrix: [],
      rhs: [], residual: 0, history: [], nextSample: 0.05
    };
    e.map = new Map(e.nodes.map(n => [n.id, n]));
    e.dynamic = e.nodes.filter(DYNAMIC);
    e.dynamic.forEach(n => {
      n.ax = 0; n.ay = -s.g;
      n.forces = [
        { kind: "gravity", name: "mg", x: 0, y: -n.m * s.g },
        { kind: "external", name: "F", x: n.fx, y: n.fy }
      ];
    });
    e.initialU = e.dynamic.reduce((v, n) => v + n.m * s.g * n.y, 0);
    record(e);
    return e;
  }

  function record(e) {
    const bodies = {};
    e.dynamic.forEach(n => {
      bodies[n.id] = {
        x: n.x, y: n.y, vx: n.vx, vy: n.vy,
        ax: n.ax, ay: n.ay, speed: hypot(n.vx, n.vy),
        energy: 0.5 * n.m * (n.vx ** 2 + n.vy ** 2) + n.m * e.model.g * n.y
      };
    });
    e.history.push({ t: e.time, bodies });
  }

  function dotVelocity(row, map) {
    let v = 0;
    row.terms.forEach((g, id) => {
      const n = map.get(id);
      v += g.x * n.vx + g.y * n.vy;
    });
    return v;
  }

  function applyImpulse(row, amount, map) {
    row.terms.forEach((g, id) => {
      const n = map.get(id);
      n.vx += amount * g.x / n.m;
      n.vy += amount * g.y / n.m;
    });
  }

  function makeRows(e, h) {
    const rows = [], map = e.map;
    function contact(a, b, nx, ny, gap, mu, label) {
      const normal = {
        kind: "normal", label, gap, impulse: 0,
        terms: new Map([[a.id, { x: nx, y: ny }]])
      };
      const tangent = {
        kind: "friction", label: "f " + label, gap: 0, impulse: 0,
        parent: normal, mu,
        terms: new Map([[a.id, { x: -ny, y: nx }]])
      };
      if (b) {
        normal.terms.set(b.id, { x: -nx, y: -ny });
        tangent.terms.set(b.id, { x: ny, y: -nx });
      }
      rows.push(normal, tangent);
    }

    const platforms = e.nodes.filter(SURFACE);
    for (const b of e.dynamic) {
      for (const p of platforms) {
        const a = p.angle * Math.PI / 180;
        const tx = Math.cos(a), ty = Math.sin(a), nx = -ty, ny = tx;
        const dx = b.x - p.x, dy = b.y - p.y;
        const along = dx * tx + dy * ty;
        const distance = dx * nx + dy * ny;
        const gap = distance - b.radius;
        const reach = 0.06 + hypot(b.vx, b.vy) * h;
        if (Math.abs(along) <= p.length / 2 && distance > -0.02 && gap < reach) {
          contact(b, null, nx, ny, gap, Math.min(b.mu, p.mu),
            `${p.name}→${b.name}`);
        }
      }
    }

    for (let i = 0; i < e.dynamic.length; i++) {
      for (let j = i + 1; j < e.dynamic.length; j++) {
        const a = e.dynamic[i], b = e.dynamic[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d = hypot(dx, dy), gap = d - a.radius - b.radius;
        const reach = 0.05 + (hypot(a.vx, a.vy) + hypot(b.vx, b.vy)) * h;
        if (d > 1e-6 && gap < reach) {
          contact(a, b, dx / d, dy / d, gap, Math.min(a.mu, b.mu),
            `${b.name}↔${a.name}`);
        }
      }
    }

    for (const r of e.model.ropes) {
      const geo = geometry(r, map);
      rows.push({
        kind: "rope", label: r.name, ropeId: r.id, terms: geo.terms,
        gap: r.length - geo.length, impulse: 0
      });
    }
    rows.forEach(r => r.diag = matrixEntry(r, r, map));
    return rows;
  }

  function integrate(e, h = DT) {
    const old = new Map();
    for (const n of e.dynamic) {
      old.set(n.id, { vx: n.vx, vy: n.vy });
      n.vx += n.fx / n.m * h;
      n.vy += (n.fy / n.m - e.model.g) * h;
    }
    const rows = makeRows(e, h);
    const rhs = rows.map(r => -dotVelocity(r, e.map) - r.gap / h);

    for (let pass = 0; pass < 160; pass++) {
      for (const r of rows) {
        if (r.diag < 1e-12) continue;
        const correction = (-dotVelocity(r, e.map) - r.gap / h) / r.diag;
        const oldImpulse = r.impulse;
        if (r.kind === "friction") {
          const limit = r.mu * r.parent.impulse;
          r.impulse = clamp(oldImpulse + correction, -limit, limit);
        } else {
          r.impulse = Math.max(0, oldImpulse + correction);
        }
        applyImpulse(r, r.impulse - oldImpulse, e.map);
      }
    }

    let residual = 0;
    for (const r of rows) {
      if (r.kind === "friction") continue;
      const value = dotVelocity(r, e.map) + r.gap / h;
      residual = Math.max(residual,
        r.impulse > 1e-8 ? Math.abs(value) : Math.max(0, -value));
    }
    e.residual = residual;
    e.rows = rows;
    e.rhs = rhs;
    e.matrix = rows.map(a => rows.map(b => matrixEntry(a, b, e.map)));

    for (const n of e.dynamic) {
      const prev = old.get(n.id);
      n.ax = (n.vx - prev.vx) / h;
      n.ay = (n.vy - prev.vy) / h;
      n.forces = [
        { kind: "gravity", name: "mg", x: 0, y: -n.m * e.model.g },
        { kind: "external", name: "F", x: n.fx, y: n.fy }
      ];
    }
    rows.forEach(r => {
      if (Math.abs(r.impulse) < 1e-8) return;
      r.terms.forEach((g, id) => {
        e.map.get(id).forces.push({
          kind: r.kind, name: r.kind === "rope" ? "T " + r.label :
            r.kind === "normal" ? "N" : "f",
          x: g.x * r.impulse / h, y: g.y * r.impulse / h
        });
      });
    });

    for (const n of e.dynamic) {
      n.x += n.vx * h; n.y += n.vy * h;
    }
    e.time += h;
    if (e.time + 1e-9 >= e.nextSample) {
      record(e); e.nextSample += 0.05;
    }
  }

  function message(text, error = false) {
    $("notice").textContent = text;
    $("notice").classList.toggle("error", error);
  }

  function pause(label = "일시정지") {
    running = false; lastTime = 0; accumulated = 0;
    $("play").textContent = finished ? "↺ 다시 시작" : "▶ 시작";
    $("status").textContent = label;
    uiDirty = true;
  }

  function reset(announce = false) {
    pause("실험 준비");
    finished = false;
    $("play").textContent = "▶ 시작";
    engine = createEngine(scene);
    // 초기 화면에서도 접촉력과 장력이 보이도록 별도 복사본으로 예측.
    const preview = createEngine(scene);
    integrate(preview);
    engine.rows = preview.rows;
    engine.matrix = preview.matrix;
    engine.rhs = preview.rhs;
    engine.residual = preview.residual;
    engine.dynamic.forEach(n => {
      const p = preview.map.get(n.id);
      n.ax = p.ax; n.ay = p.ay; n.forces = p.forces;
    });
    if (announce) message("초기 배치와 초기 속도로 돌아왔습니다.");
    uiDirty = true;
    render(true);
  }

  function changed() {
    reset();
    const errors = validate(scene);
    if (errors.length) message(errors.join("\n"), true);
    else message("설정이 반영되었습니다. 시작을 눌러 실험하세요.");
  }

  function start() {
    if (running) {
      pause(); render(true); return;
    }
    if (finished) reset();
    const errors = validate(scene);
    if (errors.length) {
      message(errors.join("\n"), true); return;
    }
    if (route.length) {
      message("연결 중인 줄을 먼저 완성하거나 취소하세요.", true); return;
    }
    tool = "select"; setTool("select");
    running = true; lastTime = 0; accumulated = 0;
    $("play").textContent = "Ⅱ 일시정지";
    $("status").textContent = "실험 진행 중";
    message("수치 계산 간격 1/240초 · 반발계수 0 · 좌표: 오른쪽 +x, 위쪽 +y");
    uiDirty = true;
    render(true);
  }

  function checkRuntime() {
    const invalid = engine.dynamic.some(n =>
      ![n.x, n.y, n.vx, n.vy, n.ax, n.ay].every(Number.isFinite)
    );
    if (invalid || engine.residual > 0.03) {
      pause("계산 중단");
      message("구속조건 계산이 수렴하지 않았습니다. 중복 접촉·줄 연결을 줄이거나 배치를 바꾸세요. 이 구조의 결과는 신뢰할 수 없습니다.", true);
      return false;
    }
    for (const r of scene.ropes) {
      for (let i = 1; i < r.path.length; i++) {
        const a = engine.map.get(r.path[i - 1]), b = engine.map.get(r.path[i]);
        if (hypot(a.x - b.x, a.y - b.y) < 0.035) {
          pause("지원 범위 도달");
          message("인접한 줄 연결점이 거의 겹쳐 경로 방향을 정의할 수 없습니다. 배치를 바꾸세요.", true);
          return false;
        }
      }
    }
    if (engine.time >= MAX_TIME ||
        engine.dynamic.some(n => Math.abs(n.x) > 1000 || Math.abs(n.y) > 1000)) {
      finished = true; pause("기록 범위 도달");
      message("최대 기록 시간 또는 좌표 범위에 도달했습니다. 초기화 후 다시 실험하세요.");
      return false;
    }
    return true;
  }

  function project(x, y) {
    return { x: (x - view.x) / view.w * 1000,
      y: 625 - (y - view.y) / view.h * 625 };
  }
  function unproject(clientX, clientY) {
    const p = $("workspace").createSVGPoint();
    p.x = clientX; p.y = clientY;
    const q = p.matrixTransform($("workspace").getScreenCTM().inverse());
    return { x: view.x + q.x / 1000 * view.w,
      y: view.y + (625 - q.y) / 625 * view.h };
  }
  const px = m => m / view.w * 1000;

  function fitView() {
    const nodes = engine ? engine.nodes : scene.nodes;
    if (!nodes.length) {
      view = { x: 0, y: 0, w: 16, h: 10 }; return;
    }
    const points = [];
    nodes.forEach(n => {
      if (SURFACE(n)) {
        const a = n.angle * Math.PI / 180;
        for (const k of [-1, 1])
          points.push({ x: n.x + k * n.length / 2 * Math.cos(a),
            y: n.y + k * n.length / 2 * Math.sin(a) });
      } else points.push(n);
    });
    const minX = Math.min(...points.map(p => p.x)) - 1.5;
    const maxX = Math.max(...points.map(p => p.x)) + 1.5;
    const minY = Math.min(...points.map(p => p.y)) - 1.5;
    const maxY = Math.max(...points.map(p => p.y)) + 1.5;
    const w = Math.max(10, maxX - minX, (maxY - minY) * 1.6);
    const h = w / 1.6;
    view = { x: (minX + maxX - w) / 2,
      y: (minY + maxY - h) / 2, w, h };
  }

  const forceColor = kind => ({
    gravity: "#ffbf7a", external: "#c5afff", normal: "#83c5ff",
    friction: "#ff9fbc", rope: "#a6efbd"
  }[kind] || "#ffffff");

  function arrow(x, y, dx, dy, color, label = "", light = false) {
    const magnitude = hypot(dx, dy);
    if (magnitude < 0.015) return "";
    const len = clamp(magnitude * 3, 24, 110);
    const ux = dx / magnitude, uy = -dy / magnitude;
    const ex = x + ux * len, ey = y + uy * len;
    const bx = ex - ux * 9, by = ey - uy * 9;
    return `<g pointer-events="none">
      <path d="M${x} ${y}L${ex} ${ey}" stroke="${color}" stroke-width="3"/>
      <path d="M${ex} ${ey}L${bx - uy * 4} ${by + ux * 4}L${bx + uy * 4} ${by - ux * 4}Z" fill="${color}"/>
      ${label ? `<text x="${ex + ux * 10}" y="${ey + uy * 10 + 4}"
      text-anchor="${ux > 0.25 ? "start" : ux < -0.25 ? "end" : "middle"}"
      font-size="12" fill="${light ? "#284a34" : color}"
      stroke="${light ? "#f5f7f1" : "#142f29"}"
      stroke-width="3" paint-order="stroke">${esc(label)}</text>` : ""}
    </g>`;
  }

  function draw() {
    let s = `<defs><pattern id="grid" width="${px(1)}" height="${px(1)}" patternUnits="userSpaceOnUse"
      x="${project(0,0).x}" y="${project(0,0).y}">
      <path d="M${px(1)} 0H0V${px(1)}" fill="none" stroke="#45634e" stroke-width=".6" opacity=".55"/>
      </pattern></defs><rect width="1000" height="625" fill="url(#grid)"/>`;
    const origin = project(0, 0);
    s += `<path d="M0 ${origin.y}H1000M${origin.x} 0V625" stroke="#63856b" stroke-width="1" opacity=".6"/>`;
    s += `<text x="20" y="28" fill="#9fbea6" font-size="12">+y ↑　+x →　1格 = 1 m</text>`;

    if ($("showTrails").checked) {
      for (const n of engine.dynamic) {
        const rows = engine.history.slice(-400);
        const path = rows.map((r, i) => {
          const b = r.bodies[n.id], p = project(b.x, b.y);
          return (i ? "L" : "M") + p.x + " " + p.y;
        }).join(" ");
        s += `<path d="${path}" fill="none" stroke="#b7dcae" stroke-width="1.5" opacity=".35"/>`;
      }
    }

    for (const r of scene.ropes) {
      const geo = geometry(r, engine.map);
      const slack = r.length - geo.length > 0.015;
      const points = r.path.map(id => {
        const n = engine.map.get(id); return project(n.x, n.y);
      });
      let path = `M${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        path += slack
          ? `Q${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + 22} ${b.x} ${b.y}`
          : `L${b.x} ${b.y}`;
      }
      const row = engine.rows.find(q => q.ropeId === r.id);
      s += `<g data-id="${r.id}" style="cursor:pointer">
        <path d="${path}" fill="none" stroke="transparent" stroke-width="18"/>
        <path d="${path}" fill="none" stroke="${r.id === selected ? "#ffee9c" : slack ? "#72937a" : "#dbebbc"}"
        stroke-width="${r.id === selected ? 4 : 2.5}" ${slack ? 'stroke-dasharray="7 5"' : ""}/>
      </g>`;
      const p = points[Math.floor(points.length / 2)];
      s += `<text x="${p.x + 12}" y="${p.y - 18}" fill="#c3d8ad" font-size="11" pointer-events="none">
        ${esc(r.name)} · ${slack ? "느슨함" : "T " + fmt((row?.impulse || 0) / DT) + " N"}</text>`;
    }

    let dynamicIndex = 0;
    for (const n of engine.nodes) {
      const p = project(n.x, n.y), chosen = selected === n.id;
      s += `<g data-id="${n.id}" style="cursor:${tool === "rope" ? "crosshair" : "grab"}">`;
      if (SURFACE(n)) {
        const a = n.angle * Math.PI / 180;
        const dx = Math.cos(a) * n.length / 2, dy = Math.sin(a) * n.length / 2;
        const l = project(n.x - dx, n.y - dy), r = project(n.x + dx, n.y + dy);
        s += `<path d="M${l.x} ${l.y}L${r.x} ${r.y}" stroke="transparent" stroke-width="25"/>
          <path d="M${l.x} ${l.y + 6}L${r.x} ${r.y + 6}" stroke="#416c49" stroke-width="11"/>
          <path d="M${l.x} ${l.y}L${r.x} ${r.y}" stroke="${chosen ? "#ffee9c" : "#afd1a3"}" stroke-width="4"/>
          <text x="${p.x}" y="${p.y + 30}" text-anchor="middle" fill="#a2c29a" font-size="12">${esc(n.name)} ${fmt(n.angle,0)}°</text>`;
      } else if (n.kind === "anchor") {
        s += `<path d="M${p.x - 18} ${p.y - 16}H${p.x + 18}" stroke="#a8c6a2" stroke-width="6"/>
          <circle cx="${p.x}" cy="${p.y}" r="9" fill="#7c9e77" stroke="${chosen ? "#ffee9c" : "#bed9ae"}" stroke-width="3"/>`;
      } else if (n.kind === "fixed" || n.kind === "moving") {
        const r = n.kind === "fixed" ? 21 : clamp(px(n.radius), 13, 40);
        if (n.kind === "fixed") {
          s += `<path d="M${p.x} ${p.y - r}V${p.y - r - 16}M${p.x - 16} ${p.y - r - 16}H${p.x + 16}" stroke="#88ad83" stroke-width="5"/>`;
        }
        s += `<circle cx="${p.x}" cy="${p.y}" r="${r + (chosen ? 6 : 0)}" fill="#234b38" stroke="${chosen ? "#ffee9c" : "#a8d498"}" stroke-width="3"/>
          <circle cx="${p.x}" cy="${p.y}" r="5" fill="#c6e9ad"/>
          <path d="M${p.x-r*.65} ${p.y}H${p.x+r*.65}M${p.x} ${p.y-r*.65}V${p.y+r*.65}" stroke="#7ca372" stroke-width="2"/>
          <text x="${p.x + r + 9}" y="${p.y + 4}" fill="#d4e9c5" font-size="12">${esc(n.name)}${n.kind === "moving" ? " · " + fmt(n.m,1) + " kg" : ""}</text>`;
      } else {
        const color = COLORS[dynamicIndex++ % COLORS.length];
        const r = px(n.radius);
        s += `${chosen ? `<circle cx="${p.x}" cy="${p.y}" r="${r + 6}" fill="none" stroke="#ddeb9f" stroke-width="2" opacity=".65"/>` : ""}
          <circle cx="${p.x}" cy="${p.y}" r="${r}" fill="${color}" stroke="#dceccf" stroke-width="1.5"/>
          <text x="${p.x}" y="${p.y + 1}" text-anchor="middle" fill="#234731" font-size="14" font-weight="800">${esc(n.name)}</text>
          <text x="${p.x}" y="${p.y + 16}" text-anchor="middle" fill="#315b3c" font-size="10">${fmt(n.m,1)} kg</text>`;
      }
      s += "</g>";
    }

    const body = engine.map.get(selected);
    if (body && DYNAMIC(body)) {
      const p = project(body.x, body.y);
      if ($("showForces").checked) {
        body.forces.forEach((f, i) => {
          const shift = (i - 1) * 7;
          s += arrow(p.x + shift, p.y, f.x, f.y, forceColor(f.kind), f.name);
        });
      }
      if ($("showVelocity").checked)
        s += arrow(p.x, p.y - px(body.radius) - 30,
          body.vx * 3, body.vy * 3, "#d8c6ff", "v");
    }

    if (route.length) {
      const points = route.map(id => {
        const n = engine.map.get(id); return project(n.x, n.y);
      });
      s += `<polyline points="${points.map(p => p.x + "," + p.y).join(" ")}"
        fill="none" stroke="#ffee9c" stroke-width="3" stroke-dasharray="6 5" pointer-events="none"/>`;
      points.forEach((p, i) => s += `<circle cx="${p.x}" cy="${p.y}" r="9" fill="#ffee9c" pointer-events="none"/>
        <text x="${p.x}" y="${p.y+4}" text-anchor="middle" font-size="11" fill="#294732" pointer-events="none">${i+1}</text>`);
    }
    const visible = engine.dynamic.some(n => {
      const p = project(n.x, n.y);
      return p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 625;
    });
    if (!visible) s += `<rect x="250" y="260" width="500" height="70" rx="12" fill="#203d2f" opacity=".95"/>
      <text x="500" y="300" text-anchor="middle" fill="#cfe4be" font-size="16">물체가 화면 밖에 있습니다. ‘전체 보기’를 누르세요.</text>`;
    $("workspace").innerHTML = s;
  }

  function inputField(key, label, value, min, max, step = "0.1") {
    return `<label class="field">${label}<input data-prop="${key}" type="number"
      value="${value}" min="${min}" max="${max}" step="${step}" ${running ? "disabled" : ""}></label>`;
  }

  function inspector() {
    const n = scene.nodes.find(n => n.id === selected);
    const r = scene.ropes.find(r => r.id === selected);
    $("deleteItem").disabled = running || (!n && !r);
    if (r) {
      const geo = geometry(r, engine.map);
      $("inspector").innerHTML = `
        <label class="field">이름<input data-prop="name" value="${esc(r.name)}" maxlength="60" ${running ? "disabled" : ""}></label>
        ${inputField("length","줄 전체 길이 (m)",r.length,0.1,200,"0.01")}
        <p class="small">현재 경로 ${fmt(geo.length,3)} m<br>
        ${r.path.map(id => esc(scene.nodes.find(n => n.id === id).name)).join(" → ")}</p>
        <button id="autoLength" ${running ? "disabled" : ""}>현재 배치에 맞춰 자동 길이</button>`;
      $("autoLength").onclick = () => {
        r.length = geometry(r, new Map(scene.nodes.map(n => [n.id,n]))).length;
        changed();
      };
      return;
    }
    if (!n) {
      $("inspector").innerHTML = '<p class="small">장면이나 목록에서 항목을 선택하세요.</p>';
      return;
    }
    let html = `<p class="small">${TITLES[n.kind]}</p>
      <label class="field">이름<input data-prop="name" maxlength="60" value="${esc(n.name)}" ${running ? "disabled" : ""}></label>
      <div class="field-grid">
      ${inputField("x","초기 x (m)",n.x,-1000,1000,"0.01")}
      ${inputField("y","초기 y (m)",n.y,-1000,1000,"0.01")}`;
    if (DYNAMIC(n)) {
      html += inputField("m","질량 (kg)",n.m,0.05,100,"0.05");
      html += inputField("radius","접촉 반지름 (m)",n.radius,0.1,1,"0.01");
      html += inputField("mu","마찰계수 μ",n.mu,0,2,"0.01");
      html += inputField("fx","외력 x (N)",n.fx,-200,200,"0.5");
      html += inputField("fy","외력 y (N)",n.fy,-200,200,"0.5");
      html += inputField("vx","초기 속도 x (m/s)",n.vx,-30,30,"0.1");
      html += inputField("vy","초기 속도 y (m/s)",n.vy,-30,30,"0.1");
    }
    if (SURFACE(n)) {
      html += inputField("length","길이 (m)",n.length,0.5,40,"0.1");
      html += inputField("mu","마찰계수 μ",n.mu,0,2,"0.01");
      if (n.kind === "ramp")
        html += inputField("angle","경사각 (°)",n.angle,-80,80,"1");
    }
    $("inspector").innerHTML = html + "</div>";
  }

  function sceneList() {
    $("sceneList").innerHTML = [...scene.nodes, ...scene.ropes].map(n =>
      `<button data-list-id="${n.id}" class="${n.id === selected ? "chosen" : ""}">
      ${esc(TITLES[n.kind])} · ${esc(n.name)}</button>`).join("");
  }

  function metric() {
    const b = engine.map.get(selected);
    $("metricName").textContent = b?.name || "—";
    const dyn = b && DYNAMIC(b);
    $("metricV").textContent = dyn ? fmt(hypot(b.vx,b.vy)) + " m/s" : "—";
    $("metricA").textContent = dyn ? fmt(hypot(b.ax,b.ay)) + " m/s²" : "—";
    $("metricF").textContent = dyn ? fmt(b.m*hypot(b.ax,b.ay)) + " N" : "—";
    $("clock").textContent = fmt(engine.time) + " s";
  }

  function analysis() {
    const b = engine.map.get(selected);
    if (!b || !DYNAMIC(b)) {
      $("fbd").innerHTML = '<text x="210" y="165" text-anchor="middle" fill="#73866e" font-size="14">物체 또는 이동 도르래를 선택하세요.</text>'.replace("物체","물체");
      $("bodyEquations").innerHTML = "<p class='small'>줄을 선택하면 속성에서 전체 길이와 연결 경로를 볼 수 있습니다.</p>";
    } else {
      let svg = `<path d="M20 165H400M210 15V315" stroke="#dbe5d4" stroke-dasharray="4 6"/>
        <circle cx="210" cy="165" r="21" fill="#a6dfac"/>
        <text x="210" y="170" text-anchor="middle" fill="#254f31" font-size="13" font-weight="800">${esc(b.name)}</text>`;
      b.forces.forEach((f,i) =>
        svg += arrow(210+(i-1)*8,165,f.x,f.y,forceColor(f.kind),
          `${f.name} ${fmt(hypot(f.x,f.y))} N`,true));
      $("fbd").innerHTML = svg;
      const forceList = b.forces.filter(f => hypot(f.x,f.y) > 1e-7);
      const sumX = forceList.map(f => "(" + fmt(f.x) + ")").join(" + ") || "0";
      const sumY = forceList.map(f => "(" + fmt(f.y) + ")").join(" + ") || "0";
      $("bodyEquations").innerHTML = `
        <div class="equation-step"><b>1</b><p>좌표: 오른쪽 +x, 위쪽 +y<br>중력: (0, −mg) = (0, ${fmt(-b.m*scene.g)}) N</p></div>
        <div class="equation-step"><b>2</b><p>접촉과 줄 구속을 함께 계산합니다.<br>
        ${forceList.map(f => `${esc(f.name)} = (${fmt(f.x)}, ${fmt(f.y)}) N`).join("<br>")}</p></div>
        <div class="equation-step"><b>3</b><p>성분별 뉴턴 방정식<br>ΣFₓ = ${sumX}<br>ΣFᵧ = ${sumY}</p></div>
        <div class="formula">aₓ = ${fmt(b.m*b.ax)} / ${fmt(b.m)} = ${fmt(b.ax)} m/s²<br>
        aᵧ = ${fmt(b.m*b.ay)} / ${fmt(b.m)} = ${fmt(b.ay)} m/s²</div>
        <p class="small">위치 (${fmt(b.x)}, ${fmt(b.y)}) m<br>
        속도 (${fmt(b.vx)}, ${fmt(b.vy)}) m/s</p>`;
    }

    const rows = engine.rows;
    const index = rows.map((r,i) => `${i+1}: ${esc(r.label)} (${r.kind==="rope"?"장력":r.kind==="normal"?"수직항력":"마찰"})`).join("<br>");
    const numeric = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>행</th>${rows.map((_,i)=>`<th>λ${i+1}</th>`).join("")}<th>b</th><th>λ 해 (N·s)</th><th>힘 (N)</th></tr></thead><tbody>${
        rows.map((r,i)=>`<tr><th>${i+1}</th>${
          engine.matrix[i].map(v=>`<td>${fmt(v,3)}</td>`).join("")
        }<td>${fmt(engine.rhs[i],3)}</td><td>${fmt(r.impulse,5)}</td><td>${fmt(r.impulse/DT,3)}</td></tr>`).join("")
      }</tbody></table></div>`
      : "<p>현재 접촉·줄 구속이 없습니다. 각 물체에 대해 F = ma를 직접 계산합니다.</p>";
    const newton = engine.dynamic.map(n =>
      `${esc(n.name)}: ${fmt(n.m)}aₓ = ${fmt(n.fx)} + ΣF구속,x<br>`+
      `${esc(n.name)}: ${fmt(n.m)}aᵧ = ${fmt(n.fy-n.m*scene.g)} + ΣF구속,y`
    ).join("<br>");
    const ropes = scene.ropes.map(r => {
      const g = geometry(r,engine.map);
      const gradient = [...g.terms].map(([id,v]) =>
        `${esc(engine.map.get(id).name)}: J=(${fmt(v.x,3)}, ${fmt(v.y,3)})`
      ).join("; ");
      return `${esc(r.name)}: 경로 ${fmt(g.length,4)} ≤ ${fmt(r.length,4)} m<br>${gradient}`;
    }).join("<br>");

    $("systemEquations").innerHTML = `
      <h3>1. 물체별 운동 방정식</h3><div class="formula">${newton}</div>
      <h3>2. 줄의 기하학적 구속</h3><p class="small">${ropes || "줄 없음"}</p>
      <p class="small">J는 줄 경로 길이의 음의 위치 미분입니다.
      이동 도르래에서는 양쪽 구간의 방향 성분이 같은 항목에 합산됩니다.</p>
      <h3>3. 한 시간 단계의 연립계 구성</h3>
      <div class="formula">v* = v + Δt M⁻¹F외부<br>
      A = J M⁻¹ Jᵀ<br>
      b = −Jv* − gap/Δt<br>
      Aλ = b　(활성인 구속에 대해)<br>
      v다음 = v* + M⁻¹Jᵀλ</div>
      <p class="small">Δt = 1/240 s, λ는 충격량(N·s), 힘 = λ/Δt.
      줄의 gap은 설정 길이 − 현재 경로 길이, 접촉의 gap은 표면까지의 여유 거리입니다.</p>
      <h3>4. 단방향 구속과 마찰 조건</h3>
      <p class="small">장력·수직항력 λ ≥ 0. 비활성 구속은 λ=0이며 등식 대신 비침투 부등식을 만족합니다.
      마찰 충격량은 −μλN ≤ λf ≤ μλN입니다.
      이 때문에 단순 역행렬 대신 누적 충격량 투영 반복법으로 연립 부등식을 풉니다.</p>
      <p class="small">${index}</p>${numeric}
      <h3>5. 해를 힘과 가속도로 변환</h3>
      <p class="small">각 구속의 방향벡터 × λ/Δt를 물체별로 더하고 a=(v다음−v)/Δt를 계산합니다.
      반복 후 속도 구속 잔차: ${fmt(engine.residual,7)} m/s.</p>
      <p class="notice">이 표는 연속 시간의 기호식 해가 아니라 현재 시간 단계의 수치 연립계와 수치해입니다.
      충돌·줄이 팽팽해지는 순간에는 충격을 시간 간격으로 나눈 평균 힘이 표시됩니다.</p>`;
  }

  function graph() {
    const n = engine.map.get(selected);
    if (!n || !DYNAMIC(n)) {
      $("chart").innerHTML = '<text x="400" y="150" text-anchor="middle" fill="#6c826a">움직이는 항목을 선택하세요.</text>';
      $("energySummary").textContent = "";
      return;
    }
    const key = $("graphType").value;
    const start = Math.max(0,engine.time-15), end = Math.max(start+3,engine.time);
    const rows = engine.history.filter(r=>r.t>=start);
    rows.push({ t:engine.time, bodies:{ [n.id]:{
      x:n.x,y:n.y,vx:n.vx,vy:n.vy,ax:n.ax,ay:n.ay,
      speed:hypot(n.vx,n.vy),
      energy:.5*n.m*(n.vx*n.vx+n.vy*n.vy)+n.m*scene.g*n.y
    }}});
    const values = rows.map(r=>r.bodies[n.id]?.[key]).filter(Number.isFinite);
    let lo=Math.min(0,...values), hi=Math.max(0,...values);
    const pad=Math.max(.5,(hi-lo)*.12);lo-=pad;hi+=pad;
    const X=t=>65+(t-start)/(end-start)*700;
    const Y=v=>255-(v-lo)/(hi-lo)*220;
    let s="";
    for(let i=0;i<=4;i++){
      const v=lo+(hi-lo)*i/4,y=Y(v),t=start+(end-start)*i/4;
      s+=`<path d="M65 ${y}H765" stroke="#dce5d5"/>
        <text x="56" y="${y+4}" text-anchor="end" font-size="11" fill="#72846a">${fmt(v,1)}</text>
        <text x="${X(t)}" y="280" text-anchor="middle" font-size="11" fill="#72846a">${fmt(t,1)}</text>`;
    }
    const path=rows.map((r,i)=>{
      const v=r.bodies[n.id]?.[key];
      return Number.isFinite(v)?(i?"L":"M")+X(r.t)+" "+Y(v):"";
    }).join(" ");
    s+=`<path d="${path}" fill="none" stroke="#208459" stroke-width="2.5"/>
      <text x="778" y="281" font-size="12" fill="#72846a">s</text>`;
    $("chart").innerHTML=s;
    const K=engine.dynamic.reduce((v,b)=>v+.5*b.m*(b.vx*b.vx+b.vy*b.vy),0);
    const U=engine.dynamic.reduce((v,b)=>v+b.m*scene.g*b.y,0);
    $("energySummary").innerHTML=`<div class="formula">계 전체 K = ${fmt(K)} J<br>
      U = ${fmt(U)} J<br>K + U = ${fmt(K+U)} J</div>
      <p class="small">위치에너지 기준은 세계 좌표 y=0입니다.
      외력·마찰·비탄성 충돌·줄의 충격 때문에 역학적 에너지가 바뀔 수 있습니다.
      수치 적분 오차도 존재합니다.</p>`;
  }

  function render(full=false){
    draw();metric();
    if(uiDirty||full){
      inspector();sceneList();
      $("gravity").value=scene.g;
      $("gravity").disabled=running;
      $("loadExample").disabled=running;
      $("openJSON").disabled=running;
      $("loadLocal").disabled=running;
      uiDirty=false;
    }
    if(activeTab==="analysis")analysis();
    if(activeTab==="graphs")graph();
  }

  function setTool(value){
    if(running && !["select","pan"].includes(value)){
      message("배치와 연결은 일시정지 또는 초기화 후 변경할 수 있습니다.",true);
      return;
    }
    tool=value;
    if(value!=="rope")route=[];
    document.querySelectorAll("[data-tool]").forEach(b=>{
      const on=b.dataset.tool===value;
      b.classList.toggle("active",on);
      b.setAttribute("aria-pressed",String(on));
    });
    $("ropeActions").hidden=value!=="rope";
    $("routeText").textContent=route.map(id=>scene.nodes.find(n=>n.id===id)?.name).join(" → ")||"연결점을 순서대로 선택하세요.";
    $("toolHint").textContent={
      select:"항목을 눌러 선택하고 드래그하세요. 정확한 위치와 조건은 오른쪽 속성에서 입력합니다.",
      body:"작업 공간을 누르면 물체가 추가됩니다.",
      platform:"작업 공간을 누르면 고정된 수평 발판이 추가됩니다.",
      ramp:"작업 공간을 누르면 경사면이 추가됩니다. 각도는 속성에서 변경합니다.",
      fixed:"작업 공간을 누르면 고정 도르래가 추가됩니다.",
      moving:"작업 공간을 누르면 질량을 가진 이동 도르래가 추가됩니다.",
      anchor:"작업 공간을 누르면 줄을 묶는 고정점이 추가됩니다.",
      rope:"시작점 → 중간 도르래 → 끝점 순서로 누르세요. 마지막에 줄 완성을 누릅니다.",
      pan:"빈 공간을 드래그해 화면을 이동합니다."
    }[value];
    draw();
  }

  document.querySelectorAll("[data-tool]").forEach(b=>b.onclick=()=>setTool(b.dataset.tool));

  $("workspace").addEventListener("pointerdown",e=>{
    if(e.button!==0 && e.pointerType==="mouse")return;
    e.preventDefault();
    const p=unproject(e.clientX,e.clientY);
    const target=e.target.closest("[data-id]");
    const id=target?.dataset.id;
    if(tool==="pan"){
      drag={kind:"pan",clientX:e.clientX,clientY:e.clientY,view:{...view}};
      $("workspace").setPointerCapture(e.pointerId);return;
    }
    if(tool==="rope"){
      if(running)return;
      const n=scene.nodes.find(n=>n.id===id);
      if(!n || SURFACE(n)){
        message("물체·도르래·고정점을 선택하세요. 발판에는 연결할 수 없습니다.",true);return;
      }
      if(route.includes(id)){message("같은 연결점을 반복할 수 없습니다.",true);return;}
      route.push(id);setTool("rope");return;
    }
    if(!["select","pan","rope"].includes(tool)){
      if(running)return;
      if(scene.nodes.length>=40){message("항목은 최대 40개입니다.",true);return;}
      const n=node(tool,p.x,p.y,{name:TITLES[tool]+" "+(scene.nodes.filter(n=>n.kind===tool).length+1)});
      scene.nodes.push(n);selected=n.id;changed();setTool("select");return;
    }
    if(id){
      selected=id;uiDirty=true;
      const n=scene.nodes.find(n=>n.id===id);
      if(n && !running){
        // 배치 편집은 초기 상태에서 진행한다.
        if(engine.time>0)reset();
        drag={kind:"node",id,start:p,x:n.x,y:n.y,moved:false};
        $("workspace").setPointerCapture(e.pointerId);
      }
      render(true);
    }
  });

  $("workspace").addEventListener("pointermove",e=>{
    if(!drag)return;
    if(drag.kind==="pan"){
      const rect=$("workspace").getBoundingClientRect();
      view.x=drag.view.x-(e.clientX-drag.clientX)/rect.width*drag.view.w;
      view.y=drag.view.y+(e.clientY-drag.clientY)/rect.height*drag.view.h;
      draw();return;
    }
    const p=unproject(e.clientX,e.clientY);
    const n=scene.nodes.find(n=>n.id===drag.id);
    n.x=Math.round(clamp(drag.x+p.x-drag.start.x,-1000,1000)*100)/100;
    n.y=Math.round(clamp(drag.y+p.y-drag.start.y,-1000,1000)*100)/100;
    const live=engine.map.get(n.id);live.x=n.x;live.y=n.y;
    drag.moved=true;draw();
  });

  function endDrag(e){
    if(!drag)return;
    const moved=drag.kind==="node"&&drag.moved;
    drag=null;
    if($("workspace").hasPointerCapture(e.pointerId))
      $("workspace").releasePointerCapture(e.pointerId);
    if(moved)changed();
  }
  $("workspace").addEventListener("pointerup",endDrag);
  $("workspace").addEventListener("pointercancel",endDrag);

  $("finishRope").onclick=()=>{
    if(route.length<2){message("줄의 시작과 끝을 선택하세요.",true);return;}
    const r=rope(scene.nodes,route.slice());
    r.name="줄 "+(scene.ropes.length+1);
    const candidate=copy(scene);candidate.ropes.push(r);
    const errors=validate(candidate);
    if(errors.length){message(errors.join("\n"),true);return;}
    scene.ropes.push(r);selected=r.id;route=[];setTool("select");changed();
  };
  $("cancelRope").onclick=()=>{route=[];setTool("select");};

  $("inspector").addEventListener("change",e=>{
    const key=e.target.dataset.prop;
    if(!key||running)return;
    const n=scene.nodes.find(n=>n.id===selected)||scene.ropes.find(r=>r.id===selected);
    if(!n)return;
    const old=n[key];
    if(key==="name"){
      n.name=e.target.value.trim().slice(0,60)||TITLES[n.kind];
    }else{
      if(!e.target.checkValidity()||e.target.value===""){
        e.target.value=old;message("입력 범위를 확인하세요.",true);return;
      }
      n[key]=Number(e.target.value);
    }
    changed();
  });

  $("sceneList").onclick=e=>{
    const b=e.target.closest("[data-list-id]");
    if(b){selected=b.dataset.listId;uiDirty=true;render(true);}
  };

  function removeSelected(){
    if(running)return;
    const n=scene.nodes.find(n=>n.id===selected);
    if(n){
      scene.nodes=scene.nodes.filter(q=>q.id!==selected);
      scene.ropes=scene.ropes.filter(r=>!r.path.includes(selected));
    }else scene.ropes=scene.ropes.filter(r=>r.id!==selected);
    selected=scene.nodes.find(DYNAMIC)?.id||scene.nodes[0]?.id||null;
    route=[];changed();
  }
  $("deleteItem").onclick=removeSelected;
  document.addEventListener("keydown",e=>{
    if(["INPUT","SELECT","TEXTAREA"].includes(e.target.tagName))return;
    if(e.key==="Delete"){e.preventDefault();removeSelected();}
    if(e.key==="Escape"){drag=null;route=[];setTool("select");}
  });

  $("gravity").onchange=e=>{
    if(!e.target.checkValidity()||e.target.value===""){
      e.target.value=scene.g;return;
    }
    scene.g=Number(e.target.value);changed();
  };

  $("play").onclick=start;
  $("reset").onclick=()=>reset(true);
  $("step").onclick=()=>{
    pause();
    const errors=validate(scene);
    if(errors.length){message(errors.join("\n"),true);return;}
    if(finished)reset();
    for(let i=0;i<12;i++){
      integrate(engine);
      if(!checkRuntime())break;
    }
    $("status").textContent="한 단계 진행";
    render(true);
  };
  ["showForces","showVelocity","showTrails"].forEach(id=>$(id).onchange=()=>render());

  $("fit").onclick=()=>{fitView();draw();};
  function zoom(factor){
    const cx=view.x+view.w/2,cy=view.y+view.h/2;
    const w=clamp(view.w*factor,4,3000),h=w/1.6;
    view={x:cx-w/2,y:cy-h/2,w,h};draw();
  }
  $("zoomIn").onclick=()=>zoom(.8);
  $("zoomOut").onclick=()=>zoom(1.25);
  $("workspace").addEventListener("wheel",e=>{
    if(!e.ctrlKey)return;
    e.preventDefault();zoom(e.deltaY>0?1.08:.92);
  },{passive:false});

  function loadScene(s){
    const errors=validate(s);
    if(errors.length){message(errors.join("\n"),true);return false;}
    scene=copy(s);selected=scene.nodes.find(DYNAMIC)?.id||null;
    route=[];reset();fitView();setTool("select");render(true);
    message("실험을 불러왔습니다.");
    return true;
  }
  $("loadExample").onclick=()=>loadScene(example($("example").value));

  function download(name,content,type){
    const url=URL.createObjectURL(new Blob([content],{type}));
    const a=document.createElement("a");a.href=url;a.download=name;
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  $("saveJSON").onclick=()=>download("physics-experiment.json",JSON.stringify(scene,null,2),"application/json");
  $("openJSON").onclick=()=>{$("fileInput").value="";$("fileInput").click();};
  $("fileInput").onchange=async e=>{
    const f=e.target.files[0];if(!f)return;
    if(f.size>250000){message("실험 파일은 250 KB 이하여야 합니다.",true);return;}
    try{loadScene(JSON.parse(await f.text()));}
    catch{message("JSON 파일을 읽을 수 없습니다.",true);}
  };
  $("saveLocal").onclick=()=>{
    try{localStorage.setItem("physics-free-v1",JSON.stringify(scene));message("이 브라우저에 실험을 저장했습니다.");}
    catch{message("브라우저가 저장소 사용을 허용하지 않습니다. JSON 저장을 이용하세요.",true);}
  };
  $("loadLocal").onclick=()=>{
    try{
      const s=JSON.parse(localStorage.getItem("physics-free-v1"));
      if(!s)throw Error();
      loadScene(s);
    }catch{message("불러올 수 있는 브라우저 저장 실험이 없습니다.",true);}
  };
  $("csv").onclick=()=>{
    const fields=["x","y","vx","vy","ax","ay","energy"];
    const labels=["x(m)","y(m)","vx(m/s)","vy(m/s)","ax(m/s²)","ay(m/s²)","E(J)"];
    const quote=v=>'"'+String(v).replace(/"/g,'""')+'"';
    let csv="\uFEFF"+["시간(s)",...engine.dynamic.flatMap(n=>labels.map(k=>n.name+" "+k))].map(quote).join(",")+"\r\n";
    csv+=engine.history.map(r=>[
      r.t.toFixed(5),
      ...engine.dynamic.flatMap(n=>fields.map(k=>r.bodies[n.id][k].toFixed(6)))
    ].join(",")).join("\r\n");
    download("physics-measurements.csv",csv,"text/csv;charset=utf-8");
  };

  function switchTab(id){
    activeTab=id;
    document.querySelectorAll("[data-tab]").forEach(b=>{
      const on=b.dataset.tab===id;
      b.classList.toggle("active",on);b.setAttribute("aria-selected",String(on));
      b.tabIndex=on?0:-1;
    });
    document.querySelectorAll(".tab-content").forEach(p=>p.hidden=p.id!==id);
    render();
  }
  document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  document.querySelector(".tabs").addEventListener("keydown",e=>{
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(e.key))return;
    e.preventDefault();
    const tabs=[...document.querySelectorAll("[data-tab]")];
    let i=tabs.findIndex(t=>t.dataset.tab===activeTab);
    i=e.key==="Home"?0:e.key==="End"?tabs.length-1:
      (i+(e.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
    switchTab(tabs[i].dataset.tab);tabs[i].focus();
  });
  $("graphType").onchange=graph;
  $("helpButton").onclick=()=>$("help").showModal();
  $("closeHelp").onclick=()=>$("help").close();

  const questions=[
    {q:"알짜힘이 0인 물체의 운동으로 가능한 것은?",
      options:["반드시 정지","등속 직선 운동","반드시 가속","반드시 원운동"],
      answer:1,why:"ΣF=ma에서 가속도는 0입니다. 정지 또는 등속 직선 운동이 가능합니다."},
    {q:"정지 마찰력에 관한 설명으로 옳은 것은?",
      options:["항상 μN","항상 0","필요한 만큼 작용하되 최대 μN","운동 방향으로만 작용"],
      answer:2,why:"정지 마찰력은 접선 방향의 미끄러짐을 막는 데 필요한 만큼 작용합니다."},
    {q:"이상적인 이동 도르래를 위쪽으로 당기는 두 줄이 수직이고 각 장력이 T라면, 줄의 합력은?",
      options:["T/2","T","2T","0"],
      answer:2,why:"두 장력이 같은 위쪽 방향이므로 벡터 합이 2T입니다. 줄이 기울면 방향 성분을 더해야 합니다."},
    {q:"줄이 느슨해졌을 때 줄이 전달하는 힘은?",
      options:["미는 힘","항상 mg","항상 2mg","0"],
      answer:3,why:"이상적인 줄은 당기는 힘만 전달하며 느슨해지면 장력이 0입니다."},
    {q:"공기 저항 없는 포물선 운동에서 수평 외력이 없다면?",
      options:["vx가 일정하다","vy가 일정하다","가속도가 0이다","속력이 항상 일정하다"],
      answer:0,why:"수평 알짜힘이 0이므로 ax=0, vx는 일정합니다. 수직으로는 ay=−g입니다."},
    {q:"질량 2 kg의 물체에 알짜힘 (6, 8) N이 작용할 때 가속도 크기는?",
      options:["2 m/s²","5 m/s²","7 m/s²","10 m/s²"],
      answer:1,why:"알짜힘 크기는 √(6²+8²)=10 N입니다. 가속도 크기는 10/2=5 m/s²입니다."},
    {q:"이 앱에서 충돌 직후 역학적 에너지가 감소할 수 있는 이유는?",
      options:["항상 에너지 보존 법칙이 틀려서","반발계수 0의 비탄성 충돌을 사용해서","중력이 없어서","질량이 변해서"],
      answer:1,why:"비탄성 충돌에서는 일부 역학적 에너지가 내부 에너지 등으로 전환됩니다. 전체 에너지 보존과 모순되지 않습니다."}
  ];
  let qi=0,choice=-1,submitted=false;
  const scores=new Set();
  function quiz(){
    const q=questions[qi];
    $("quizProgress").textContent=`QUESTION ${qi+1}/${questions.length} · 맞힌 문제 ${scores.size}`;
    $("quizQuestion").textContent=q.q;
    $("quizChoices").innerHTML=q.options.map((o,i)=>`<button data-choice="${i}"
      class="quiz-choice ${choice===i?"selected":""}" aria-pressed="${choice===i}"
      ${submitted?"disabled":""}>${"①②③④"[i]} ${esc(o)}</button>`).join("");
    $("quizSubmit").disabled=submitted||choice<0;
    $("quizFeedback").hidden=!submitted;
    if(submitted)$("quizFeedback").textContent=
      (choice===q.answer?"정답입니다. ":"정답은 "+"①②③④"[q.answer]+"입니다. ")+q.why;
  }
  $("quizChoices").onclick=e=>{
    const b=e.target.closest("[data-choice]");
    if(b&&!submitted){choice=+b.dataset.choice;quiz();}
  };
  $("quizSubmit").onclick=()=>{
    if(choice<0||submitted)return;
    submitted=true;if(choice===questions[qi].answer)scores.add(qi);quiz();
  };
  $("quizNext").onclick=()=>{
    qi=(qi+1)%questions.length;choice=-1;submitted=false;quiz();
  };

  function runChecks(){
    const results=[];
    function near(a,b,tol=1e-4){
      if(!Number.isFinite(a)||Math.abs(a-b)>tol)
        throw Error(fmt(a,6)+" ≠ "+fmt(b,6));
    }
    function assert(condition,text){if(!condition)throw Error(text);}
    function test(name,fn){
      try{fn();results.push({ok:true,text:"✓ "+name});}
      catch(e){results.push({ok:false,text:"✕ "+name+" — "+e.message});}
    }
    const empty=()=>({version:1,g:9.8,nodes:[],ropes:[]});

    test("초기 장면: 물체·발판·줄 자동 생성",()=>{
      const s=example();
      assert(s.nodes.filter(DYNAMIC).length===2,"초기 물체 수 오류");
      assert(s.nodes.some(SURFACE),"발판 없음");
      assert(s.ropes.length===1,"줄 없음");
      assert(validate(s).length===0,validate(s).join("; "));
    });
    test("초기 장면: 기본 화면 안에 물체가 있음",()=>{
      const s=example();
      assert(s.nodes.filter(DYNAMIC).every(n=>n.x>0&&n.x<16&&n.y>0&&n.y<10),
        "화면 밖 초기 물체");
    });
    test("초기화: 위치·초기 속도·시간 복원",()=>{
      const s=example("projectile"),a=createEngine(s);
      for(let i=0;i<20;i++)integrate(a);
      const b=createEngine(s),p=b.dynamic[0],original=s.nodes.find(DYNAMIC);
      near(b.time,0);near(p.x,original.x);near(p.y,original.y);
      near(p.vx,original.vx);near(p.vy,original.vy);
    });
    test("자유낙하: ay=−g",()=>{
      const s=empty();s.nodes=[node("body",0,8)];
      const e=createEngine(s);integrate(e);
      near(e.dynamic[0].ay,-9.8);
    });
    test("포물선: vx 일정, vy=vy₀−gt",()=>{
      const s=empty();s.nodes=[node("body",0,10,{vx:3,vy:5})];
      const e=createEngine(s);
      for(let i=0;i<120;i++)integrate(e);
      near(e.dynamic[0].vx,3);near(e.dynamic[0].vy,.1,1e-5);
    });
    test("수평면: 수직항력 mg",()=>{
      const s=empty();
      s.nodes=[node("platform",0,0,{length:10,mu:0}),
        node("body",0,.35,{mu:0})];
      const e=createEngine(s);integrate(e);
      const b=e.dynamic[0];
      near(b.ay,0);
      near(b.forces.filter(f=>f.kind==="normal").reduce((a,f)=>a+f.y,0),19.6);
    });
    test("정지 마찰: 외력 3 N을 상쇄",()=>{
      const s=empty();
      s.nodes=[node("platform",0,0,{length:10,mu:.3}),
        node("body",0,.35,{mu:.3,fx:3})];
      const e=createEngine(s);integrate(e);
      near(e.dynamic[0].vx,0);
      near(e.dynamic[0].forces.filter(f=>f.kind==="friction").reduce((a,f)=>a+f.x,0),-3);
    });
    test("경사면: 마찰 없을 때 접선 가속도 −g sinθ",()=>{
      const s=empty(),a=Math.PI/6;
      s.nodes=[node("ramp",0,0,{length:10,angle:30,mu:0}),
        node("body",-Math.sin(a)*.35,Math.cos(a)*.35,{mu:0})];
      const e=createEngine(s);integrate(e);
      const b=e.dynamic[0];
      near(b.ax*Math.cos(a)+b.ay*Math.sin(a),-4.9);
    });
    test("수평 연결: 전체 질량에 따른 가속도와 장력",()=>{
      const s=example("train"),e=createEngine(s);integrate(e);
      near(e.dynamic[0].ax,2.4);near(e.dynamic[1].ax,2.4);
      near(e.rows.find(r=>r.kind==="rope").impulse/DT,4.8);
    });
    test("고정 도르래: Atwood 가속도·장력",()=>{
      const s=example("atwood"),e=createEngine(s);integrate(e);
      near(e.dynamic[0].ay,1.96);near(e.dynamic[1].ay,-1.96);
      near(e.rows.find(r=>r.kind==="rope").impulse/DT,23.52);
    });
    test("이동 도르래: 2:1 구속·질량 포함",()=>{
      const s=example("moving"),e=createEngine(s);integrate(e);
      const p=e.dynamic.find(n=>n.kind==="moving");
      const b=e.dynamic.find(n=>n.kind==="body");
      near(p.ay,-2.45);near(b.ay,4.9);near(2*p.ay+b.ay,0);
      near(e.rows.find(r=>r.kind==="rope").impulse/DT,14.7);
    });
    test("느슨한 줄: 장력 0",()=>{
      const s=example("train");s.ropes[0].length+=2;
      const e=createEngine(s);integrate(e);
      near(e.rows.find(r=>r.kind==="rope").impulse,0);
    });
    test("줄은 압축력을 전달하지 않음",()=>{
      const s=example("train");
      const bodies=s.nodes.filter(DYNAMIC);
      bodies[0].fx=12;bodies[1].fx=0;
      const e=createEngine(s);integrate(e);
      near(e.rows.find(r=>r.kind==="rope").impulse,0);
    });
    test("물체 충돌: 동일 질량·비탄성 속도",()=>{
      const s=empty();s.g=0;
      s.nodes=[node("body",0,2,{vx:1,mu:0}),
        node("body",.7,2,{vx:0,mu:0})];
      const e=createEngine(s);integrate(e);
      near(e.dynamic[0].vx,.5);near(e.dynamic[1].vx,.5);
    });
    test("잘못된 연결: 중간 물체 경로 차단",()=>{
      const s=empty();
      s.nodes=[node("body",0,1),node("body",2,1),node("body",4,1)];
      s.ropes=[rope(s.nodes,s.nodes.map(n=>n.id))];
      assert(validate(s).some(t=>t.includes("중간")),"지원하지 않는 경로를 허용함");
    });
    test("중복 줄 구속 차단",()=>{
      const s=example("train"),r=copy(s.ropes[0]);r.id=uid();s.ropes.push(r);
      assert(validate(s).length>0,"중복 구속을 허용함");
    });
    test("JSON 저장·복원 구조",()=>{
      const s=example("moving"),restored=JSON.parse(JSON.stringify(s));
      assert(validate(restored).length===0,"복원 검증 실패");
      near(restored.ropes[0].length,s.ropes[0].length);
    });
    test("실행 화면: SVG와 초기 물체 요소 존재",()=>{
      assert($("workspace") instanceof SVGElement,"SVG 없음");
      assert($("workspace").querySelector("[data-id]"),"그려진 장면 항목 없음");
      assert($("workspace").getBoundingClientRect().width>0,"작업 공간 너비 0");
    });

    const passed=results.filter(r=>r.ok).length;
    $("checkResults").textContent=`${passed}/${results.length} 검증 통과\n\n`+
      results.map(r=>r.text).join("\n")+
      "\n\n이 검증은 실제 터치 기기 조작·모든 배치·장시간 수치 안정성의 전체 검증을 대신하지 않습니다.";
  }
  $("runChecks").onclick=runChecks;

  function frame(now){
    if(running){
      if(lastTime){
        accumulated+=Math.min((now-lastTime)/1000,.05)*Number($("speed").value);
        while(accumulated>=DT&&running){
          integrate(engine);accumulated-=DT;
          if(!checkRuntime())break;
        }
      }
      lastTime=now;
      if(now-renderAt>33){
        draw();metric();renderAt=now;
      }
      if(now-learningAt>160){
        if(activeTab==="analysis")analysis();
        if(activeTab==="graphs")graph();
        learningAt=now;
      }
      if(uiDirty){inspector();sceneList();uiDirty=false;}
    }else lastTime=0;
    requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange",()=>{
    if(document.hidden&&running){
      pause("탭을 벗어나 자동 일시정지");render(true);
    }
  });

  reset();
  fitView();
  setTool("select");
  switchTab("analysis");
  quiz();
  render(true);
  message("초기 실험이 준비되었습니다. 도구로 항목을 추가하거나 예제에서 시작하세요.");
  requestAnimationFrame(frame);
})();
