/* KOOS 실시간 예측 — 메인 조립.

   지도 · 모델/변수 탭 · 시간 · 범례 · 렌더러 · 관측을 하나로 묶는다.
   실제 그리기는 render.js, 자료는 store.js, 관측 그래프는 ts.js 에 있다.

   화면에 뜨는 색칠판은 **언제나 최신 사이클 한 벌**이다. 지난 예측은 담지
   않는다 (그건 관측 검증 패널의 과거 시계열이 맡는다). 그래서 시간축이
   0~96시간 고정이고, 사이클이 바뀌면 파일이 통째로 갈린다.

   모델을 바꾸면 격자도 같이 바뀐다. 공통 격자로 다시 깔지 않기 때문에
   기하(Geometry)를 모델별로 따로 만들어 두고 골라 쓴다. 한 번 만든 것은
   버리지 않는다 — WRF 조회표만 8MB 라 다시 만들면 눈에 띄게 끊긴다. */

import { Store, valueLUT, dirLUT, rawLUT } from "./store.js";
import { lut, gradient } from "./colormaps.js";
import { Renderer } from "./render.js";
import { Observations } from "./ts.js";
import { DIRMODE, bearing, compass } from "./dirconv.js";
import { isolineGeoJSON } from "./isoline.js";
import { PointInfo } from "./point.js";

const $ = (id) => document.getElementById(id);
const el = {
    cycle: $("cycle-label"), modelbar: $("modelbar"), modelInd: $("model-ind"),
    varbar: $("varbar"), varInd: $("var-ind"),
    panel: $("panel"), btnPanel: $("btn-panel"), btnObs: $("btn-obs"),
    btnFull: $("btn-full"), btnHelp: $("btn-help"),
    vecName: $("vec-name"), vecCheck: $("vec-check"),
    vecDensity: $("vec-density"), vecFade: $("vec-fade"),
    basemap: $("basemap"), gridCheck: $("grid-check"),
    obsCheck: $("obs-check"), opacity: $("opacity"), opacityVal: $("opacity-val"),
    status: $("status-line"), legend: $("legend"),
    timebar: $("timebar"), play: $("play"), clockMain: $("clock-main"),
    clockSub: $("clock-sub"), ticks: $("ticks"), range: $("time-range"),
    nowmark: $("nowmark"), pastband: $("pastband"), noband: $("noband"), speed: $("speed"), scrub: $("scrub"),
    help: $("help"), helpX: $("help-x"), helpFine: $("help-fine"),
    helpPerf: $("help-perf"),
    boot: $("boot"),
};

// 방향 표시 규약은 ts.js 와 나눠 쓴다 (dirconv.js 머리말 참고).

/* ── 모델별 입자 설정 ─────────────────────────────────────────────
   sref = "이 빠르기를 기준으로 잡는다". 렌더러가 걸음을 sref 로 나누므로
   셋 다 화면에서 비슷한 속도로 흐른다. 이게 없으면 유속(0.3m/s)은 멈춘 듯
   보이고 바람(10m/s)은 튀어 나간다.
   smax = 밝기 기준. 이 값에서 입자가 가장 밝다.

   SWAN 은 짝이 (파고, 파향) 이라 입자 빠르기가 파고에 비례한다. 파의 실제
   진행 속도는 주기로 정해지지만 그러자고 tp 를 항상 같이 받는 건 낭비다.
   "파고가 큰 곳이 더 빠르게 흐른다"는 그림도 뜻은 통하므로 이렇게 둔다. */
const FLOW = {
    wrf:   { smax: 20,  sref: 12 },
    swan:  { smax: 5,   sref: 2 },
    mohid: { smax: 1.2, sref: 0.5 },
};
const VECNAME = { wrf: "바람 입자", swan: "파향 입자", mohid: "해류 입자" };

const store = new Store("https://ust21-forecast.pages.dev/data");
const ren = new Renderer();
/* 섞임 비율은 **그릴 때** 계산한다. rAF 에서만 적어 두면, 정시에 자료가
   걸려 판을 맞바꾸고 곧바로 다시 그릴 때 옛 비율이 새 판에 적용돼 화면이
   한 칸 앞으로 튀었다 끌려온다 (render.js 의 tfFn 설명 참고). */
ren.tfFn = () => (S.loaded >= 0
    ? Math.max(0, Math.min(1, S.t - S.loaded)) : 0);
let map = null, obs = null, pinfo = null;
let NSTEP = 97;
let glReady;
const glReadyP = new Promise((r) => { glReady = r; });

const S = {
    model: "wrf", varName: "wspd",
    t: 0, step: 0, loaded: -1,
    playing: false, speed: 1,
    vecOn: true, opacity: 0.85,
    lookup: {},                 // 모델 -> CPU 쪽 조회표 (마우스 읽기용)
    lonlat: {},                 // 모델 -> 곡선격자 경위도 (등치선 라벨용)
    cpu: null, cpuDir: null,    // 지금 화면에 있는 프레임의 코드 배열
    hover: null,
};
const geoDone = {};
let gen = 0;                    // 늦게 도착한 응답을 버리는 표식
let pending = 0;                // 아직 안 걸린 apply() 개수
/* **색칠판이** 아직 안 걸린 apply() 개수. 재생 시계는 이것만 본다.
   pending 을 보면 안 된다 — apply() 는 색칠판을 올린 뒤에도 입자 프레임을
   더 기다리므로, 입자가 늦었다는 이유로 시계가 느려진다. 색칠판은 이미
   화면에 있는데 시간이 느려지면 그게 더 이상하다. */
let sPending = 0;

// ─────────────────────────────────────────────────────────────────────
// 주소줄에 지금 보는 화면을 적어 둔다.
//
// 두 가지를 산다. (1) 새로고침해도 보던 자리로 돌아온다 — 지금까지는 무조건
// WRF 풍속·전체 도메인으로 튕겼다. (2) 주소를 그대로 복사해 보내면 상대가
// **같은 화면**을 연다. 태풍 하나를 두고 이야기할 때 "모히드 염분 켜고 남해
// 쪽으로 당겨봐" 라고 말로 옮길 필요가 없어진다.
//
// replaceState 를 쓴다 — pushState 면 재생 한 번에 뒤로가기 이력이 97개
// 쌓여 브라우저 뒤로가기가 먹통이 된다.
// ─────────────────────────────────────────────────────────────────────
let hashTimer = 0, hashSelf = "";

function writeHash() {
    if (hashTimer) return;                       // 재생 중엔 초당 수십 번 불린다
    hashTimer = setTimeout(() => {
        hashTimer = 0;
        if (!map) return;
        const c = map.getCenter();
        const h = "#m=" + S.model + "&v=" + S.varName + "&t=" + Math.round(S.t) +
                  "&z=" + map.getZoom().toFixed(2) +
                  "&c=" + c.lng.toFixed(3) + "," + c.lat.toFixed(3) +
                  (S.base === "esri" ? "&b=esri" : "");
        if (h === hashSelf) return;
        hashSelf = h;
        history.replaceState(null, "", h);
    }, 400);
}

