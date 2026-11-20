"use strict";
(() => {
  const R = window.RULES;
  const DEMO_SPOTS = [
    { name: "독산로 우체국 앞", lat: 37.458402, lng: 126.905222 },
    { name: "가산초등학교 옆 길", lat: 37.4784095, lng: 126.8958144 },
    { name: "금하로1길 주택가", lat: 37.45277, lng: 126.89181 }
  ];
  const SNAP_M = 15;          // 이 거리 안이면 그 구간 위에 있다고 본다
  const CHILD_NEAR_M = 300;   // 보호구역 지정 범위(주출입문 반경)
  // 이보다 가까우면 판정 문구를 바꾼다. 학교는 정문 앞 도로가 보호구역인 경우가 많고, 어린이집은 촘촘해서 좁게 잡는다.
  const childCloseM = (kind) => (/초등학교|특수학교/.test(kind) ? 80 : 40);
  const PIN_ACC_M = 3;        // 사용자가 핀을 직접 맞춘 위치의 오차로 본다
  const STORE_KEY = "sewodo-park-v2";

  const $ = (id) => document.getElementById(id);
  const state = {
    segments: [], zones: [], point: null, source: null, accuracy: null,
    gps: null, follow: false,
    timeOverride: null, dayOverride: "auto", fast: false, watchId: null,
    lastVerdict: null, confirmRoad: null, moved: false
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
    if (rule.ban.kind === "none") return { banned: false, rule, untilMin: 1440 - m, changeAt: null };
    if (rule.ban.kind === "all") return { banned: true, rule, untilMin: 1440 - m, changeAt: null, allDay: true };
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
  function windowText(rule) {
    if (rule.ban.kind === "none") return "금지 없음";
    if (rule.ban.kind === "all") return "종일 금지";
    return `${fmtMin(rule.ban.s)}~${fmtMin(rule.ban.e)}`;
  }
  // 평일·토·휴일 금지 시간을 한 줄로. 같은 값은 묶는다.
  function scheduleText(seg) {
    const parts = [["평일", "weekday"], ["토", "sat"], ["휴일", "hol"]].map(([k, dt]) => [k, windowText(segRuleFor(seg, dt))]);
    const groups = [];
    parts.forEach(([k, w]) => { const g = groups.find((x) => x.w === w); g ? g.k.push(k) : groups.push({ k: [k], w }); });
    return groups.map((g) => `${g.k.join("·")} ${g.w}`).join(", ");
  }

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
  // facts: { k: 짧은 이름, t: 한두 줄, c: stop|caution|"" }
  function evaluate(p, acc, d) {
    const covered = inCoverage(p);
    const segs = state.segments.map((s) => ({ s, d: distToLine(p, s.coords) })).sort((a, b) => a.d - b.d);
    const near = segs[0];
    const zone = state.zones.reduce((best, z) => {
      const dz = meters(p, [z[0], z[1]]);
      return dz < best.d ? { z, d: dz } : best;
    }, { z: null, d: Infinity });
    const fuzz = Math.min(Math.max(acc || 0, 0), 60);
    const out = { level: "unknown", sign: "준비 중", headline: "", sub: "", facts: [], ask: null, deadline: null, sources: [], segment: null };

    let onSeg = null, maybeSeg = null;
    if (near && covered) {
      if (near.d <= SNAP_M || state.confirmRoad === near.s.id) onSeg = near;
      else if (near.d <= SNAP_M + fuzz && state.confirmRoad !== `no:${near.s.id}`) maybeSeg = near;
    }
    const childClose = zone.z && zone.d <= childCloseM(zone.z[3]);

    if (onSeg) {
      const seg = onSeg.s, st = segStatus(seg, d);
      out.segment = seg;
      const isCity = /시흥대로/.test(seg.road) && !/시흥대로\d+길/.test(seg.road);
      const notice = R.notices[0];
      const grace = isCity ? notice.extracted.cctv_seoul_city.confirm_after_min : notice.extracted.cctv_fixed.confirm_after_min;
      out.facts.push({ k: "구간", t: `${seg.road} · ${seg.desc}` });
      out.facts.push({ k: "금지 시간", t: scheduleText(seg) });
      if (st.banned) {
        out.level = "stop"; out.sign = "금지";
        out.headline = st.allDay ? "오늘은 종일 세울 수 없어요" : "지금은 세울 수 없어요";
        out.sub = st.changeAt ? `${st.changeAt}부터 가능 · ${fmtDur(st.untilMin)} 뒤` : "";
        out.facts.push({ k: "단속", t: `CCTV에 처음 찍히고 ${grace}분이 지나면 확정돼요${isCity ? " (시흥대로는 서울시 CCTV)" : ""}.`, c: "stop" });
        if (seg.type !== "2") out.facts.push({ k: "주의", t: "교차로·횡단보도 근처는 기다려 주지 않고 바로 단속해요.", c: "stop" });
        const m = d.getHours() * 60 + d.getMinutes();
        const lunch = notice.extracted.patrol.grace[0];
        if (st.rule.dt === "weekday" && inRange(m, toMin(lunch[0]), toMin(lunch[1]))) {
          out.facts.push({ k: "참고", t: `구청이 평일 ${lunch[0]}~${lunch[1]} 점심 단속을 쉬지만 어느 길인지 공개하지 않아 판정에서 뺐어요.` });
        }
        out.deadline = { min: grace, kind: "grace" };
      } else {
        out.level = "go"; out.sign = "가능";
        out.headline = "지금은 세워도 돼요";
        out.sub = st.changeAt ? `${st.changeAt}까지 · ${fmtDur(st.untilMin)} 남음` : `오늘(${DAY_LABEL[st.rule.dt]})은 금지 시간이 없어요`;
        if (st.changeAt) out.deadline = { min: st.untilMin, kind: "ban", at: st.changeAt };
      }
      out.sources.push(segSource(seg));
      out.sources.push(noticeSource(notice));
    } else if (maybeSeg) {
      const seg = maybeSeg.s;
      out.level = "caution"; out.sign = "확인";
      out.headline = "차가 어느 길에 있나요?";
      out.sub = `위치 오차 ${Math.round(acc || 0)}m 안에 ${seg.road} 금지구간이 있어요`;
      out.ask = { id: seg.id, road: seg.road };
      out.sources.push(segSource(seg));
    } else if (covered) {
      out.level = "go"; out.sign = "가능";
      out.headline = "지정 금지구간이 아니에요";
      out.sub = "모퉁이·횡단보도·정류소·소화전 근처만 피하세요";
      if (near) out.facts.push({ k: "가까운 구간", t: `${near.s.road}, ${Math.round(near.d)}m` });
      out.sources.push({ title: R.standard.name, meta: `금천구 ${R.coverage.totalRows}개 구간 중 ${R.coverage.mappedRows}개를 지도에 올림. 나머지는 주소를 찾지 못해 빠져 있음`, url: R.standard.url });
    } else {
      out.level = "unknown"; out.sign = "준비 중";
      out.headline = "이 동네는 아직 판정하지 못해요";
      out.sub = "금지구간은 서울 금천구만 들어 있어요";
    }

    // 어린이보호구역(전국 데이터)
    if (zone.z && zone.d <= CHILD_NEAR_M) {
      const [, , name, kind] = zone.z;
      const fact = { k: "보호구역", t: `${name}(${kind})까지 ${Math.round(zone.d)}m. 노란 노면이나 표지가 있으면 잠깐 정차도 안 돼요. 승용차 과태료 12만원.`, c: childClose ? "stop" : "caution" };
      onSeg ? out.facts.push(fact) : out.facts.unshift(fact);
      if (childClose && out.level !== "stop" && !onSeg) {
        out.level = "caution"; out.sign = "확인";
        out.headline = `${zone.z[3]} 바로 옆이에요`;
        out.sub = "어린이보호구역이면 잠깐 정차도 안 돼요";
      }
      out.sources.push({ title: "전국어린이보호구역표준데이터", meta: `${name} · 시설 위치만 있고 보호구역 경계선은 없음`, url: "https://www.data.go.kr/data/15012891/standard.do" });
      out.sources.push({ title: R.law.childZone.source, meta: `${R.law.childZone.rule}. ${R.law.childZone.scope} (${R.law.childZone.scopeSource}). ${R.law.childZone.fine}` });
    }

    // 정차 5분 기준과 법정 금지 장소
    if (out.level === "go" || out.level === "unknown") {
      out.facts.push({ k: "항상 금지", t: "교차로·횡단보도·보도 위, 모퉁이 5m, 버스정류소 10m, 소화전 5m 안" });
      out.sources.push({ title: "도로교통법 제32조", meta: R.law.absolute.map((a) => a.place).join(" / ") });
    }
    if (!out.deadline && out.level !== "stop" && !(out.level === "caution" && childClose)) {
      out.deadline = { min: 5, kind: "stop5" };
      if (!onSeg) out.facts.push({ k: "정차", t: "자리를 뜨지 않고 5분 안이면 정차, 넘으면 주차예요." });
      out.sources.push({ title: R.law.stopDef.source, meta: R.law.stopDef.text });
    }
    return out;
  }

  function segSource(seg) {
    const days = ["wd", "sat", "hol"].map((k) => `${{ wd: "평일", sat: "토", hol: "휴일" }[k]} ${seg[k][0]}~${seg[k][1]}`).join(" · ");
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
    $("verdict").dataset.level = v.level;
    $("sign").textContent = v.sign;
    $("place").textContent = placeLine(d);
    $("headline").textContent = v.headline;
    $("sub").textContent = v.sub; $("sub").hidden = !v.sub;
    const dl = $("facts"); dl.replaceChildren();
    v.facts.forEach((f) => {
      const dt = document.createElement("dt"); dt.textContent = f.k; if (f.c) dt.className = f.c;
      const dd = document.createElement("dd"); dd.textContent = f.t;
      dl.append(dt, dd);
    });
    dl.hidden = !v.facts.length;
    renderAsk(v.ask);
    $("btn-park").disabled = false;
    $("btn-park").parentElement.hidden = !!state.park;
    renderWhy(v);
    drawMap(d);
    updateHint();
  }
  function placeLine(d) {
    const t = `${DAY_LABEL[dayType(d)]} ${fmtMin(d.getHours() * 60 + d.getMinutes())} 기준`;
    if (state.source === "gps") return `내 위치 · 오차 ${Math.round(state.accuracy || 0)}m · ${t}`;
    if (state.source === "pin") return `직접 맞춘 위치 · ${t}`;
    return `시연 · ${DEMO_SPOTS[state.source].name} · ${t}`;
  }
  function renderAsk(ask) {
    const slot = $("ask-slot"); slot.replaceChildren();
    if (!ask) return;
    const wrap = document.createElement("div"); wrap.className = "ask";
    const p = document.createElement("p"); p.textContent = `지도를 끌어 핀을 차에 맞추거나, 아래에서 골라 주세요.`;
    const row = document.createElement("div"); row.className = "row";
    const yes = button(`${ask.road} 위예요`, () => { state.confirmRoad = ask.id; render(); });
    const no = button("다른 길이에요", () => { state.confirmRoad = `no:${ask.id}`; render(); }, true);
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
      if (s.ai) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "AI 정리 · 사람 확인"; b.append(" ", tag); }
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = s.meta;
      div.append(b, meta);
      if (s.note) { const n = document.createElement("div"); n.className = "meta"; n.textContent = `시각 읽는 법: ${s.note}`; div.append(n); }
      if (s.quote) { const q = document.createElement("p"); q.className = "quote"; q.textContent = s.quote; div.append(q); }
      if (s.url) { const a = document.createElement("a"); a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "원문 열기"; a.className = "linkbtn"; div.append(a); }
      body.append(div);
    });
  }
  function renderAI() {
    const body = $("ai-body"); body.replaceChildren();
    R.notices.forEach((n) => {
      const intro = document.createElement("p");
      intro.textContent = "구청은 단속 기준을 공지 글로만 올립니다. 그 글을 AI가 읽어 판정에 쓰는 규칙으로 바꾸고, 사람이 원문과 한 줄씩 대조했습니다. 공지가 바뀌면 새 글만 다시 읽히면 됩니다.";
      const h = document.createElement("b"); h.textContent = `${n.area} · ${n.title} (수정 ${n.updated})`;
      const ql = document.createElement("div"); ql.className = "src";
      n.quotes.forEach((q) => { const p = document.createElement("p"); p.className = "quote"; p.textContent = q; ql.append(p); });
      const arrow = document.createElement("p"); arrow.className = "fine"; arrow.textContent = "AI가 뽑은 규칙";
      const pre = document.createElement("pre"); pre.className = "json"; pre.textContent = JSON.stringify(n.extracted, null, 2);
      const note = document.createElement("p"); note.className = "fine"; note.textContent = n.note;
      const a = document.createElement("a"); a.href = n.url; a.target = "_blank"; a.rel = "noopener"; a.className = "linkbtn"; a.textContent = "공지 원문 열기";
      body.append(intro, h, ql, arrow, pre, note, a);
    });
  }

  // ---------- 지도 ----------
  // 핀은 화면 가운데 고정. 지도를 끌면 가운데 지점으로 다시 판정한다.
  let map, gpsDot, accCircle, segLayer, zoneLayer, userMove = false;
  function initMap() {
    if (!window.L) { $("map").textContent = "지도를 불러오지 못했어요. 판정은 그대로 됩니다."; return; }
    map = L.map("map", { zoomControl: false, attributionControl: true, inertia: false, touchZoom: "center", scrollWheelZoom: "center", doubleClickZoom: "center" })
      .setView([37.4585, 126.9005], 17);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
    segLayer = L.layerGroup().addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    map.on("dragstart", () => { userMove = true; });
    map.getContainer().addEventListener("keydown", (e) => { if (e.key.startsWith("Arrow")) userMove = true; });
    map.on("moveend", () => {
      if (!userMove) return;
      userMove = false;
      const c = map.getCenter();
      pinMoved([c.lat, c.lng]);
    });
    map.on("click", (e) => { map.panTo(e.latlng); pinMoved([e.latlng.lat, e.latlng.lng]); });
  }
  function pinMoved(p) {
    state.follow = false; state.moved = true;
    setPoint(p, PIN_ACC_M, "pin", false);
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function drawMap(d) {
    if (!map) return;
    segLayer.clearLayers(); zoneLayer.clearLayers();
    const v = state.lastVerdict;
    state.segments.forEach((s) => {
      const st = segStatus(s, d);
      const isActive = v && v.segment && v.segment.id === s.id;
      L.polyline(s.coords, { color: st.banned ? css("--stop") : css("--go"), weight: isActive ? 9 : 6, opacity: isActive ? 1 : .7, interactive: false }).addTo(segLayer);
    });
    state.zones.forEach((z) => {
      if (meters(state.point, [z[0], z[1]]) > 1500) return;
      L.circleMarker([z[0], z[1]], { radius: 6, color: "#fff", weight: 2, fillColor: css("--caution"), fillOpacity: 1 }).bindTooltip(`${z[2]} (${z[3]})`).addTo(zoneLayer);
    });
    if (state.gps) {
      if (!gpsDot) {
        accCircle = L.circle(state.gps.p, { radius: state.gps.acc, color: css("--pin"), weight: 1, fillOpacity: .08, interactive: false }).addTo(map);
        gpsDot = L.circleMarker(state.gps.p, { radius: 7, color: "#fff", weight: 3, fillColor: css("--pin"), fillOpacity: 1, interactive: false }).addTo(map);
      } else { gpsDot.setLatLng(state.gps.p); accCircle.setLatLng(state.gps.p); accCircle.setRadius(state.gps.acc); }
    }
  }
  function updateHint() {
    const hint = $("map-hint");
    if (state.source === "gps" && state.accuracy > 20) { hint.textContent = `위치 오차가 ${Math.round(state.accuracy)}m예요. 지도를 끌어 핀을 차에 맞추세요`; hint.hidden = false; }
    else if (!state.moved) { hint.textContent = "핀이 차와 다르면 지도를 끌어 맞추세요"; hint.hidden = false; }
    else hint.hidden = true;
    $("btn-locate").setAttribute("aria-pressed", String(state.source === "gps"));
  }

  // ---------- 위치 ----------
  function setPoint(p, acc, source, pan = true) {
    state.point = p; state.accuracy = acc; state.source = source; state.confirmRoad = null;
    document.querySelectorAll(".demo-spot").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.spot === String(source))));
    render();
    if (map && pan) map.setView(p, Math.max(map.getZoom(), 17), { animate: false });
  }
  function stopGps() { if (state.watchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; } }
  function startGps(auto) {
    state.follow = true;
    if (state.gps) setPoint(state.gps.p, state.gps.acc, "gps");
    if (!("geolocation" in navigator)) { if (!auto) toast("이 브라우저는 위치를 지원하지 않아요. 시연 도구에서 지점을 골라 보세요."); fallbackDemo(); return; }
    if (state.watchId !== null) return;
    if (!state.point) $("place").textContent = "위치를 찾고 있어요";
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.gps = { p: [pos.coords.latitude, pos.coords.longitude], acc: pos.coords.accuracy };
        if (state.follow) setPoint(state.gps.p, state.gps.acc, "gps");
        else drawMap(now());
      },
      (err) => {
        stopGps();
        toast(err.code === 1 ? "위치 권한이 꺼져 있어요. 시연 지점으로 보여 드릴게요." : "위치를 잡지 못했어요. 시연 지점으로 보여 드릴게요.");
        fallbackDemo();
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 12000 }
    );
  }
  function fallbackDemo() { if (!state.point) { setPoint([DEMO_SPOTS[0].lat, DEMO_SPOTS[0].lng], 8, 0); $("demo").open = true; } }

  // ---------- 타이머 ----------
  let tick = null, alerted = { pre: false, end: false };
  function loadPark() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; } }
  function savePark(p) { try { p ? localStorage.setItem(STORE_KEY, JSON.stringify(p)) : localStorage.removeItem(STORE_KEY); } catch { /* 저장 불가 환경은 화면 상태로만 둔다 */ } }
  const DEADLINE_TEXT = {
    grace: { left: (p, dur) => `단속 확정까지 ${dur}`, over: () => "단속 확정 시간이 지났어요", pre: (n) => `${n}분 뒤 단속이 확정돼요`, end: () => "단속 확정 시간이 지났어요. 차를 옮겨 주세요." },
    ban: { left: (p, dur) => `${p.at} 금지 시작까지 ${dur}`, over: (p) => `${p.at}부터 금지예요`, pre: (n, p) => `${p.at} 금지 시작까지 ${n}분`, end: (p) => `${p.at} 금지가 시작됐어요. 차를 옮겨 주세요.` },
    stop5: { left: (p, dur) => `정차 5분까지 ${dur}`, over: () => "5분이 지나 주차로 봐요", pre: (n) => `${n}분 뒤면 정차 5분이 끝나요`, end: () => "5분이 지났어요. 여기부터는 주차예요." }
  };
  function park() {
    const v = state.lastVerdict; if (!v || state.park) return;
    const dl = v.deadline || {};
    const p = { t0: Date.now(), limitMin: dl.min || null, kind: dl.kind || null, at: dl.at || null, headline: v.headline, fast: state.fast,
      noLimit: v.level === "caution" ? "보호구역이면 시간과 상관없이 금지예요" : "오늘은 이 자리에 금지 시간이 없어요" };
    state.park = p; savePark(p); alerted = { pre: false, end: false };
    $("timer").hidden = false; runTimer(); render();
    $("timer").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function leave() { state.park = null; savePark(null); clearInterval(tick); $("timer").hidden = true; render(); toast("타이머를 껐어요."); }
  function runTimer() {
    clearInterval(tick);
    const step = () => {
      const p = state.park; if (!p) return;
      const speed = p.fast ? 60 : 1;
      const elapsedMin = (Date.now() - p.t0) / 60000 * speed;
      const totalSec = Math.floor(elapsedMin * 60);
      $("timer-elapsed").textContent = totalSec >= 3600 ? `${Math.floor(totalSec / 3600)}:${pad(Math.floor(totalSec % 3600 / 60))}:${pad(totalSec % 60)}` : `${pad(Math.floor(totalSec / 60))}:${pad(totalSec % 60)}`;
      $("timer-label").textContent = p.fast ? "세운 지 · 시연 60배속" : "세운 지";
      $("timer-note").textContent = `세울 때 판정: ${p.headline}`;
      const t = $("timer");
      const tx = p.kind && DEADLINE_TEXT[p.kind];
      if (p.limitMin && tx) {
        const left = p.limitMin - elapsedMin;
        $("timer-remain").textContent = left > 0 ? tx.left(p, fmtDur(Math.ceil(left))) : tx.over(p);
        $("timer-bar").style.width = `${Math.min(100, elapsedMin / p.limitMin * 100)}%`;
        const pre = p.limitMin > 4 ? 2 : 1;
        if (left <= pre && left > 0 && !alerted.pre) { alerted.pre = true; notify(tx.pre(Math.ceil(left), p)); }
        if (left <= 0 && !alerted.end) { alerted.end = true; notify(tx.end(p)); }
        t.dataset.alert = String(left <= pre);
      } else {
        $("timer-remain").textContent = p.noLimit || "정해진 시한이 없어요";
        $("timer-bar").style.width = "0%";
        t.dataset.alert = "false";
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
    if (!("Notification" in window)) { toast("이 브라우저는 알림을 못 받아요. 화면과 진동으로 알려 드릴게요."); return; }
    const r = await Notification.requestPermission();
    toast(r === "granted" ? "시간이 다 되면 알림을 보낼게요." : "알림이 막혀 있어요. 화면으로 알려 드릴게요.");
  }

  let toastTimer = null;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3800); }

  // ---------- 시계와 시연 도구 ----------
  function updateClock() {
    const d = now();
    $("clock-time").textContent = fmtMin(d.getHours() * 60 + d.getMinutes()) + (state.timeOverride !== null ? " 시연" : "");
    $("clock-day").textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${DAYS[d.getDay()]}요일${state.dayOverride !== "auto" ? ` · ${DAY_LABEL[state.dayOverride]}로 보기` : ""}`;
  }

  function bind() {
    $("btn-locate").addEventListener("click", () => { state.moved = false; startGps(false); });
    document.querySelectorAll(".demo-spot").forEach((b) => b.addEventListener("click", () => {
      state.follow = false; state.moved = false;
      const i = Number(b.dataset.spot); setPoint([DEMO_SPOTS[i].lat, DEMO_SPOTS[i].lng], 8, i);
      window.scrollTo({ top: 0, behavior: "smooth" });
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
      state.fast = !state.fast; e.currentTarget.setAttribute("aria-pressed", String(state.fast));
      e.currentTarget.textContent = state.fast ? "타이머 60배속 끄기" : "타이머 60배속";
      toast(state.fast ? "다음에 세우는 기록부터 60배속이에요." : "실제 시간으로 돌아왔어요.");
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
    // 시연 배속 기록과 12시간 지난 기록은 다시 열 때 버린다
    let saved = loadPark();
    if (saved && (saved.fast || Date.now() - saved.t0 > 12 * 3600 * 1000)) { savePark(null); saved = null; }
    if (saved) { state.park = saved; $("timer").hidden = false; runTimer(); }
    const params = new URLSearchParams(location.search);
    if (params.has("demo")) { const i = Math.min(2, Math.max(0, Number(params.get("demo")) || 0)); setPoint([DEMO_SPOTS[i].lat, DEMO_SPOTS[i].lng], 8, i); }
    else startGps(true);
  }
  boot();
})();
