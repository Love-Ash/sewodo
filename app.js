"use strict";
(() => {
  const R = window.RULES;
  const DEMO_SPOTS = [
    { name: "독산로 시흥1동우체국 앞", lat: 37.458402, lng: 126.905222 },
    { name: "가산초등학교 옆 길", lat: 37.4784095, lng: 126.8958144 },
    { name: "금하로1길 주택가", lat: 37.45277, lng: 126.89181 }
  ];
  const SNAP_M = 15;          // 이 거리 안이면 그 구간 위에 있다고 본다
  const CHILD_NEAR_M = 300;   // 보호구역 지정 범위(주출입문 반경)
  // 이보다 가까우면 판정 문구를 바꾼다. 학교는 정문 앞 도로가 보호구역인 경우가 많고, 어린이집은 촘촘해서 좁게 잡는다.
  const childCloseM = (kind) => (/초등학교|특수학교/.test(kind) ? 80 : 40);
  const STORE_KEY = "sewodo-park-v1";

  const $ = (id) => document.getElementById(id);
  const state = {
    segments: [], zones: [], point: null, source: null, accuracy: null,
    timeOverride: null, dayOverride: "auto", fast: false, watchId: null,
    lastVerdict: null, confirmRoad: null
  };

  // ---------- 시간 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const fmtMin = (m) => `${pad(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${pad(((m % 60) + 60) % 60)}`;
  const fmtDur = (min) => {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
  };
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

  function now() {
    const d = new Date();
    if (state.timeOverride !== null) { d.setHours(Math.floor(state.timeOverride / 60), state.timeOverride % 60, 0, 0); }
    return d;
  }
  function dayType(d) {
    if (state.dayOverride !== "auto") return state.dayOverride;
    if (d.getDay() === 0 || R.holidays.includes(ymd(d))) return "hol";
    if (d.getDay() === 6) return "sat";
    return "weekday";
  }
  const DAY_LABEL = { weekday: "평일", sat: "토요일", hol: "일요일·공휴일" };

  // 표준데이터 시각 쌍 해석: 00:00~00:00 금지 없음, 00:00~23:59 종일 금지, 그 밖은 구간(자정 넘김 허용)
  function banWindow(pair) {
    const [s, e] = pair.map((v) => (v || "").trim());
    if (!s || !e || (s === "00:00" && e === "00:00")) return { kind: "none" };
    if (s === "00:00" && e === "23:59") return { kind: "all", s: 0, e: 1440 };
    return { kind: "range", s: toMin(s), e: toMin(e) };
  }
  function inRange(m, s, e) { return s <= e ? (m >= s && m < e) : (m >= s || m < e); }
  function allowWindows(pair) {
    const [s, e] = pair.map((v) => (v || "").trim());
    if (!s || !e) return [];
    const ss = s.split("+"), ee = e.split("+");
    return ss.map((x, i) => ee[i] ? { s: toMin(x.trim()), e: toMin(ee[i].trim()) } : null).filter(Boolean);
  }
  function segRuleFor(seg, dt) {
    const key = dt === "weekday" ? "wd" : dt;
    return { ban: banWindow(seg[key]), allows: allowWindows(seg[key + "_allow"] || ["", ""]), dt };
  }
  // 지금 금지 중인가, 상태가 바뀌는 다음 시각까지 몇 분인가
  function segStatus(seg, d) {
    const dt = dayType(d);
    const rule = segRuleFor(seg, dt);
    const m = d.getHours() * 60 + d.getMinutes();
    if (rule.ban.kind === "none") return { banned: false, rule, untilMin: minutesToMidnight(m), changeAt: null };
    if (rule.ban.kind === "all") return { banned: true, rule, untilMin: minutesToMidnight(m), changeAt: null, allDay: true };
    const inBan = inRange(m, rule.ban.s, rule.ban.e);
    const allowNow = inBan && rule.allows.find((w) => inRange(m, w.s, w.e) && inRange(w.s, rule.ban.s, rule.ban.e));
    if (inBan && !allowNow) {
      const nextAllow = rule.allows.filter((w) => inRange(w.s, rule.ban.s, rule.ban.e)).map((w) => (w.s - m + 1440) % 1440).filter((x) => x > 0);
      const toEnd = (rule.ban.e - m + 1440) % 1440;
      const until = Math.min(toEnd, ...nextAllow);
      return { banned: true, rule, untilMin: until, changeAt: fmtMin(m + until) };
    }
    const end = allowNow ? (allowNow.e - m + 1440) % 1440 : (rule.ban.s - m + 1440) % 1440;
    return { banned: false, rule, untilMin: end, changeAt: fmtMin(m + end), allowWindow: !!allowNow };
  }
  function minutesToMidnight(m) { return 1440 - m; }

  // ---------- 거리 ----------
  function meters(a, b) {
    const lat = (a[0] + b[0]) / 2 * Math.PI / 180;
    return Math.hypot((b[1] - a[1]) * 111320 * Math.cos(lat), (b[0] - a[0]) * 110540);
  }
  function distToSeg(p, a, b) {
    const lat = a[0] * Math.PI / 180;
    const bx = (b[1] - a[1]) * 111320 * Math.cos(lat), by = (b[0] - a[0]) * 110540;
    const px = (p[1] - a[1]) * 111320 * Math.cos(lat), py = (p[0] - a[0]) * 110540;
    const L2 = bx * bx + by * by;
    const t = L2 ? Math.max(0, Math.min(1, (px * bx + py * by) / L2)) : 0;
    return Math.hypot(px - t * bx, py - t * by);
  }
  function distToLine(p, coords) {
    let d = Infinity;
    for (let i = 0; i < coords.length - 1; i++) d = Math.min(d, distToSeg(p, coords[i], coords[i + 1]));
    return d;
  }
  function inCoverage(p) {
    const [s, w, n, e] = R.coverage.bbox;
    return p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
  }

  // ---------- 판정 ----------
  function evaluate(p, acc, d) {
    const covered = inCoverage(p);
    const segs = state.segments.map((s) => ({ s, d: distToLine(p, s.coords) })).sort((a, b) => a.d - b.d);
    const near = segs[0];
    const zone = state.zones.reduce((best, z) => {
      const dz = meters(p, [z[0], z[1]]);
      return dz < best.d ? { z, d: dz } : best;
    }, { z: null, d: Infinity });
    const fuzz = Math.min(Math.max(acc || 0, 0), 60);
    const out = { level: "unknown", headline: "", sub: "", facts: [], ask: null, deadline: null, deadlineLabel: "", sources: [], segment: null, zone, covered };

    // 1) 지정 금지 구간
    let onSeg = null, maybeSeg = null;
    if (near && covered) {
      if (near.d <= SNAP_M || (state.confirmRoad === near.s.id)) onSeg = near;
      else if (near.d <= SNAP_M + fuzz && state.confirmRoad !== `no:${near.s.id}`) maybeSeg = near;
    }

    if (onSeg) {
      const seg = onSeg.s, st = segStatus(seg, d);
      out.segment = seg;
      const banText = describeBan(st.rule);
      const isCity = /시흥대로/.test(seg.road) && !/시흥대로\d+길/.test(seg.road);
      const notice = R.notices[0];
      const grace = isCity ? notice.extracted.cctv_seoul_city.confirm_after_min : notice.extracted.cctv_fixed.confirm_after_min;
      if (st.banned) {
        out.level = "stop";
        out.headline = st.allDay ? "오늘은 종일 주정차 금지" : "지금은 주정차 금지";
        out.sub = st.changeAt ? `${banText} · ${st.changeAt}부터 세울 수 있어요 (${fmtDur(st.untilMin)} 뒤)` : banText;
        out.facts.push({ c: "stop", t: `${seg.road} 지정 금지구간(${seg.desc}). ${R.standard.typeCode[seg.type] || "유형 미상"}.` });
        out.facts.push({ c: "caution", t: `구청 고정 CCTV는 첫 촬영 후 ${grace}분이 지나면 단속이 확정됩니다${isCity ? "(시흥대로는 서울시 CCTV 기준)" : ""}. 허용 시간이 아니라 단속 기준입니다.` });
        if (seg.type !== "2") out.facts.push({ c: "caution", t: "절대 구간이 섞인 곳이라 교차로·횡단보도 근처 지점은 유예 없이 바로 단속됩니다." });
        const m = d.getHours() * 60 + d.getMinutes();
        const lunch = notice.extracted.patrol.grace[0];
        if (st.rule.dt === "weekday" && inRange(m, toMin(lunch[0]), toMin(lunch[1]))) {
          out.facts.push({ c: "info", t: `구청 공지에 평일 점심 ${lunch[0]}~${lunch[1]} 순회단속 유예가 있지만, 어느 구간에 적용되는지 확인되지 않아 판정에는 넣지 않았어요.` });
        }
        out.deadline = grace; out.deadlineLabel = `확정 단속(${grace}분 기준)`;
      } else {
        out.level = "go";
        out.headline = "지금은 세워도 돼요";
        out.sub = st.changeAt ? `${st.changeAt}까지 · ${fmtDur(st.untilMin)} 남았어요` : `오늘(${DAY_LABEL[st.rule.dt]})은 이 구간 금지 시간이 없어요`;
        out.facts.push({ c: "go", t: `${seg.road} 지정 금지구간(${seg.desc})이지만 지금은 금지 시간이 아닙니다. ${banText}.` });
        if (st.changeAt) { out.deadline = st.untilMin; out.deadlineLabel = `${st.changeAt} 금지 시작`; }
      }
      out.sources.push(segSource(seg));
      out.sources.push(noticeSource(notice));
    } else if (maybeSeg) {
      const seg = maybeSeg.s;
      out.level = "caution";
      out.headline = "이 길이 맞는지 한 번만 확인해 주세요";
      out.sub = `위치 오차(약 ${Math.round(acc || 0)}m) 안에 ${seg.road} 금지구간이 걸려 있어요.`;
      out.ask = { id: seg.id, road: seg.road };
      out.sources.push(segSource(seg));
    } else if (covered) {
      out.level = "go";
      out.headline = "지정 금지구간은 아니에요";
      out.sub = "교차로·횡단보도·버스정류소·소화전 주변과 보도만 피하면 됩니다.";
      out.facts.push({ c: "info", t: `가장 가까운 지정 금지구간은 ${near ? `${near.s.road} (${Math.round(near.d)}m)` : "없음"}입니다.` });
      out.sources.push({ title: R.standard.name, meta: `금천구 ${R.coverage.totalRows}개 구간 중 ${R.coverage.mappedRows}개 지도화 · 지도화 안 된 구간이 근처에 있을 수 있음`, url: R.standard.url });
    } else {
      out.level = "unknown";
      out.headline = "이 지역 금지구간은 아직 준비 중이에요";
      out.sub = "시연판은 서울 금천구 지정 금지구간을 판정합니다. 어린이보호구역과 법정 금지 장소는 전국에서 확인합니다.";
    }

    // 2) 어린이보호구역(전국 데이터)
    if (zone.z && zone.d <= CHILD_NEAR_M) {
      const [lat, lng, name, kind] = zone.z;
      const close = zone.d <= childCloseM(kind);
      out.facts[onSeg ? "push" : "unshift"]({ c: close ? "stop" : "caution", t: `${name}(${kind})에서 ${Math.round(zone.d)}m. 주출입문 300m 안의 지정 구간은 어린이보호구역이라 정차도 금지예요. 노란 노면이나 표지가 보이면 바로 옮기세요. ${R.law.childZone.fine}.` });
      if (close && out.level !== "stop" && !onSeg) {
        out.level = "caution";
        out.headline = "어린이보호구역일 가능성이 높아요";
        out.sub = "보호구역 안에서는 5분 정차도 금지입니다. 표지와 노면을 먼저 보세요.";
        out.deadline = null; out.deadlineLabel = "";
      }
      out.sources.push({ title: "전국어린이보호구역표준데이터", meta: `${name} · 좌표는 시설 위치(보호구역 경계는 아님)`, url: "https://www.data.go.kr/data/15012891/standard.do" });
      out.sources.push({ title: R.law.childZone.source, meta: `${R.law.childZone.rule}. ${R.law.childZone.scope} (${R.law.childZone.scopeSource})` });
    }

    // 3) 법정 금지 장소(항상)
    if (out.level === "go" || out.level === "unknown") {
      out.facts.push({ c: "info", t: "어디서든 금지: 교차로·횡단보도·보도, 모퉁이 5m, 버스정류소 10m, 소화전 5m 이내." });
      out.sources.push({ title: "도로교통법 제32조", meta: R.law.absolute.map((a) => a.place).join(" / ") });
    }
    if (!out.deadline && out.level !== "stop" && !(out.level === "caution" && zone.z && zone.d <= childCloseM(zone.z[3]))) {
      out.deadline = 5; out.deadlineLabel = "정차 기준 5분";
      out.facts.push({ c: "info", t: "운전자가 떠나지 않고 5분을 넘지 않으면 정차, 그보다 길면 주차예요. 타이머가 5분을 알려 드려요." });
      out.sources.push({ title: R.law.stopDef.source, meta: R.law.stopDef.text });
    }
    return out;
  }

  function describeBan(rule) {
    const label = DAY_LABEL[rule.dt];
    if (rule.ban.kind === "none") return `${label} 금지 없음`;
    if (rule.ban.kind === "all") return `${label} 종일 금지`;
    return `${label} ${fmtMin(rule.ban.s)}~${fmtMin(rule.ban.e)} 금지`;
  }
  function segSource(seg) {
    const days = ["wd", "sat", "hol"].map((k) => `${{ wd: "평일", sat: "토", hol: "공휴일" }[k]} ${seg[k][0]}~${seg[k][1]}`).join(" · ");
    return { title: `${R.standard.name} · ${seg.road}`, meta: `${seg.desc} · ${days} · ${R.standard.dirCode[seg.dir] || ""} · 관리 ${seg.agency} ${seg.phone} · 기준일 ${seg.ref}`, url: R.standard.url, note: R.standard.timeRule };
  }
  function noticeSource(n) {
    return { title: n.title, meta: `수정 ${n.updated} · 확인 ${R.checkedOn}`, url: n.url, quote: n.quotes[0], ai: true };
  }

  // ---------- 화면 ----------
  function render() {
    if (!state.point) return;
    const d = now();
    const v = evaluate(state.point, state.accuracy, d);
    state.lastVerdict = v;
    const box = $("verdict");
    box.dataset.level = v.level;
    $("place").textContent = placeLine(v);
    $("headline").textContent = v.headline;
    $("sub").textContent = v.sub;
    const ul = $("facts"); ul.replaceChildren();
    v.facts.forEach((f) => {
      const li = document.createElement("li");
      const dot = document.createElement("span"); dot.className = `dot ${f.c}`;
      const tx = document.createElement("span"); tx.textContent = f.t;
      li.append(dot, tx); ul.append(li);
    });
    renderAsk(v.ask);
    $("btn-park").disabled = false;
    renderWhy(v);
    drawMap(v, d);
  }
  function placeLine(v) {
    const src = state.source === "gps" ? `내 위치 (오차 약 ${Math.round(state.accuracy || 0)}m)` : state.source === "tap" ? "지도에서 고른 지점" : `시연 지점 · ${DEMO_SPOTS[state.source].name}`;
    const d = now();
    return `${src} · ${DAY_LABEL[dayType(d)]} ${fmtMin(d.getHours() * 60 + d.getMinutes())} 기준`;
  }
  function renderAsk(ask) {
    const slot = $("ask-slot"); slot.replaceChildren();
    if (!ask) return;
    const wrap = document.createElement("div"); wrap.className = "ask";
    const p = document.createElement("p"); p.textContent = `지금 차가 '${ask.road}' 위에 있나요?`;
    const row = document.createElement("div"); row.className = "row";
    const yes = button("네, 그 길이에요", () => { state.confirmRoad = ask.id; render(); });
    const no = button("아니요, 옆 길이에요", () => { state.confirmRoad = `no:${ask.id}`; render(); }, true);
    row.append(yes, no); wrap.append(p, row); slot.append(wrap);
  }
  function button(label, fn, secondary) {
    const b = document.createElement("button"); b.className = secondary ? "btn secondary" : "btn"; b.textContent = label; b.type = "button"; b.addEventListener("click", fn); return b;
  }
  function renderWhy(v) {
    const body = $("why-body"); body.replaceChildren();
    const seen = new Set();
    v.sources.forEach((s) => {
      const key = s.title + s.meta; if (seen.has(key)) return; seen.add(key);
      const div = document.createElement("div"); div.className = "src";
      const b = document.createElement("b"); b.textContent = s.title;
      if (s.ai) { const tag = document.createElement("span"); tag.className = "tag ai"; tag.textContent = "AI 정리 · 사람 확인"; b.append(" ", tag); }
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = s.meta;
      div.append(b, meta);
      if (s.note) { const n = document.createElement("div"); n.className = "meta"; n.textContent = `표준 해석: ${s.note}`; div.append(n); }
      if (s.quote) { const q = document.createElement("p"); q.className = "quote"; q.textContent = `“${s.quote}”`; div.append(q); }
      if (s.url) { const a = document.createElement("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "원문 열기"; a.className = "linkbtn"; div.append(a); }
      body.append(div);
    });
  }
  function renderAI() {
    const body = $("ai-body"); body.replaceChildren();
    R.notices.forEach((n) => {
      const intro = document.createElement("p"); intro.className = "fine";
      intro.textContent = "지자체마다 단속 기준을 공지 문장으로만 올립니다. 이 앱은 그 문장을 AI로 읽어 판정 엔진이 쓰는 규칙으로 바꾸고, 사람이 원문과 대조해 확정합니다. 기준이 바뀌면 문장만 다시 읽히면 됩니다.";
      const h = document.createElement("b"); h.textContent = `${n.area} · ${n.title} (수정 ${n.updated})`;
      const ql = document.createElement("div"); ql.className = "src";
      n.quotes.forEach((q) => { const p = document.createElement("p"); p.className = "quote"; p.textContent = `“${q}”`; ql.append(p); });
      const arrow = document.createElement("p"); arrow.className = "fine"; arrow.textContent = "↓ AI가 뽑은 규칙";
      const pre = document.createElement("pre"); pre.className = "json"; pre.textContent = JSON.stringify(n.extracted, null, 2);
      const note = document.createElement("p"); note.className = "fine"; note.textContent = n.note;
      const a = document.createElement("a"); a.href = n.url; a.target = "_blank"; a.rel = "noopener"; a.className = "linkbtn"; a.textContent = "공지 원문 열기";
      body.append(intro, h, ql, arrow, pre, note, a);
    });
  }

  // ---------- 지도 ----------
  let map, meMarker, accCircle, segLayer, zoneLayer;
  function initMap() {
    if (!window.L) { $("map").textContent = "지도를 불러오지 못했어요. 판정은 그대로 됩니다."; return; }
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([37.4585, 126.9005], 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
    segLayer = L.layerGroup().addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    map.on("click", (e) => { stopGps(); setPoint([e.latlng.lat, e.latlng.lng], 5, "tap"); });
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function drawMap(v, d) {
    if (!map) return;
    segLayer.clearLayers(); zoneLayer.clearLayers();
    state.segments.forEach((s) => {
      const st = segStatus(s, d);
      const isActive = v.segment && v.segment.id === s.id;
      L.polyline(s.coords, { color: st.banned ? css("--stop") : css("--go"), weight: isActive ? 8 : 5, opacity: isActive ? 1 : .75 })
        .bindTooltip(`${s.road} · ${st.banned ? "지금 금지" : "지금 허용 시간"}`).addTo(segLayer);
    });
    state.zones.forEach((z) => {
      if (meters(state.point, [z[0], z[1]]) > 1500) return;
      L.circleMarker([z[0], z[1]], { radius: 6, color: css("--road-yellow"), fillColor: css("--road-yellow"), fillOpacity: .9, weight: 2 }).bindTooltip(`${z[2]} (${z[3]})`).addTo(zoneLayer);
    });
    if (!meMarker) {
      meMarker = L.circleMarker(state.point, { radius: 9, color: "#fff", weight: 3, fillColor: css("--sign-blue"), fillOpacity: 1 }).addTo(map);
      accCircle = L.circle(state.point, { radius: state.accuracy || 5, color: css("--sign-blue"), weight: 1, fillOpacity: .08 }).addTo(map);
    } else {
      meMarker.setLatLng(state.point); accCircle.setLatLng(state.point); accCircle.setRadius(state.accuracy || 5);
    }
  }

  // ---------- 위치 ----------
  function setPoint(p, acc, source) {
    state.point = p; state.accuracy = acc; state.source = source; state.confirmRoad = null;
    document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    if (source === "gps") $("src-gps").setAttribute("aria-pressed", "true");
    if (typeof source === "number") document.querySelector(`.demo-spot[data-spot="${source}"]`).setAttribute("aria-pressed", "true");
    render();
    if (map) map.setView(p, Math.max(map.getZoom(), 16));
  }
  function stopGps() { if (state.watchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; } }
  function startGps(auto) {
    if (!("geolocation" in navigator)) { if (!auto) toast("이 브라우저는 위치를 지원하지 않아요. 시연 지점을 눌러 보세요."); fallbackDemo(); return; }
    stopGps();
    $("place").textContent = "위치를 확인하는 중입니다";
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => setPoint([pos.coords.latitude, pos.coords.longitude], pos.coords.accuracy, "gps"),
      (err) => {
        toast(err.code === 1 ? "위치 권한이 꺼져 있어요. 시연 지점으로 보여 드릴게요." : "위치를 잡지 못했어요. 시연 지점으로 보여 드릴게요.");
        fallbackDemo();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
    );
  }
  function fallbackDemo() { if (!state.point) setPoint([DEMO_SPOTS[0].lat, DEMO_SPOTS[0].lng], 8, 0); }

  // ---------- 타이머 ----------
  let tick = null, alerted = { pre: false, end: false };
  function loadPark() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; } }
  function savePark(p) { try { p ? localStorage.setItem(STORE_KEY, JSON.stringify(p)) : localStorage.removeItem(STORE_KEY); } catch { /* 저장 불가 환경은 화면 상태로만 둔다 */ } }
  function park() {
    const v = state.lastVerdict; if (!v) return;
    const p = { t0: Date.now(), limitMin: v.deadline, label: v.deadlineLabel, headline: v.headline, fast: state.fast };
    state.park = p; savePark(p); alerted = { pre: false, end: false };
    $("timer").hidden = false; runTimer();
    $("timer").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function leave() { state.park = null; savePark(null); clearInterval(tick); $("timer").hidden = true; toast("기록을 지웠어요."); }
  function runTimer() {
    clearInterval(tick);
    const step = () => {
      const p = state.park; if (!p) return;
      const speed = p.fast ? 60 : 1;
      const elapsedMin = (Date.now() - p.t0) / 60000 * speed;
      const totalSec = Math.floor(elapsedMin * 60);
      $("timer-elapsed").textContent = totalSec >= 3600 ? `${Math.floor(totalSec / 3600)}:${pad(Math.floor(totalSec % 3600 / 60))}:${pad(totalSec % 60)}` : `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;
      $("timer-label").textContent = p.fast ? "세운 지 (시연: 60배속)" : "세운 지";
      const t = $("timer");
      if (p.limitMin) {
        const left = p.limitMin - elapsedMin;
        $("timer-remain").textContent = left > 0 ? `${p.label}까지 ${fmtDur(Math.ceil(left))} 남음` : `${p.label} 시간이 지났어요`;
        $("timer-bar").style.width = `${Math.min(100, elapsedMin / p.limitMin * 100)}%`;
        $("timer-note").textContent = `세울 때 판정: ${p.headline}`;
        const pre = p.limitMin > 4 ? 2 : 1;
        if (left <= pre && left > 0 && !alerted.pre) { alerted.pre = true; notify(`${p.label}까지 ${Math.ceil(left)}분 남았어요`); }
        if (left <= 0 && !alerted.end) { alerted.end = true; notify(`${p.label} 시간이 지났어요. 차를 옮겨 주세요.`); }
        t.dataset.alert = String(left <= pre);
      } else {
        $("timer-remain").textContent = "기준 시간 없음";
        $("timer-bar").style.width = "0%";
        $("timer-note").textContent = `세울 때 판정: ${p.headline}`;
      }
    };
    step(); tick = setInterval(step, 1000);
  }
  function notify(msg) {
    toast(msg);
    try { navigator.vibrate && navigator.vibrate([300, 120, 300]); } catch { /* 진동 미지원 */ }
    try { if ("Notification" in window && Notification.permission === "granted") new Notification("세워도 돼?", { body: msg }); } catch { /* 알림 미지원 */ }
  }
  async function enableNotify() {
    if (!("Notification" in window)) { toast("이 브라우저는 알림을 지원하지 않아요. 화면 알림과 진동으로 알려 드릴게요."); return; }
    const r = await Notification.requestPermission();
    toast(r === "granted" ? "알림을 켰어요." : "알림이 꺼져 있어요. 화면 알림으로 알려 드릴게요.");
  }

  let toastTimer = null;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800); }

  // ---------- 시계와 시연 도구 ----------
  function updateClock() {
    const d = now();
    $("clock-time").textContent = fmtMin(d.getHours() * 60 + d.getMinutes()) + (state.timeOverride !== null ? " (시연)" : "");
    $("clock-day").textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일 · ${DAY_LABEL[dayType(d)]}`;
  }

  function bind() {
    $("src-gps").addEventListener("click", () => startGps(false));
    document.querySelectorAll(".demo-spot").forEach((b) => b.addEventListener("click", () => {
      stopGps(); const i = Number(b.dataset.spot); setPoint([DEMO_SPOTS[i].lat, DEMO_SPOTS[i].lng], 8, i);
    }));
    $("btn-park").addEventListener("click", park);
    $("btn-leave").addEventListener("click", leave);
    $("btn-notify").addEventListener("click", enableNotify);
    $("btn-why").addEventListener("click", () => { $("why").open = true; $("why").scrollIntoView({ behavior: "smooth", block: "start" }); });
    const range = $("time-shift");
    const d0 = new Date(); range.value = d0.getHours() * 60 + d0.getMinutes();
    range.addEventListener("input", () => { state.timeOverride = Number(range.value); $("time-shift-out").textContent = fmtMin(state.timeOverride); updateClock(); render(); });
    $("day-type").addEventListener("change", (e) => { state.dayOverride = e.target.value; updateClock(); render(); });
    $("time-reset").addEventListener("click", () => {
      state.timeOverride = null; state.dayOverride = "auto"; $("day-type").value = "auto";
      const d = new Date(); range.value = d.getHours() * 60 + d.getMinutes(); $("time-shift-out").textContent = "지금"; updateClock(); render();
    });
    $("fast-timer").addEventListener("click", (e) => {
      state.fast = !state.fast; e.target.textContent = state.fast ? "타이머 빨리 감기 끄기" : "타이머 빨리 감기 켜기";
      if (state.park) { state.park.fast = state.fast; savePark(state.park); }
      toast(state.fast ? "다음에 세우는 기록부터 60배속으로 흐릅니다." : "실제 시간으로 돌아왔어요.");
    });
  }

  async function boot() {
    bind(); initMap(); renderAI(); updateClock(); setInterval(() => { updateClock(); if (state.timeOverride === null) render(); }, 30000);
    try {
      const [segs, zones] = await Promise.all([fetch("data/segments.json").then((r) => r.json()), fetch("data/child_zones.json").then((r) => r.json())]);
      state.segments = segs; state.zones = zones;
    } catch {
      toast("데이터를 불러오지 못했어요. 새로고침해 주세요.");
    }
    let saved = loadPark();
    if (saved && Date.now() - saved.t0 > 12 * 3600 * 1000) { savePark(null); saved = null; }
    if (saved) { state.park = saved; state.fast = !!saved.fast; $("timer").hidden = false; runTimer(); }
    const params = new URLSearchParams(location.search);
    if (params.has("demo")) { const i = Math.min(2, Math.max(0, Number(params.get("demo")) || 0)); setPoint([DEMO_SPOTS[i].lat, DEMO_SPOTS[i].lng], 8, i); }
    else startGps(true);
  }
  boot();
})();