/** 주소줄 -> {m,v,t,z,c:[lng,lat]}. 없거나 망가진 항목은 빠진 채로 온다. */
function readHash() {
    const out = {};
    const q = new URLSearchParams(location.hash.replace(/^#/, ""));
    const m = q.get("m"), v = q.get("v"), t = +q.get("t"), z = +q.get("z");
    const c = (q.get("c") || "").split(",").map(Number);
    if (m) out.m = m;
    if (v) out.v = v;
    if (Number.isFinite(t) && q.get("t") !== null) out.t = t;
    if (Number.isFinite(z) && z >= 3 && z <= 13) out.z = z;
    if (c.length === 2 && c.every(Number.isFinite)) out.c = c;
    if (q.get("b") === "esri" || q.get("b") === "carto") out.b = q.get("b");
    return out;
}

/* 배경 지도 갈아 끼우기 (어두운 지도 <-> 위성영상).
   레이어를 지웠다 새로 만들지 않고 visibility 만 뒤집는다 — 스타일을 갈면
   그 위에 얹은 커스텀 GL 레이어가 통째로 다시 만들어져 텍스처를 다시 올린다.
   해안선 세기는 배경에 따라 바꾸지 않는다. 위성에서 은은하게 보이던 그
   세기가 어두운 지도에서도 보기 좋다 — 예전엔 어두운 지도에서만 진하게
   태워 노란 테가 자료보다 먼저 눈에 들어왔다. */
function setBasemap(kind) {
    const on = kind === "esri" ? "esri" : "carto";
    S.base = on;
    if (el.basemap && el.basemap.value !== on) el.basemap.value = on;
    if (!map || !map.getLayer("basemap-esri")) return;
    map.setLayoutProperty("basemap", "visibility", on === "carto" ? "visible" : "none");
    map.setLayoutProperty("basemap-esri", "visibility", on === "esri" ? "visible" : "none");
    writeHash();
}

// ─────────────────────────────────────────────────────────────────────
// 시각 표시 (KST)
// ─────────────────────────────────────────────────────────────────────
const KSTMS = 9 * 3600 * 1000;
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const p2 = (n) => String(n).padStart(2, "0");

function kstParts(d) {
    const k = new Date(d.getTime() + KSTMS);
    return { M: k.getUTCMonth() + 1, D: k.getUTCDate(), h: k.getUTCHours(),
             w: DOW[k.getUTCDay()], Y: k.getUTCFullYear() };
}

/* 머리말의 초기장 표시. 모델마다 사이클이 다를 수 있으므로 고른 모델을 따른다.
   뒤처진 모델은 그렇다고 적어 준다 — 왜 이 모델만 예측이 짧은지 화면에서
   알 수 있어야 한다. */
/* 제목 밑에 적는 한 줄.
   예전에는 "08/27 12UTC 초기장 · 8/26 21시 ~ 8/31 21시" 였는데, 앞토막이
   무슨 말인지 알려면 KOOS 운영 일정을 이미 알아야 한다 — 그런 사람은 이
   줄을 볼 이유가 없다. 화면이 답해야 하는 건 "지금 어느 기간을 보고 있나"
   하나라, 본문은 그것만 남기고 사이클·초기장은 말풍선으로 내렸다.
   (UTC 가 필요하면 시계 밑줄에 그대로 적혀 있다.)
   모델 하나가 뒤처졌을 때만 "자료 지연"을 붙인다 — 그건 알려야 한다. */
function updateCycleLabel() {
    const c = store.cycleOf(S.model);
    const end = kstParts(store.time(NSTEP - 1));
    const beg = kstParts(store.time(0));
    /* 초기장은 **이 모델 제 사이클**의 시각이다. 시간축은 셋이 공유하지만
       사이클까지 같은 건 아니다 — 태그를 그대로 읽는다 (YYYYMMDDHH, UTC). */
    const ct = Date.parse(`${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`
                          + `T${c.slice(8, 10)}:00:00Z`);
    const ini = kstParts(new Date(ct));
    const last = store.lastStep(S.model);
    const lq = last >= 0 && last < NSTEP - 1 ? kstParts(store.time(last)) : null;
    el.cycle.textContent =
        `${beg.M}/${beg.D} ${p2(beg.h)}시 ~ ${end.M}/${end.D} ${p2(end.h)}시 KST` +
        (lq ? " · 뒤 결측" : "");
    el.cycle.title =
        `${c} 사이클 · 초기장 ${ini.M}/${ini.D} ${p2(ini.h)}시 KST` +
        ` (${c.slice(8, 10)} UTC) · 앞 하루는 직전 사이클 예보` +
        (lq
            ? `\n이 모델은 ${lq.M}/${lq.D} ${p2(lq.h)}시까지만 나와 있다.`
              + ` 그 뒤는 원본이 아직 없어 비운다.`
            : "");
}

/* 시간축 앞에 붙은 과거 예보 스텝 수. 사이클 초기시각보다 하루 이르다.
   (make_manifest 가 넣는다. 옛 매니페스트에는 없으므로 0 으로 본다.) */
function pastSteps(model) {
    const mf = store.manifest;
    const mm = mf.models[model || S.model];
    return (mm && mm.past) || mf.past || 0;
}

let clockH = -1;                    // 마지막으로 찍은 정시
function updateClock(force) {
    const s = Math.round(S.t);
    /* 재생 중에는 1초에 60번 불린다. 정시가 그대로면 같은 글자를 다시 쓰는
       셈이라 그냥 나간다 (모델을 갈아끼우면 같은 스텝이라도 시각이 달라지니
       그때는 force). */
    if (s === clockH && !force) return;
    clockH = s;
    const d = store.time(s, S.model);
    const k = kstParts(d);
    // 리드타임은 사이클 초기시각 기준이다. 앞에 붙인 과거분에서 +0h 부터
    // 세면 "지난 예보"가 이번 사이클처럼 보인다.
    const lead = s - pastSteps();
    el.clockMain.textContent = `${k.M}/${k.D} (${k.w}) ${p2(k.h)}시`;
    el.clockSub.textContent =
        (lead >= 0 ? `+${lead}h` : `지난 예보 ${lead}h`) +
        ` · ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
        `${p2(d.getUTCHours())} UTC`;
}

// ─────────────────────────────────────────────────────────────────────
// 탭
// ─────────────────────────────────────────────────────────────────────
/* 고른 탭 밑에 깔리는 알약. 세로 막대면 높이·translateY, 가로면 폭·translateX.
   폰에서는 변수 막대가 가로로 눕는다 — 축이 바뀌면 **반대쪽 인라인 값을
   지워야** 한다. 남겨 두면 가로 막대에 세로 시절의 height 가 붙어 알약이
   막대보다 낮거나 높게 뜬다. */
function moveInd(btn, ind, horizontal) {
    if (!btn) return;
    if (horizontal) {
        ind.style.height = "";
        ind.style.width = btn.offsetWidth + "px";
        ind.style.transform = `translateX(${btn.offsetLeft}px)`;
    } else {
        ind.style.width = "";
        ind.style.height = btn.offsetHeight + "px";
        ind.style.transform = `translateY(${btn.offsetTop}px)`;
    }
}

/** 변수 막대가 지금 가로로 누워 있나 (폰 · 가로보기). CSS 가 정하고 JS 는 읽는다. */
function varbarHoriz() {
    if (typeof getComputedStyle !== "function" || !el.varbar) return false;
    return getComputedStyle(el.varbar).flexDirection === "row";
}

function buildModelBar() {
    for (const m of store.manifest.model_order) {
        const md = store.manifest.models[m];
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.model = m;
        b.setAttribute("role", "tab");
        b.innerHTML = `${md.label}<i>${md.sub}</i>`;
        b.addEventListener("click", () => setModel(m));
        el.modelbar.appendChild(b);
    }
}

function buildVarBar() {
    const md = store.manifest.models[S.model];
    for (const b of Array.from(el.varbar.querySelectorAll("button"))) b.remove();
    for (const v of md.order) {
        const sp = md.vars[v];
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.var = v;
        b.setAttribute("role", "tab");
        b.innerHTML = `${sp.label}<u>${sp.kind === "dir" ? "°" : sp.unit}</u>`;
        b.addEventListener("click", () => setVar(v));
        el.varbar.appendChild(b);
    }
    el.varbar.dataset.model = S.model;
}

function syncTabs() {
    let cur = null;
    for (const b of el.modelbar.querySelectorAll("button")) {
        const on = b.dataset.model === S.model;
        b.setAttribute("aria-selected", on ? "true" : "false");
        if (on) cur = b;
    }
    el.modelbar.dataset.model = S.model;
    el.timebar.dataset.model = S.model;
    moveInd(cur, el.modelInd, true);

    cur = null;
    for (const b of el.varbar.querySelectorAll("button")) {
        const on = b.dataset.var === S.varName;
        b.setAttribute("aria-selected", on ? "true" : "false");
        if (on) cur = b;
    }
    const hz = varbarHoriz();
    moveInd(cur, el.varInd, hz);
    /* 가로 막대는 여섯 개가 다 안 보인다. 키보드(↑↓)나 모델 전환으로 고른
       것이 화면 밖에 있으면 눌린 표시를 볼 수 없다 — 보이는 데로 끌어온다. */
    if (hz && cur && el.varbar.scrollWidth > el.varbar.clientWidth) {
        const l = cur.offsetLeft, r = l + cur.offsetWidth;
        const vl = el.varbar.scrollLeft, vr = vl + el.varbar.clientWidth;
        if (l < vl + 8) el.varbar.scrollLeft = Math.max(0, l - 8);
        else if (r > vr - 8) el.varbar.scrollLeft = r - el.varbar.clientWidth + 8;
    }
}

// ─────────────────────────────────────────────────────────────────────
// 범례
// ─────────────────────────────────────────────────────────────────────
function nice(v) {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(a % 1 ? 1 : 0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
}

function updateLegend() {
    const sp = store.spec(S.model, S.varName);
    const isDir = sp.kind === "dir";
    const mode = DIRMODE[`${S.model}.${S.varName}`] || "to";
    const cmap = isDir ? "phase" : sp.cmap;
    let scale;
    if (isDir) {
        // 방위각 색상표. 0=북 이고 시계 방향으로 돈다.
        scale = ["북", "동", "남", "서", "북"].map((s) => `<span>${s}</span>`).join("");
    } else {
        scale = [];
        for (let i = 0; i < 5; i++) {
            scale.push(`<span>${nice(sp.vmin + (sp.vmax - sp.vmin) * i / 4)}</span>`);
        }
        scale = scale.join("");
    }
    const note = isDir
        ? (mode === "from" ? "오는 쪽 기준" : "가는 쪽 기준")
        : sp.unit;

    el.legend.innerHTML =
        `<div class="lg-t"><span>${sp.label}</span><u>${note}</u></div>` +
        `<div class="lg-bar" style="background:${gradient(cmap, 48)}"></div>` +
        `<div class="lg-s">${scale}</div>` +
        // 색만 있으면 1005hPa 인지 1009hPa 인지 눈으로 못 가른다. 선이 있다는
        // 것과 그 간격을 적어 둬야 선을 세어 값을 읽을 수 있다.
        (sp.iso ? `<div class="lg-iso">등치선 ${nice(sp.iso)} ${sp.unit}`
                + (sp.isob ? ` · 굵은 선 ${nice(sp.isob)} ${sp.unit}` : "")
                + "</div>" : "");
}

// ─────────────────────────────────────────────────────────────────────
// 자료 올리기
// ─────────────────────────────────────────────────────────────────────
/** 방향장을 색으로 칠할 때 쓰는 LUT. 코드 -> 방위각/360. */
function dirFieldLUT(mode) {
    const a = new Float32Array(256);
    for (let c = 1; c < 256; c++)
        a[c] = bearing((c - 1) / 254 * 2 * Math.PI - Math.PI, mode) / 360;
    return a;
}

async function ensureGeometry(m) {
    if (geoDone[m]) return;
    const g = store.grids[m];
    let ll = null;
    if (g.kind === "curvilinear") {
        ll = await store.binary(`${m}/${g.lonlat.file}`, g.nx * g.ny * 2 * 4);
        // 등치선 라벨이 격자좌표를 경위도로 옮길 때 이걸 읽는다. 렌더러가
        // 이미 들고 있지만 GPU 텍스처로 올린 뒤라 CPU 에서 다시 못 본다.
        S.lonlat[m] = new Float32Array(ll);   // 같은 버퍼를 보는 창이다 (복사 아님)
    }
    const geo = ren.addGeometry(m, g, ll);
    if (g.lookup) {
        const res = g.lookup.res;
        const buf = await store.binary(`${m}/${g.lookup.file}`, res * res * 2 * 4);
        geo.setLookup(ren.gl, buf, res, g.lookup);
        // 렌더러가 이미 Float32Array 로 들고 있다. 8MB 를 두 벌 둘 이유가 없다.
        S.lookup[m] = { f: geo.lookupF32, res, meta: g.lookup };
    }
    geoDone[m] = true;
}

let lastApply = null;
async function apply() {
    const my = ++gen;
    const m = S.model, v = S.varName;
    const s0 = Math.max(0, Math.min(NSTEP - 1, S.step));
    /* 다음 칸이 이 모델의 예보 끝을 넘으면 제자리를 쓴다. 넘어가면 결측
       코드(0)와 섞여 마지막 한 시간이 엉뚱한 색으로 스러진다. */
    const s1 = Math.min(NSTEP - 1, store.lastStep(m), s0 + 1);

    /* 데우는 건 **기다리기 전에** 건다. 끝나고 걸면 지금 칸을 다 받은 뒤에야
       다음 청크를 부르기 시작해서, 청크 경계(6칸마다)에서 꼬박 한 번 씩
       회선을 기다리게 된다. 배속이 빠를수록 더 멀리 데운다 — 6× 면 1초에
       여섯 칸, 청크 하나를 1초에 하나씩 먹는다. */
    /* 시간축을 훌쩍 옮겼거나 모델·변수를 갈아탔으면, 방금 걸어 둔 앞자락은
       전부 헛돈다. 버리지 않으면 지금 필요한 청크가 그 뒤에 줄을 선다. */
    if (!lastApply || lastApply.m !== m || lastApply.v !== v
        || Math.abs(s0 - lastApply.s) > 2) store.dropWarm();
    lastApply = { m, v, s: s0 };

    warmAhead(m, v, s0);

    pending++; sPending++;
    let done = false;                       // 색칠판을 걸었나
    try {
        await ensureGeometry(m);
        if (my !== gen) return;

        const sp = store.spec(m, v);
        const isDir = sp.kind === "dir";
        const [sv, dv] = store.manifest.models[m].vector;

        /* **색칠판 먼저, 입자 나중.** 예전엔 여섯 프레임(색칠·속력·방향)을
           한꺼번에 기다렸다. 그러면 색칠판은 다 왔는데 방향 청크가 늦었다고
           시계가 통째로 붙잡혀 정시마다 화면이 멎었다 — 청크 경계(6칸마다)
           에서 특히 그랬다. 입자는 제 속도로 적분되니 한 칸 늦게 갈아껴도
           티가 안 난다. 그러니 색칠판이 오는 즉시 풀어 준다. */
        const [ca, cb] = await Promise.all([
            store.frame(m, v, s0), store.frame(m, v, s1),
        ]);
        if (my !== gen) return;

        /* 이 모델의 예보가 이 시각까지 안 닿는다. 두 모양이 있다 — 사이클이
           뒤처져 축이 짧거나(frame 이 null), 사이클은 맞는데 뒷날 원본이 아직
           없어 청크 뒤가 통째로 결측이거나(MOHID 의 보통 상태). 어느 쪽이든
           비운다 — 남의 시각 값을 늘려 그리면 그건 거짓말이다. */
        if (!ca || s0 > store.lastStep(m)) {
            ren.clearField();
            ren.clearFlow();            // 입자도 같이 끈다 (안 끄면 묵은 흐름이 돈다)
            S.cpu = null; S.cpuDir = null;
            S.loaded = s0; sPending--; done = true;
            map.triggerRepaint();
            updateIsolines();
            showStatus();
            return;
        }

        // 등치선은 물리값 표를 따로 넘겨야 그릴 수 있다 (표시범위 밖도 살린다).
        // 방향장은 순환량이라 등치선이 의미 없다 — 넘기지 않는다.
        const rlut = isDir ? null : rawLUT(sp);
        /* 정시에 드는 값을 잰다. "툭 끊긴다"를 숫자로 바꾸는 유일한 자다 —
           GL 업로드는 드라이버가 붙잡으면 여기서 그대로 시간이 흐른다.
           도움말(?) 안에만 내민다. */
        const upT0 = perfNow();
        ren.setScalar(m, isDir ? dirFieldLUT(DIRMODE[`${m}.${v}`] || "to") : valueLUT(sp),
                      lut(isDir ? "phase" : sp.cmap), ca, cb,
                      rlut, sp.iso ? { step: sp.iso, bold: sp.isob || 0 } : null,
                      `${m}/${v}/${s0}`, `${m}/${v}/${s1}`, `${m}/${v}`);
        upMs = perfNow() - upT0;
        if (upMs > upWorst) upWorst = upMs;

        S.cpu = { codes: ca, spec: sp, raw: rawLUT(sp), isDir };
        // 방향장은 뒤따라온다. 모델이 바뀌었으면 옛 격자 배열을 들고 있으면
        // 안 된다 — 색인이 달라 엉뚱한 칸을 읽는다.
        if (S.cpuDir && S.cpuDir.model !== m) S.cpuDir = null;
        S.loaded = s0; sPending--; done = true;
        map.triggerRepaint();

        /* 격자는 값이 있는 칸만 긋는다 (fieldMask). 첫 프레임이 오기 전에는
           마스크가 없어 통째로 그어지므로, 자료가 걸린 뒤 한 번 다시 만든다.
           캐시가 차면 다음 스텝부터는 그냥 지나간다. */
        if (!gridCache[m]) updateGridLines();

        updateIsolines();
        showStatus();

        /* 입자는 여기서 따라잡는다. 시계는 이미 풀렸으므로 이 기다림은
           화면을 붙잡지 않는다. */
        const [sa, sb, da, db] = await Promise.all([
            store.frame(m, sv, s0), store.frame(m, sv, s1),
            store.frame(m, dv, s0), store.frame(m, dv, s1),
        ]);
        if (my !== gen) return;
        /* 색칠 변수는 왔는데 속력·방향 청크가 이 시각엔 비었을 수 있다
           (변수마다 원본 파일이 따로다). 그럼 입자는 끈다. */
        if (!sa || !da) { ren.clearFlow(); S.cpuDir = null; map.triggerRepaint(); return; }
        const fl = FLOW[m];
        ren.setFlow(m, sa, sb, da, db,
                    rawLUT(store.spec(m, sv)), dirLUT(store.spec(m, dv)),
                    fl.smax, fl.sref);
        S.cpuDir = { model: m, codes: da, raw: rawLUT(store.spec(m, dv)), name: dv,
                     mode: DIRMODE[`${m}.${dv}`] || "to" };
        map.triggerRepaint();
    } catch (e) {
        console.error(e);
        el.status.innerHTML = `<b style="color:var(--warn)">불러오기 실패</b> ${e.message}`;
    } finally {
        pending--;
        if (!done) sPending--;              // 취소·실패해도 시계를 붙잡지 않는다
    }
}

/** 앞쪽 청크를 미리 받아 둔다. 색칠 변수 + 벡터 두 갈래 모두.
    배속이 빠를수록 더 멀리 본다 — 4배속이면 청크 하나(6칸)가 1.5초다.
    다만 회선이 가늘면 앞을 데우는 일이 지금 필요한 칸의 발목을 잡는다.
    이미 줄이 서 있으면 한 칸만 데운다. */
function warmAhead(m, v, s0) {
    const vec = store.manifest.models[m].vector || [];
    /* 재생 중에는 **적어도 두 청크** 앞을 본다. 예전엔 회선이 붐비면 한
       청크로 줄였는데, 붐비는 이유가 대개 앞을 데우는 일 자체라 스스로
       발목을 잡았다 — 그래서 6칸마다 꼭 한 번씩 멎었다. 청크는 한 번
       받으면 캐시에 남으니 미리 부르는 값이 싸다. */
    const lead = !S.playing ? 1
               : Math.min(4, Math.max(2, Math.ceil(S.speed / 2)));
    for (const vv of new Set([v].concat(vec))) store.prefetch(m, vv, s0, lead);
}

// ─────────────────────────────────────────────────────────────────────
// 마우스 읽기
// ─────────────────────────────────────────────────────────────────────
/** (경도,위도) -> 격자 1차원 색인. 격자 밖이면 null.
    모델을 따로 받는다 — 지점 팝업은 활성 모델이 아닌 것도 물어본다. */
function cellAt(lng, lat, model) {
    const m = model || S.model;
    const g = store.grids[m];
    let i, j;
    if (g.kind === "curvilinear") {
        const L = S.lookup[m];
        if (!L) return null;
        const k = L.meta;
        const u = (lng - k.lon_min) / (k.lon_max - k.lon_min);
        const w = (lat - k.lat_min) / (k.lat_max - k.lat_min);
        if (u < 0 || u > 1 || w < 0 || w > 1) return null;
        const px = Math.min(L.res - 1, Math.floor(u * L.res));
        const py = Math.min(L.res - 1, Math.floor(w * L.res));
        const o = (py * L.res + px) * 2;
        i = L.f[o]; j = L.f[o + 1];
        if (i < 0 || j < 0) return null;
    } else {
        i = (lng - g.lon0) / g.dlon;
        j = (lat - g.lat0) / g.dlat;
    }
    const ii = Math.round(i), jj = Math.round(j);
    if (ii < 0 || jj < 0 || ii >= g.nx || jj >= g.ny) return null;
    return jj * g.nx + ii;
}

/** cellAt 의 반대. 격자 1차원 색인 -> (경도,위도). 칸 복판을 준다.
    지점판이 "실제로 읽은 칸"을 알려 주면, 팝업 표식을 그 칸으로 옮기는 데
    쓴다. 곡선격자(WRF)는 경위도표가 있어야 하므로 ensureGeometry 뒤에만
    답이 나온다 — 아직이면 null. */
function cellLngLat(model, idx) {
    const m = model || S.model;
    const g = store.grids[m];
    if (!g || !(idx >= 0) || idx >= g.nx * g.ny) return null;
    const i = idx % g.nx, j = (idx / g.nx) | 0;
    if (g.kind === "curvilinear") {
        const ll = S.lonlat[m];
        if (!ll) return null;
        const k = idx * 2;
        return [ll[k], ll[k + 1]];
    }
    return [g.lon0 + i * g.dlon, g.lat0 + j * g.dlat];
}

function showStatus() {
    const g = store.grids[S.model];
    const md = store.manifest.models[S.model];
    const kind = g.kind === "curvilinear" ? "곡선격자" : "정형격자";
    let s = `<b>${md.label}</b> ${kind} ${g.nx}×${g.ny}`;

    /* 이 모델이 지금 시각까지 안 닿는다 (제 사이클이 뒤처졌다). 시간축은
       가장 새 사이클 하나로 통일했으므로 뒤처진 모델은 뒤가 빈다. */
    if (S.step > store.lastStep(S.model)) {
        const last = store.lastStep(S.model);
        const q = last >= 0 && last < NSTEP ? kstParts(store.time(last)) : null;
        const ok = q ? `${q.M}/${q.D} ${p2(q.h)}시` : null;
        el.status.innerHTML = s +
            `<br><b style="color:var(--warn)">이 시각 예보 없음</b>` +
            `<br><span style="color:var(--faint)">${md.cycle} 사이클` +
            (ok ? ` · ${ok} 까지` : "") + `</span>`;
        return;
    }

    const h = S.hover;
    if (h && S.cpu) {
        const k = cellAt(h.lng, h.lat);
        const sp = S.cpu.spec;
        let txt;
        if (k === null) txt = "격자 밖";
        else {
            const c = S.cpu.codes[k];
            if (c === 0) txt = "육지";
            else if (S.cpu.isDir) {
                const b = bearing(S.cpu.raw[c], DIRMODE[`${S.model}.${S.varName}`] || "to");
                txt = `${b.toFixed(0)}° ${compass(b)}`;
            } else {
                txt = `${nice(S.cpu.raw[c])} ${sp.unit}`;
            }
            // 짝이 되는 방향도 같이 (색칠판이 스칼라일 때만 뜻이 있다)
            if (!S.cpu.isDir && S.cpuDir) {
                const d = S.cpuDir.codes[k];
                if (d !== 0) {
                    const b = bearing(S.cpuDir.raw[d], S.cpuDir.mode);
                    txt += ` · ${b.toFixed(0)}° ${compass(b)}`;
                }
            }
        }
        s += `<br><b>${sp.label}</b> ${txt}` +
             `<br><span style="color:var(--faint)">${h.lat.toFixed(3)}N ` +
             `${h.lng.toFixed(3)}E</span>`;
    } else {
        s += `<br><span style="color:var(--faint)">지도 위에 커서를 올리면 값을 읽습니다</span>`;
    }
    el.status.innerHTML = s;
}

// ─────────────────────────────────────────────────────────────────────
// 조작
// ─────────────────────────────────────────────────────────────────────
function setModel(m) {
    if (m === S.model) return;
    S.model = m;
    S.varName = store.manifest.models[m].default;
    buildVarBar();
    syncTabs();
    updateLegend();
    updateVecLabel();
    // 모델마다 초기시각이 다를 수 있으니 눈금·시계·초기장 표시를 다시 만든다
    buildTicks();
    updateCycleLabel();
    updateClock(true);   // 모델이 바뀌면 같은 스텝이라도 시각이 다르다
    ren.clearField();
    ren.clearFlow();            // 옛 모델 격자에 입자를 다시 뿌리지 않게
    S.loaded = -1;
    apply();
    updateGridLines();          // 모델마다 격자가 다르다
    writeHash();
}

/** 변수 막대에서 한 칸 위/아래. 끝에서는 반대쪽으로 감는다. */
function stepVar(d) {
    const order = store.manifest.models[S.model].order;
    const i = order.indexOf(S.varName);
    setVar(order[(i + d + order.length) % order.length]);
}

function setVar(v) {
    if (v === S.varName) return;
    S.varName = v;
    syncTabs();
    updateLegend();
    S.loaded = -1;
    apply();
    if (obs) obs.setField(S.model, v);
    writeHash();
}

function updateVecLabel() {
    el.vecName.textContent = VECNAME[S.model];
}

function setTime(t, syncSlider = true) {
    S.t = Math.max(0, Math.min(NSTEP - 1, t));
    /* 손잡이는 **소수점째로** 옮긴다 (막대 step 이 0.05 다). 정시로 반올림해
       놓으면 4배속에서 초당 네 번 뚝뚝 튄다 — 색칠판은 그 사이를 섞어 가는데
       손잡이만 계단으로 가니 화면 전체가 끊겨 보인다. */
    if (syncSlider) el.range.value = String(S.t.toFixed(2));
    updateClock();
    if (obs) obs.setCursor(S.t);
    if (pinfo) pinfo.setStep();
    const s = Math.floor(S.t);
    if (s !== S.step) { S.step = s; apply(); }
    writeHash();
}

function setPlaying(on) {
    S.playing = on;
    // 재생을 멈추면 라벨을 되살린다 (재생 중에는 일부러 비워 둔다).
    updateIsolines(on ? 0 : 120);
    el.play.dataset.playing = on ? "1" : "0";
    el.play.textContent = on ? "" : "▶";
    el.play.setAttribute("aria-label", on ? "멈춤" : "재생");
    if (on) map.triggerRepaint();
}

/* 렌더러에 지금 보는 범위를 알려 준다. 입자는 화면 안에서 태어나야 하고
   (도메인 전체에서 뽑으면 확대했을 때 화면에 하나도 안 들어온다), 걸음
   크기·꼬리 길이·밀도도 줌에 따라 달라진다.

   reseed=false 는 드래그 중에 부르는 값싼 경로다. 후보 자리를 다시 뽑는
   일(수천 번의 격자 조회)은 손을 뗀 뒤(moveend)에만 한다. */
function syncView(reseed) {
    if (!map) return;
    const b = map.getBounds();
    ren.setView(map.getZoom(),
                [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
                !!reseed);
}

// ─────────────────────────────────────────────────────────────────────
// 해안선 — 줌에 따라 두 판이 서로 녹아든다
//
// coast.geojson    z8/z9 타일에서 120m 로 솎은 판. 9.6만 점, 전송 300KB.
// coast_hi.geojson z10 타일에서 50m 로 솎은 판. 20.7만 점, 전송 600KB.
//
// 전체 도메인에서는 120m 가 반 픽셀도 안 된다 — 촘촘한 판을 얹어 봐야
// 보이는 건 바위 조각 수천 개가 만드는 얼룩과 무거워진 타일링뿐이다.
// 반대로 z13 까지 당기면 그 120m 가 6~7 픽셀이라 해안이 각진 다각형이 된다.
//
// 예전에는 문턱을 넘을 때 source 를 통째로 갈아끼웠다. 그러면 어느 한
// 줌에서 해안선이 "확" 바뀐다 — 형태가 거의 같은데도 눈은 그 순간을
// 정확히 잡아낸다. 그래서 지금은 **두 판을 겹쳐 놓고 투명도를 줌 함수로
// 서로 반대로** 준다. z8.4 에서 z9.6 까지 1.2 줌에 걸쳐(휠 서너 칸) 한쪽이
// 옅어지면서 다른 쪽이 짙어지므로, 손이 움직이는 만큼만 바뀐다.
// 줌에 직접 물린 식이라 시간 애니메이션이 아니고, 되돌아 나올 때도 같은
// 길을 그대로 되짚는다 — 문턱 떨림 자체가 없다.
//
// 촘촘한 판은 페이드가 시작되기 전(z8.1)에 미리 받아 둔다. 한 번 받으면
// 들고 있는다. 첫 화면이 전체 도메인이면 아예 받지 않는다.
// 켜는 쪽만 visibility 를 준다 — 겹쳐 놓으면 선이 두 겹으로 보인다.
// ─────────────────────────────────────────────────────────────────────
const COAST_SW = 8;                     // 여기서 성긴 판 <-> 촘촘한 판
const COAST_GET = 7.4;                  // 그 전에 미리 받아 둔다
let coastHi = null;                     // 받아 둔 촘촘한 판
let coastHiOn = false;                  // source 에 넣었나
let coastGetting = false;

function coastVis(id, on) {
    if (map.getLayer(id))
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}

function syncCoast() {
    if (!map || !map.getLayer("coasthi")) return;
    const z = map.getZoom();

    if (!coastHi && !coastGetting && z >= COAST_GET) {
        coastGetting = true;
        fetch(store.url("coast_hi.geojson"))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
            .then((g) => { coastHi = g; coastGetting = false; syncCoast(); })
            .catch((e) => {             // 못 받으면 성긴 판 그대로 둔다
                coastGetting = false;
                console.warn("촘촘한 해안선을 못 받았다", e);
            });
    }
    if (coastHi && !coastHiOn) {
        map.getSource("coasthi").setData(coastHi);
        coastHiOn = true;
    }

    /* 둘 중 **하나만** 켠다. 서로 녹아들게 해 봤더니 두 판은 같은 해안을
       다르게 단순화한 것이라 겹치는 동안 선이 둘로 갈라져 보였다. 같은
       모양이 아닌 것을 겹쳐 놓으면 부드러운 게 아니라 그냥 두 겹이다.
       경계는 정확히 z8 하나, 이력(히스테리시스) 없이 대칭이라 당겼다
       놓으면 그대로 되돌아온다. */
    const hi = coastHiOn && z >= COAST_SW;
    coastVis("coasthi-case", hi);
    coastVis("coasthi", hi);
    coastVis("coast-case", !hi);
    coastVis("coast", !hi);
}

// ─────────────────────────────────────────────────────────────────────
// 모델 격자 보기
//
// 세 모델은 격자가 저마다 다르다 — WRF 는 램버트 투영 위의 곡선격자
// 360×360, SWAN 은 경위도 등간격 720×712, MOHID 는 360×356. 값이 왜 이
// 자리에서 꺾이는지, 왜 모델마다 해안 근처 모양이 다른지는 격자를 봐야
// 설명이 된다. 그래서 **솎지 않고 그 모델 격자를 그대로** 긋는다.
//
// 선은 격자점을 지난다 (값이 실제로 놓인 자리). 등간격 격자는 메르카토르
// 에서 위도선·경도선이 곧은 직선이라 줄 하나가 끝점 두 개면 끝난다 —
// SWAN 도 1432줄 × 2점이다. WRF 만 곡선이라 점을 다 싣는다(약 26만 점).
//
// 한 번 만들면 들고 있는다. 줌을 바꿔도 다시 만들 이유가 없다.
// ─────────────────────────────────────────────────────────────────────
const gridCache = {};

/** 지금 화면에 걸린 프레임의 코드판. 0 이 곧 "값 없음"(해양모델은 육지)이다.
    격자를 그 모양대로 오려 내는 데 쓴다. 프레임마다 조금씩 달라질 수 있는
    값이지만(간·조석으로 마르고 잠기는 칸), 격자는 어차피 참고용이라
    지금 보고 있는 프레임 하나로 충분하다. */
function fieldMask(m) {
    const c = S.cpu && S.cpu.codes;
    if (!c || S.model !== m) return null;
    const g = store.grids[m];
    return g && c.length === g.nx * g.ny ? c : null;
}

function gridLines(m) {
    const mask = fieldMask(m);
    /* 마스크를 못 얻은 채로 만든 판은 캐시에 남기지 않는다. 값이 오기 전에
       격자를 켜면 육지까지 그어지는데, 그게 그대로 굳으면 안 된다. */
    const key = mask ? m : m + "?";
    if (gridCache[key]) return gridCache[key];
    const g = store.grids[m];
    if (!g) return EMPTY_FC;
    const lines = [];

    if (g.kind === "regular") {
        const nx = g.nx, ny = g.ny;
        const X = (i) => g.lon0 + i * g.dlon;
        const Y = (j) => g.lat0 + j * g.dlat;
        /* 값이 있는 칸만 잇는다. 해양모델은 육지가 통째로 결측이라, 안 오리면
           내륙 한복판까지 격자가 그어져 "여기도 계산한다"는 거짓말이 된다.
           칸마다 토막을 하나씩 내면 백만 개가 되므로, 이어지는 구간은 한 줄로
           묶는다 (SWAN 720x712 가 5천 줄 남짓으로 떨어진다). */
        const run = (n, wet, pt) => {
            let a = -1;
            for (let k = 0; k <= n; k++) {
                const w = k < n && wet(k);
                if (w && a < 0) a = k;
                else if (!w && a >= 0) {
                    if (k - a >= 2) lines.push([pt(a), pt(k - 1)]);
                    a = -1;
                }
            }
        };
        for (let i = 0; i < nx; i++)
            run(ny, (j) => !mask || mask[j * nx + i] !== 0, (j) => [X(i), Y(j)]);
        for (let j = 0; j < ny; j++)
            run(nx, (i) => !mask || mask[j * nx + i] !== 0, (i) => [X(i), Y(j)]);
    } else {
        const ll = S.lonlat[m];
        if (!ll) return EMPTY_FC;               // 곡선격자 경위도를 아직 못 받았다
        const nx = g.nx, ny = g.ny;
        const r = (v) => Math.round(v * 1e4) / 1e4;      // 약 10m. 문자열을 반으로 줄인다
        for (let j = 0; j < ny; j++) {
            const row = new Array(nx);
            for (let i = 0; i < nx; i++) {
                const k = (j * nx + i) * 2;
                row[i] = [r(ll[k]), r(ll[k + 1])];
            }
            lines.push(row);
        }
        for (let i = 0; i < nx; i++) {
            const col = new Array(ny);
            for (let j = 0; j < ny; j++) {
                const k = (j * nx + i) * 2;
                col[j] = [r(ll[k]), r(ll[k + 1])];
            }
            lines.push(col);
        }
    }

    gridCache[key] = { type: "FeatureCollection", features: [{
        type: "Feature", properties: {},
        geometry: { type: "MultiLineString", coordinates: lines } }] };
    return gridCache[key];
}

function updateGridLines() {
    if (!map || !map.getSource || !map.getSource("gridlines")) return;
    const on = !!(el.gridCheck && el.gridCheck.checked);
    map.setLayoutProperty("gridlines", "visibility", on ? "visible" : "none");
    if (!on) return;
    try { map.getSource("gridlines").setData(gridLines(S.model)); }
    catch (e) { console.warn("격자를 못 만들었다", e); }
}

// ─────────────────────────────────────────────────────────────────────
// 시간 막대 눈금
// ─────────────────────────────────────────────────────────────────────
function buildTicks() {
    const parts = [];
    for (let s = 0; s < NSTEP; s++) {
        const k = kstParts(store.time(s, S.model));
        if (k.h % 6) continue;
        const x = (100 * s / (NSTEP - 1)).toFixed(3);
        const day = k.h === 0;
        parts.push(`<i class="${day ? "day" : ""}" style="left:${x}%"></i>`);
        if (day) parts.push(`<b style="left:${x}%">${k.M}/${k.D}</b>`);
    }
    el.ticks.innerHTML = parts.join("");

    /* 앞머리 과거 구간에 음영을 깐다. 안 그러면 어디까지가 지난 예보고
       어디부터 이번 사이클인지 화면에서 알 길이 없다. */
    const np = pastSteps();
    if (el.pastband) {
        el.pastband.hidden = np <= 0;
        el.pastband.style.width = `${(100 * np / (NSTEP - 1)).toFixed(3)}%`;
        el.pastband.title = `직전 사이클 예보 (${np}시간)`;
    }

    /* 꼬리 구간: 이 모델의 예보가 안 닿는 곳. 시간축은 가장 새 사이클
       하나로 통일했으므로 뒤처진 모델은 오른쪽이 빈다. */
    if (el.noband) {
        const last = store.lastStep(S.model);
        const gap = NSTEP - 1 - last;
        el.noband.hidden = gap <= 0;
        if (gap > 0) {
            el.noband.style.width = `${(100 * gap / (NSTEP - 1)).toFixed(3)}%`;
            el.noband.title = `${store.cycleOf(S.model)} 사이클 — 여기부터는 예보가 없다`;
        }
    }

    // 지금 시각 표시. 최신 사이클은 12 UTC 시작이라 보통 막대 앞쪽에 걸린다.
    const s = (Date.now() - store.time(0, S.model).getTime()) / 1000 / store.manifest.dt;
    if (s >= 0 && s <= NSTEP - 1) {
        el.nowmark.hidden = false;
        el.nowmark.style.left = `calc(${(100 * s / (NSTEP - 1)).toFixed(3)}% - 1px)`;
        el.nowmark.title = "현재 시각";
    } else {
        el.nowmark.hidden = true;
    }
    return s;
}

// ─────────────────────────────────────────────────────────────────────
// 지도
// ─────────────────────────────────────────────────────────────────────
/* CARTO 무료 타일. 이용 조건이 출처 표기라서 키와 표기를 한 자리에 둔다.
   질의 인자는 반드시 ?key= 다 — ?api_key= 로 적으면 CARTO 가 오류 대신
   "API KEY REQUIRED" 워터마크가 박힌 타일을 200 으로 내려보낸다. */
const CARTO_KEY = "cb1_29gx_1_2a08845f3ed1fa5de0e1831c";
const CARTO_ATTRIB =
    '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">' +
    'OpenStreetMap</a> contributors © <a href="https://carto.com/attributions" ' +
    'target="_blank" rel="noopener">CARTO</a>';

/* 위성영상. Esri World Imagery 는 키 없이 쓸 수 있고 우리 해역 해상도가
   충분하다. 어두운 지도만으로는 섬·해안 지형이 안 보인다는 얘기가 있어
   레퍼런스처럼 갈아 끼울 수 있게 둘 다 얹고 보이기만 바꾼다 (원본을
   갈아치우면 커스텀 레이어가 통째로 다시 만들어져 화면이 한 번 깜빡인다). */
const ESRI_TILES = ["https://server.arcgisonline.com/ArcGIS/rest/services/"
                    + "World_Imagery/MapServer/tile/{z}/{y}/{x}"];
const ESRI_ATTRIB = 'Tiles © <a href="https://www.esri.com/" target="_blank"'
    + ' rel="noopener">Esri</a> · Maxar, Earthstar Geographics';

function mapStyle() {
    const t = (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`;
    return {
        version: 8,
        sources: {
            carto: { type: "raster", tiles: ["a", "b", "c", "d"].map(t),
                     tileSize: 256, attribution: CARTO_ATTRIB },
            /* 해안선. 바탕 지도와 같은 CARTO 벡터 타일에서 뽑아 구워 둔
               한 겹이다 (pipeline/make_coast.py). 같은 자료라 바탕과 어긋나지
               않는다.

               왜 벡터 타일을 앱에서 바로 긋지 않는가. 그렇게 했다가 동해
               한가운데에 노란 작대기가 그어졌다 — 벡터 타일의 바다 폴리곤은
               타일 안에서 여러 조각으로 쪼개져 오고, 그 쪼갠 자리가 고리의
               변으로 남는다. 칠하면 안 보이지만 테두리를 그리면 보인다.
               앱에는 변 하나를 골라 뺄 방법이 없어서 굽는 쪽으로 옮겼다. */
            coast: { type: "geojson", data: store.url("coast.geojson"),
                     tolerance: 0.2, buffer: 64 },
            /* 확대용 촘촘한 판. 처음에는 비워 두고, 당기기 시작하면 그때
               받아 넣는다 (syncCoast). 성긴 판과 겹쳐 놓고 줌에 따라 서로
               녹아들게 한다 — 갈아끼우면 어느 한 줌에서 해안선이 통째로
               "확" 바뀌어 눈에 거슬린다. */
            coasthi: { type: "geojson", data: EMPTY_FC,
                       tolerance: 0.2, buffer: 64 },
            gridlines: { type: "geojson",
                         data: { type: "FeatureCollection", features: [] } },
            esri: { type: "raster", tiles: ESRI_TILES, tileSize: 256,
                    maxzoom: 19, attribution: ESRI_ATTRIB },
            // 등치선 라벨. 내용은 apply() 가 매 시각 갈아 끼운다.
            //   tolerance 0 — 기본값 0.375 는 줌이 낮을수록 꼭짓점을 세게 솎는데,
            //   그러면 같은 곡률이 몇 안 되는 꼭짓점에 몰려 text-max-angle 에
            //   걸리고 라벨이 통째로 사라진다. 축소했을 때만 숫자가 안 보이던
            //   까닭이 이것이다. 라벨용 선은 이미 CPU 에서 간략화해 두었다.
            isoline: { type: "geojson", data: EMPTY_FC, tolerance: 0, buffer: 96 },
        },
        // 숫자 라벨용 글리프. 남의 CDN 을 물면 그쪽이 죽는 날 등압선 값이
        // 통째로 사라지므로 0~255 한 벌(41KB)만 우리 쪽에 담아 쓴다.
        glyphs: "assets/fonts/{fontstack}/{range}.pbf",
        layers: [
            { id: "bg", type: "background", paint: { "background-color": "#070b12" } },
            { id: "basemap", type: "raster", source: "carto",
              paint: { "raster-opacity": 0.92 } },
            /* 위성은 그대로 두면 색칠판보다 눈에 띈다. 살짝 어둡게 깔아
               예측장이 위에서 읽히게 한다. */
            { id: "basemap-esri", type: "raster", source: "esri",
              layout: { visibility: "none" },
              paint: { "raster-opacity": 0.78, "raster-brightness-max": 0.86,
                       "raster-saturation": -0.15 } },
            /* 커스텀 레이어 둘은 coast-case **앞에** 끼워 넣는다 (addLayer 의
               두 번째 인자). 그래야 해안선이 색칠판 위에 남는다.

               해안선을 두 겹으로 긋는다. 밝은 선 하나로는 해면기압처럼
               한가운데가 흰 색상표(rdbu_r) 위에서 흰 선이 흰 바탕에 묻혀
               해안이 어디인지 안 보인다. 반대로 어두운 선 하나로 바꾸면
               MOHID·SWAN 처럼 육지가 어두운 바탕 그대로일 때 묻힌다.
               어두운 테두리 + 밝은 심 조합이면 어느 쪽 바탕에서도 한쪽은
               반드시 대비가 산다 — 지도에서 오래 쓰는 방법이다. */
            /* class 로 바다만 고른다. water 층에는 강(river)·호수(lake)도
               같이 들어 있어서, 안 거르면 내륙 하천이 죄다 노란 선이 된다. */
            { id: "coast-case", type: "line", source: "coast",
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                  "line-color": "#060b12",
                  "line-opacity": 0.3,
                  "line-width": ["interpolate", ["linear"], ["zoom"],
                                 3, 2.6, 6, 3.6, 9, 4.8, 13, 6.0],
              } },
            { id: "coast", type: "line", source: "coast",
              layout: { "line-cap": "round", "line-join": "round" },
              paint: {
                  // 등압선과 헷갈리지 않게 세 가지를 다르게 둔다 — 색(따뜻한
                  // 미색 vs 검정), 굵기(등압선의 두 배 남짓), 그리고 어두운
                  // 윤곽선. 예전엔 어두운 테가 굵고 밝은 심이 가늘어서
                  // 해안선 자체가 "어두운 가는 선", 곧 등압선처럼 보였다.
                  "line-color": "#ffe4a8",
                  // 배경이 어둡든(카토) 밝든(위성) 같은 세기로 둔다. 예전에는
                  // 어두운 지도에서만 0.96 로 태웠는데 노란 테가 너무 튀었다.
                  "line-opacity": 0.45,
                  "line-width": ["interpolate", ["linear"], ["zoom"],
                                 3, 1.3, 6, 1.9, 9, 2.6, 13, 3.4],
              } },
            /* 촘촘한 판. 성긴 판과 **번갈아** 켠다 (syncCoast, z8 경계).
               생김새·굵기·투명도를 성긴 판과 똑같이 두어야 갈아끼울 때
               해안선이 진해지거나 옅어지지 않고 자세해지기만 한다. */
            { id: "coasthi-case", type: "line", source: "coasthi",
              layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
              paint: {
                  "line-color": "#060b12",
                  "line-opacity": 0.3,
                  "line-width": ["interpolate", ["linear"], ["zoom"],
                                 3, 2.6, 6, 3.6, 9, 4.8, 13, 6.0],
              } },
            { id: "coasthi", type: "line", source: "coasthi",
              layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
              paint: {
                  "line-color": "#ffe4a8",
                  "line-opacity": 0.45,
                  "line-width": ["interpolate", ["linear"], ["zoom"],
                                 3, 1.3, 6, 1.9, 9, 2.6, 13, 3.4],
              } },
            /* 모델 격자. 색칠판 위, 해안선과 같은 층에 얹는다. 어느 격자로
               계산된 값을 보고 있는지 눈으로 확인하라는 층이라 아주 얇고
               희미하게 긋는다 — 진하면 색을 읽는 데 방해가 된다. */
            { id: "gridlines", type: "line", source: "gridlines",
              layout: { visibility: "none", "line-join": "round" },
              paint: {
                  "line-color": "#9fd8ff",
                  // 솎지 않은 진짜 격자라 축소하면 줄이 픽셀보다 촘촘해진다.
                  // 그때는 아주 흐리게 깔아 자료를 가리지 않게 하고, 당길수록
                  // 또렷해지게 둔다.
                  "line-opacity": ["interpolate", ["linear"], ["zoom"],
                                   5, 0.10, 8, 0.26, 11, 0.42, 13, 0.55],
                  "line-width": ["interpolate", ["linear"], ["zoom"],
                                 5, 0.4, 9, 0.6, 13, 1.0],
              } },
            /* 등치선 값. 선 위에 눕히고, 겹치면 지우고, 뒤집히지 않게 세우는
               일을 심볼 레이어가 알아서 한다. 굵은 선(20hPa 배수)은 한 급
               크게 뽑아 1000·1020 을 먼저 찾게 한다.

               줌에 따라 세 가지를 같이 움직인다. 축소하면 같은 등압선이
               화면에서 짧아지므로 (1) 라벨 간격을 좁혀 짧은 선에도 하나는
               앉게 하고, (2) 허용 꺾임각을 늘려 촘촘히 굽은 선을 포기하지
               않게 하고, (3) 글자를 줄여 곧은 구간을 찾기 쉽게 한다. */
            { id: "iso-label", type: "symbol", source: "isoline",
              layout: {
                  "symbol-placement": "line",
                  "text-field": ["get", "label"],
                  "text-font": ["KOOS1"],   // 깨진 판이 캐시에 남아 이름을 올렸다
                  "text-size": ["interpolate", ["linear"], ["zoom"],
                                3, ["case", ["==", ["get", "bold"], 1], 10.5, 9.5],
                                7, ["case", ["==", ["get", "bold"], 1], 12.5, 11]],
                  "text-letter-spacing": 0.02,
                  "symbol-spacing": ["interpolate", ["linear"], ["zoom"],
                                     3, 90, 5, 140, 7, 200, 9, 260],
                  "text-max-angle": ["interpolate", ["linear"], ["zoom"],
                                     3, 85, 6, 60, 9, 45],
                  "text-padding": 1,
                  "text-rotation-alignment": "map",
                  "text-pitch-alignment": "viewport",
                  "text-allow-overlap": false,
                  "symbol-avoid-edges": false,
              },
              paint: {
                  "text-color": "#f2f7ff",
                  "text-halo-color": "rgba(5,9,15,.92)",
                  "text-halo-width": 1.7,
                  "text-halo-blur": 0.3,
              } },
        ],
    };
}

const EMPTY_FC = { type: "FeatureCollection", features: [] };

/* 등치선 라벨을 다시 만든다.

   셰이더가 그린 선에는 값이 없다. 1004 인지 1008 인지는 선을 세어야 아는데
   기준점이 화면에 없으면 셀 수가 없다 — 그래서 같은 자료를 CPU 로 한 번 더
   훑어 꺾은선을 만들고 그 위에 숫자를 앉힌다.

   재생 중에는 건너뛴다. 시간당 30~40ms 를 더 쓰면 눈에 띄게 끊기는데,
   흘러가는 화면에서 숫자를 읽는 사람은 없다. 멈추면 그때 그린다. */
let isoTimer = 0, isoEmpty = true;
/* 빈 자료를 다시 밀어 넣는 것도 공짜가 아니다. setData 는 GeoJSON 을 맵
   일꾼으로 보내 타일을 다시 뜨게 한다 — 재생 중에는 정시마다 이걸 하고
   있었다. 이미 비어 있으면 그냥 지나간다. */
function setIso(src, data) {
    const empty = data === EMPTY_FC;
    if (empty && isoEmpty) return;
    isoEmpty = empty;
    src.setData(data);
}
function updateIsolines(delay = 60) {
    if (isoTimer) clearTimeout(isoTimer);
    isoTimer = setTimeout(() => {
        isoTimer = 0;
        const src = map && map.getSource("isoline");
        if (!src) return;
        const sp = store.spec(S.model, S.varName);
        if (!sp.iso || !S.cpu || S.cpu.isDir || S.playing) { setIso(src, EMPTY_FC); return; }
        try {
            setIso(src, isolineGeoJSON(store.grids[S.model], S.cpu.codes, S.cpu.raw,
                                       sp.iso, sp.isob || 0, S.lonlat[S.model] || null));
        } catch (e) {
            console.warn("등치선 라벨을 못 만들었다", e);
            setIso(src, EMPTY_FC);
        }
    }, delay);
}

function initMap() {
    // 세 모델 도메인을 다 담는 상자. 모델을 바꿔도 시점은 그대로 둔다.
    let s = 90, w = 180, n = -90, e = -180;
    for (const m of store.manifest.model_order) {
        const b = store.grids[m].bounds;
        s = Math.min(s, b[0][0]); w = Math.min(w, b[0][1]);
        n = Math.max(n, b[1][0]); e = Math.max(e, b[1][1]);
    }
    /* 폰 화면은 3배율이 흔하다. 그대로 그리면 픽셀이 데스크톱의 두 배 넘게
       나오는데, 그걸 감당할 GPU 는 그 안에 없다 — 입자가 뚝뚝 끊긴다.
       2배로 눌러도 눈으로는 거의 구별이 안 되고 그릴 양은 절반 이하가 된다.
       (입자 굵기는 render.js 가 그리기 버퍼에서 직접 재므로 같이 따라온다.) */
    const dprCap = (window.innerWidth <= 900 && (window.devicePixelRatio || 1) > 2)
                 ? 2 : 0;

    map = new maplibregl.Map({
        container: "map", style: mapStyle(),
        center: [(w + e) / 2, (s + n) / 2], zoom: 6,
        minZoom: 3, maxZoom: 13,
        dragRotate: false, pitchWithRotate: false, renderWorldCopies: false,
        attributionControl: { compact: true },
        ...(dprCap ? { pixelRatio: dprCap } : {}),
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    if (map.touchZoomRotate) map.touchZoomRotate.disableRotation();
    // 주소줄에 시점이 실려 있으면 그 자리로 연다. 없을 때만 전체 도메인.
    const hv = readHash();
    if (hv.c && hv.z) map.jumpTo({ center: hv.c, zoom: hv.z });
    else map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0 });
    map.on("moveend", writeHash);

    /* zoomend 만 물면 휠을 굴리는 동안에는 아무 일도 안 하다가 손을 뗄 때
       한꺼번에 바뀐다. 투명도는 줌 식이라 저절로 따라오지만, 자료를 받고
       레이어를 켜는 일은 여기서 해야 해서 zoom 도 같이 문다. */
    map.on("zoom", syncCoast);
    map.on("zoomend", syncCoast);

    map.on("load", () => {
        syncCoast();
        map.addLayer({
            id: "koos-field", type: "custom", renderingMode: "2d",
            onAdd(_m, gl) { ren.init(gl); glReady(); },
            render(gl, matrix) { ren.renderField(gl, matrix); },
        }, "coast-case");
        map.addLayer({
            id: "koos-flow", type: "custom", renderingMode: "2d",
            render(gl, matrix) { ren.renderFlow(gl, matrix); },
        }, "coast-case");
        syncView(true);
    });

    /* 입자는 경위도 공간에서 굴러가므로 지도를 움직여도 꼬리를 지울 필요가
       없다. 다만 걸음·꼬리 길이가 줌에 걸려 있어서 시점은 계속 알려 준다.
       태어날 자리 다시 뽑기는 손을 뗀 뒤에만 (수천 번 격자 조회라 비싸다). */
    map.on("move", () => syncView(false));
    map.on("moveend", () => syncView(true));
    map.on("mousemove", (e) => { S.hover = e.lngLat; showStatus(); });
    map.on("mouseout", () => { S.hover = null; showStatus(); });

    /* 지도를 누르면 그 자리의 세 모델 값을 한 창에 띄운다. 관측소 점을
       눌렀을 때는 비켜 준다 — 그쪽은 검증 패널이 이미 맡고 있다. */
    map.on("click", (e) => {
        const hit = ["obst-on", "obst-sel"].filter((id) => map.getLayer(id));
        if (hit.length && map.queryRenderedFeatures(e.point, { layers: hit }).length) return;
        pinfo.open(e.lngLat);
    });
}

// ─────────────────────────────────────────────────────────────────────
// 배선
// ─────────────────────────────────────────────────────────────────────
function wire() {
    el.play.addEventListener("click", () => setPlaying(!S.playing));
    /* 손으로 끌 때는 **정시에 딱 선다**. 막대의 step 은 0.05 인데, 그건
       재생 중에 손잡이가 미끄러지게 하려고 잘게 쪼개 둔 것이지 사람이
       3분 단위로 시각을 고르라는 뜻이 아니다. 정시가 아닌 데 세워 놓으면
       시계가 반올림한 시각을 적어 화면과 숫자가 어긋나기도 한다.
       그래서 들어온 값은 반올림해서 되돌려 쓴다 (syncSlider=true). */
    el.range.addEventListener("input", () => setTime(Math.round(+el.range.value)));
    /* 막대 step 이 0.05 라 화살표를 누르면 3분씩 간다 — 그건 쓸모가 없다.
       막대에 손이 가 있을 때도 한 시간씩 움직이게 가로챈다. */
    el.range.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1,
                    PageUp: 6, PageDown: -6 }[e.key];
        if (!d) return;
        e.preventDefault();
        setPlaying(false);
        setTime(Math.round(S.t) + d);
    });
    el.speed.addEventListener("change", () => { S.speed = +el.speed.value; });

    el.vecCheck.addEventListener("change", () => {
        S.vecOn = el.vecCheck.checked;
        ren.flowOn = S.vecOn;
        map.triggerRepaint();
    });
    el.vecDensity.addEventListener("change", () => {
        ren.setDensity(+el.vecDensity.value);
        map.triggerRepaint();
    });
    el.basemap.addEventListener("change", () => setBasemap(el.basemap.value));
    el.gridCheck.addEventListener("change", updateGridLines);
    el.vecFade.addEventListener("change", () => {
        ren.trailMul = +el.vecFade.value;
        map.triggerRepaint();
    });
    el.opacity.addEventListener("input", () => {
        S.opacity = +el.opacity.value;
        ren.opacity = S.opacity;
        el.opacityVal.textContent = Math.round(S.opacity * 100) + "%";
        map.triggerRepaint();
    });
    el.obsCheck.addEventListener("change", () => {
        if (obs) obs.setVisible(el.obsCheck.checked);
    });

    /* 좁은 화면에서는 레이어 패널을 접고 시작한다. 284px 짜리가 열린 채로
       뜨면 폰에서는 지도의 3분의 1이 가려진 채 첫인상이 결정된다. class 를
       CSS 로 넣지 않고 여기서 넣는 이유는 단추 상태(.on)와 어긋나면 한 번
       눌러야 겨우 맞기 때문이다. */
    if (window.innerWidth < 720) {
        el.panel.classList.add("closed");
        el.btnPanel.classList.remove("on");
    }

    /* 폰에서는 레이어와 관측검증이 **같은 자리**에 눕는다 (시간막대 위 서랍).
       둘 다 열면 뒤엣것이 안 보이는 채로 살아 있어 헛손질이 난다. 하나만. */
    const narrow = () => !!(window.matchMedia
                            && window.matchMedia("(max-width:640px)").matches);
    const shutPanel = () => {
        el.panel.classList.add("closed");
        el.btnPanel.classList.remove("on");
    };

    const togglePanel = () => {
        el.panel.classList.toggle("closed");
        const open = !el.panel.classList.contains("closed");
        el.btnPanel.classList.toggle("on", open);
        if (open && narrow() && obs && obs.on) obs.toggle(false);
    };
    /* 패널 여닫기는 Observations 가 쥔다 — 검증 패널은 지도 표식·목록·상세가
       한 덩어리라 여는 순간 다시 그려야 할 것이 있다. 여기서 class 만 건드리면
       그게 빠진다. 아직 안 붙었을 때만(자료 실패) 최소한의 시늉을 한다. */
    const toggleObs = () => {
        if (obs) {
            obs.toggle();
            if (obs.on && narrow()) shutPanel();
            return;
        }
        const opened = el.btnObs.classList.toggle("on");
        $("obspanel").classList.toggle("closed", !opened);
    };
    el.btnPanel.addEventListener("click", togglePanel);
    el.btnObs.addEventListener("click", toggleObs);
    $("obs-x").addEventListener("click", toggleObs);
    el.btnFull.addEventListener("click", () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
    });
    el.btnHelp.addEventListener("click", () => { el.help.hidden = false; });
    el.helpX.addEventListener("click", () => { el.help.hidden = true; });
    el.help.addEventListener("click", (e) => {
        if (e.target === el.help) el.help.hidden = true;
    });

    window.addEventListener("keydown", (e) => {
        if (e.target.matches("input,select,textarea")) return;
        const k = e.key;
        if (k === " ") { e.preventDefault(); setPlaying(!S.playing); }
        else if (k === "ArrowRight") { setPlaying(false); setTime(Math.round(S.t) + 1); }
        else if (k === "ArrowLeft") { setPlaying(false); setTime(Math.round(S.t) - 1); }
        else if (k === "1" || k === "2" || k === "3")
            setModel(store.manifest.model_order[+k - 1]);
        // 변수 막대는 세로다. 위아래로 훑을 수 있어야 한 손으로 다 본다 —
        // 지금까지는 변수를 바꾸려면 반드시 마우스를 써야 했다.
        else if (k === "ArrowUp" || k === "ArrowDown") { e.preventDefault(); stepVar(k === "ArrowDown" ? 1 : -1); }
        else if (k === "l" || k === "L") togglePanel();
        else if (k === "o" || k === "O") toggleObs();
        else if (k === "f" || k === "F") el.btnFull.click();
        else if (k === "b" || k === "B")
            setBasemap(S.base === "esri" ? "carto" : "esri");
        else if (k === "g" || k === "G") {
            el.gridCheck.checked = !el.gridCheck.checked;
            updateGridLines();
        }
        else if (k === "?" || k === "/") el.help.hidden = !el.help.hidden;
        else if (k === "Escape") {
            // 안쪽부터 닫는다: 도움말 → 관측소 상세 → 검증 패널
            if (!el.help.hidden) el.help.hidden = true;
            else if (obs && obs.detailOpen) $("ob-dx").click();
            else if (obs && obs.on) obs.toggle(false);
        }
    });

    /* 시간막대의 **실측** 높이를 CSS 로 흘려 준다. 범례·지도 단추·서랍이
       전부 이 높이 위에 얹힌다. 폰에서는 막대가 두 줄로 접혀 90px 을 넘고,
       가로보기에서는 다시 한 줄이 된다 — 숫자로 박아 두면 그때마다 겹친다. */
    const measureBar = () => {
        const h = el.timebar.offsetHeight;
        if (h) document.documentElement.style.setProperty("--tbh", h + "px");
    };
    measureBar();
    if (window.ResizeObserver) new ResizeObserver(measureBar).observe(el.timebar);

    window.addEventListener("resize", () => { syncTabs(); buildTicks(); measureBar(); });
    /* 폰을 돌리면 resize 가 늦게 오거나 옛 크기로 온다. 방향 전환은 따로 문다. */
    if (typeof screen !== "undefined" && screen.orientation
        && screen.orientation.addEventListener)
        screen.orientation.addEventListener("change", () => setTimeout(() => {
            syncTabs(); buildTicks(); measureBar();
        }, 150));
}

let last = 0;
function tick(ts) {
    requestAnimationFrame(tick);
    const raw = last ? ts - last : 0;          // 자르기 전 진짜 간격
    if (raw > frameWorst) frameWorst = raw;
    const d = last ? Math.min(120, raw) : 0;
    last = ts;
    if (S.playing) {
        /* 다음 칸 자료가 아직 안 걸렸으면 **시계를 붙잡는다**.
           그냥 밀면 섞기 비율(ren.tf = S.t - S.loaded)이 1 에 붙어 색칠판만
           멈춰 서 있다가 자료가 오는 순간 다시 달린다 — 눈에는 그게 "툭"
           하고 끊기는 것으로 보인다. 입자는 제 속도로 적분되니 같은 정체를
           겪어도 티가 안 난다. 그래서 색칠판만 끊겨 보였다.
           배속이 높으면 더 나쁘다. 자료가 오기 전에 S.step 이 두 칸 넘어가
           뒤늦은 apply 를 gen 이 버리므로 아예 한 칸을 통째로 건너뛴다.
           느려질지언정 건너뛰지는 않게 한다 (레퍼런스의 playBusy 와 같다).
           pending 이 0 이면 — 불러오기가 터졌든 뭐든 — 붙잡지 않는다. */
        /* 딱 멈추지 말고 **천천히 늦춘다.** 예전에는 다음 칸이 안 왔으면
           시계를 그 자리에 세웠다. 자료가 오는 순간 원래 속도로 다시
           달리니, 정지→전속의 계단이 그대로 눈에 보였다 — 그게 "툭" 이다.
           이제는 섞임 비율이 0.75 를 넘어서면서부터 속도를 0 까지 부드럽게
           깎는다. 자료가 제때 오면 이 구간은 아예 안 밟는다 (0.75 전에
           다음 칸이 걸리므로 rate 는 계속 1 이다). 늦어도 급정거 대신
           감속이라 눈에는 잠깐 느려진 것으로만 보인다. */
        let rate = 1;
        if (sPending > 0 && S.loaded >= 0) {
            const behind = S.t - S.loaded;      // 0~1 이 정상
            if (behind > 0.75) rate = Math.max(0, (1 - behind) / 0.25);
        }
        if (rate > 0) {
            let t = S.t + rate * d / (900 / S.speed);  // 1× = 예측 1시간에 0.9초
            if (t >= NSTEP - 1) t = 0;
            setTime(t);
        }
    }
    if (S.loaded >= 0) ren.tf = Math.max(0, Math.min(1, S.t - S.loaded));
    if (map && (S.playing || (S.vecOn && ren.flowOn))) map.triggerRepaint();
    perfTick(ts);
}

/* 화면갱신률. 스텝 사이 섞임이 몇 단계로 보이는지가 여기서 정해진다 —
   4배속이면 한 스텝이 0.22초라 30fps 면 일곱 단계, 12fps 면 세 단계다.
   재생이 계단처럼 보인다는 말이 나오면 여기 숫자부터 봐야 한다.
   (도움말 ? 안에만 적는다. 화면에는 안 내민다.) */
let perfN = 0, perfT0 = 0, perfFps = 0;
/* 끊김을 숫자로 잡는 두 자.
   frameWorst — 지난 1초 중 제일 길었던 프레임 간격. 60fps 면 보통 17ms 다.
                여기가 40ms 를 넘으면 눈에 "툭" 으로 보인다.
   upWorst    — 정시마다 도는 setScalar(판 올리기) 에 든 시간. 이게 크면
                범인은 GPU 업로드고, 작은데 frameWorst 가 크면 범인은 딴 데다
                (지도 다시 그리기·GC). 둘을 나란히 봐야 어디를 고칠지 안다. */
let frameWorst = 0, upMs = 0, upWorst = 0;
function perfNow() {
    return (typeof performance !== "undefined" && performance.now)
        ? performance.now() : 0;
}
function perfTick(ts) {
    perfN++;
    if (!perfT0) { perfT0 = ts; return; }
    if (ts - perfT0 < 1000) return;
    perfFps = Math.round((perfN * 1000) / (ts - perfT0));
    perfN = 0; perfT0 = ts;
    const fw = frameWorst, uw = upWorst;
    frameWorst = 0; upWorst = 0;
    if (el.help.hidden || !el.helpPerf) return;
    el.helpPerf.textContent =
        `화면 ${perfFps}fps · 최악 프레임 ${fw.toFixed(0)}ms · 정시 판올리기 ${uw.toFixed(1)}ms` +
        ` · 섞임 ${ren.tf.toFixed(2)} · 대기 ${pending} · 회선 ${store.inflight()}` +
        ` · 배속 ${S.speed}x (한 스텝 ${Math.round(900 / S.speed)}ms, 섞임 ${Math.max(1, Math.round(perfFps * 0.9 / S.speed))}단계)`;
}

// ─────────────────────────────────────────────────────────────────────
async function boot() {
    await store.init();
    const mf = store.manifest;
    NSTEP = mf.nstep;
    el.range.max = String(NSTEP - 1);
    el.range.step = "0.05";     // 재생 중 손잡이가 미끄러지게 (HTML 과 같은 값)

    el.helpFine.textContent =
        `자료 생성 ${mf.generated} · 사이클 ` +
        mf.model_order.map((m) => `${m} ${mf.models[m].cycle || mf.cycle}`).join(" / ") +
        ` · 격자는 모델 원본 그대로 (WRF 360×360 곡선, SWAN 720×712, MOHID 360×356)`;

    // 주소줄에 실린 화면을 되살린다. 없는 모델·변수는 조용히 무시한다
    // (매니페스트가 바뀌어 옛 링크가 죽어도 첫 화면은 떠야 한다).
    const hv = readHash();
    S.model = mf.models[hv.m] ? hv.m : mf.model_order[0];
    const ord = mf.models[S.model].order;
    S.varName = ord.includes(hv.v) ? hv.v : mf.models[S.model].default;
    buildModelBar();
    buildVarBar();
    syncTabs();
    updateLegend();
    updateVecLabel();

    initMap();
    /* 지점 팝업. 지도·격자 조회를 빌려 쓰므로 initMap 뒤에 만든다. */
    pinfo = new PointInfo({
        store, map,
        cellAt, cellLngLat,
        ensureGeom: ensureGeometry,
        getModel: () => S.model,
        // 시계는 Math.round 를 쓴다. floor 로 두면 재생 중 팝업만 한 시간
        // 뒤처져 보인다 (시계는 15시인데 팝업은 14시).
        getStep: () => Math.round(S.t),
        onSeek: (step) => { setPlaying(false); setTime(step); },
    });
    wire();
    await glReadyP;

    setBasemap(hv.b || S.base);
    updateGridLines();
    ren.opacity = S.opacity;
    ren.flowOn = S.vecOn;
    ren.trailMul = +el.vecFade.value;
    ren.setDensity(+el.vecDensity.value);
    syncView(true);

    // 시작 시각은 "지금"에 가장 가까운 예보 시각. 새벽에 열어도 지금이 보인다.
    const nowStep = buildTicks();
    updateCycleLabel();
    setTime(Number.isFinite(hv.t) ? hv.t
            : (nowStep >= 0 && nowStep <= NSTEP - 1 ? Math.round(nowStep) : 0));
    S.step = Math.floor(S.t);
    await apply();

    obs = new Observations(map, store, {
        /* 그래프에서 예측 구간을 누르면 그 시각으로 간다. 그래프와 색칠판이
           같은 시각을 보게 하는 유일한 고리라, 재생 중이면 먼저 세운다 —
           안 그러면 옮겨 놓자마자 다음 프레임이 덮어쓴다. */
        onSeek: (step) => { setPlaying(false); setTime(step); },
    });
    obs.init().then(() => {
        // 지점 팝업이 "가까운 관측소"를 찾을 때 이 목록을 본다.
        pinfo.obs = obs;
        obs.setVisible(el.obsCheck.checked);
        obs.setField(S.model, S.varName);
        obs.setCursor(S.t);
    }).catch((e) => console.warn("관측을 못 불러왔다", e));

    requestAnimationFrame(tick);
    watchCycle();
    el.boot.classList.add("gone");
    setTimeout(() => { el.boot.hidden = true; }, 600);
}

/* 새 예보가 나왔는지 지켜본다.

   예측장은 날마다 **같은 경로에 덮어쓴다.** 탭을 열어 둔 채 하루가 지나면
   화면은 어제 시간축(어제 사이클)을 그대로 붙들고 있는데 서버 파일은 이미
   오늘 것이라, 시간축과 자료가 어긋난 채로 보인다 — "예측이 30일 21시까지
   밖에 없네" 같은 소리가 여기서 나온다 (그 탭의 사이클이 2026082612 였다).
   매니페스트만 이따금 다시 읽어 사이클이 바뀌었으면 알려 준다.

   저절로 새로고침하지는 않는다. 보던 자리가 통째로 날아가는 게 더 나쁘다.
   주소줄에 모델·변수·시각·화면이 실려 있으므로 눌러서 새로고침하면 보던
   자리 그대로 새 예보로 돌아온다. */
const CYCLE_POLL_MS = 10 * 60 * 1000;
function watchCycle() {
    let told = false;
    setInterval(async () => {
        if (told) return;
        let mf;
        try {
            const r = await fetch(`${store.base}/manifest.json`, { cache: "no-cache" });
            if (!r.ok) return;
            mf = await r.json();
        } catch (e) { return; }            // 회선이 잠깐 끊긴 것뿐이다
        if (!mf || !mf.cycle || mf.cycle === store.manifest.cycle) return;
        told = true;
        newCycleBanner(mf.cycle);
    }, CYCLE_POLL_MS);
}

function newCycleBanner(cycle) {
    const d = document.createElement("div");
    d.className = "newcyc";
    const c = String(cycle);
    d.innerHTML = `<b>새 예보가 나왔습니다</b> ${+c.slice(4, 6)}/${+c.slice(6, 8)} `
                + `${c.slice(8, 10)}UTC 초기장 · 눌러서 새로고침`;
    d.addEventListener("click", () => location.reload());
    document.body.appendChild(d);
}

boot().catch((e) => {
    console.error(e);
    el.boot.innerHTML =
        `<div class="boot-in" style="color:var(--warn)">불러오지 못했습니다 — ${e.message}</div>`;
});

/* 시험용 손잡이. 브라우저에서는 아무도 안 쓴다. deploy/boottest.mjs 가
   청크 캐시를 비우고 "찬 상태에서 재생하면 몇 프레임 멎는가" 를 재는 데만
   쓴다 — 캐시가 데워진 채로 재면 회선 지연이 안 보여 늘 매끄럽게 나온다. */
export const __test = { S, store, ren };
