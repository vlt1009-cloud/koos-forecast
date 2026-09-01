/* 관측 검증 — ref/app/obs.js 를 KOOS 예측 뷰어로 옮긴 것.

   ref 앱에서 검증이 실제로 쓸모 있었던 이유는 그래프가 예뻐서가 아니라
   **지도가 먼저 말을 해서**였다. 관측소 점을 RMSE 로 칠해 두면 어느 해역에서
   모델이 무너지는지 누르기 전에 보인다. 그래서 그 뼈대를 그대로 가져왔다:

     · 점 색 = 그 변수의 RMSE. 색 구간은 전 관측소 10~90 백분위 (computeDomains)
     · 목록  = 검색 · 정렬(RMSE↓↑/이름/위도) · 관측망 칩 · 변수 세그먼트
     · 상세  = 통계 카드 / 지금 예보 시각 값 / 그래프 / 산점도 / 주의사항
     · 그래프= 픽셀당 표본이 2개를 넘으면 min-max 포락선으로 솎아 그린다.
               2026년치 시간자료가 5천 점을 넘으므로 이게 없으면 폴리라인이
               스스로를 덮어 굵은 띠가 된다.
     · 손놀림= 끌기=밀기, 휠/집기=확대, Shift+끌기=구간확대, 두 번 누름=전체,
               누르면 그 시각으로 뷰어 이동

   ref 와 다른 곳은 세 가지다.

     1. 모델이 셋이다. 변수마다 견줄 상대는 obs_common.OBSVAR 이 정해 둔
        **한 모델**로 고정한다 (수온은 MOHID). 지도 색·목록 정렬·램프 범례가
        전부 같은 한 벌을 보게 하려는 것이다.
     2. 여기는 예측 사이트라 선이 셋이다 — 관측 / 모델 과거 / 모델 예측.
        **통계는 과거끼리만 낸다.** 예측을 섞으면 그건 검증이 아니라 자화자찬이다.
     3. 요약 통계를 앱에서 재지 않고 ts_web.py 가 stations.json 에 미리 넣는다.
        목록을 그리자고 196개 시계열 19MB 를 받을 수는 없다.

   시간축은 EPOCH(2026-01-01 00 UTC) 부터의 정시 색인이다. 관측·모델과거는
   payload.t0 에서 시작하고, 예측은 모델마다 자기 사이클 시각에서 시작한다
   (MOHID 원본이 늦게 나오면 그 모델만 옛 사이클에 남는다). 표시는 KST. */

import { checkConvention } from "./dirconv.js";

/* RMSE 순차 램프 — 단일 색상(청록), 명도 단조 증가.
   어두운 지도 위에서 '나쁜 지점이 밝게 튀어나오도록' 방향을 잡았다. */
const RAMP = ["#2E4A5C", "#3E6B82", "#4F8FA8", "#6FB4C6", "#9AD4DE", "#D3EEF2"];
const NO_DATA = "#3a4250";

/* 관측은 **자홍**이다. 예전 파랑은 WRF 색(--wrf, 밝은 하늘색)과 거의 구별이
   안 됐고, 흰색으로 빼 봤더니 눈금·글씨와 섞여 볼품이 없었다. 모델 셋
   (하늘·민트·주황) 어느 쪽과도 색상환에서 가장 먼 자리가 여기다. */
const C_OBS = "#ff4fa3";                  // 관측
// 관측이 자홍으로 옮겨 왔으니 이 세로선은 비켜 준다 (보라).
const C_NOW = "rgba(178,142,255,.9)";     // 지금 보고 있는 예보 시각

/* 모델 색 — 지도 좌상단 모델 단추와 같은 색 (style.css 의 --wrf/--swan/
   --mohid). 거기서 읽어 오므로 한쪽만 고쳐 어긋날 일이 없다. */
const MORDER = ["wrf", "swan", "mohid"];
const MCOL_FB = { wrf: "#5bc8ff", swan: "#7ee0a8", mohid: "#ffb454" };
const MCOL = {};
function mcol(m) {
    if (m in MCOL) return MCOL[m];
    let v = "";
    try {
        v = getComputedStyle(document.documentElement)
            .getPropertyValue("--" + m).trim();
    } catch (e) { v = ""; }
    return (MCOL[m] = v || MCOL_FB[m] || "#93a2b8");
}
/** 같은 색을 옅게. 과거(검증)선은 예측선보다 한 톤 죽인다. */
function mcolA(m, a) {
    const c = mcol(m);
    const h = /^#([0-9a-f]{6})$/i.exec(c);
    if (!h) return c;
    const n = parseInt(h[1], 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

/* 세그먼트 바·변수 탭 순서. 모델 갈래로 묶어 두었다(대기 → 파랑 → 해양).
   순간풍속·최대파고는 대응 모델 변수가 없어 검증이 성립하지 않으므로 뺀다. */
const VORDER = ["wspd", "wdir", "t2", "slp", "rh2",
                "hs", "tp", "tm",
                "ssh", "cspd", "cdir", "sst", "sss"];

/* stations.json 이 아직 옛 판일 때를 위한 대비표. 새 판에는 vars[v].model 이
   들어 있고 그쪽이 이긴다 — 표를 두 벌 두면 언젠가 반드시 어긋난다. */
const FALLBACK_MODEL = {
    wspd: "wrf", wdir: "wrf", t2: "wrf", slp: "wrf", rh2: "wrf",
    hs: "swan", tp: "swan", tm: "swan",
    ssh: "mohid", cspd: "mohid", cdir: "mohid", sst: "mohid", sss: "mohid",
};

/* 색칠판 변수 -> 견줄 관측 변수. 색칠판을 바꾸면 검증 변수도 따라간다. */
const FIELD2OBS = {
    "wrf.wspd": "wspd", "wrf.wdir": "wdir", "wrf.t2": "t2", "wrf.slp": "slp",
    "wrf.rh2": "rh2", "wrf.sst": "sst",
    "swan.hs": "hs", "swan.tp": "tp", "swan.tm": "tm",
    "mohid.cspd": "cspd", "mohid.cdir": "cdir", "mohid.ssh": "ssh",
    "mohid.sst": "sst", "mohid.sss": "sss",
};

const DIRVAR = new Set(["wdir", "cdir"]);
const HOUR = 3600e3;
const KSTMS = 9 * HOUR;
const PAD = { l: 52, r: 12, t: 10, b: 26 };
const NMIN = 24;                          // ts_web.skill 과 같은 값

// ─────────────────────────────────────────────────────────────────────
// 순수 함수 (selftest 가 파이썬 쪽과 대조한다)
// ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const p2 = (n) => String(n).padStart(2, "0");

function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
}

export function fmt(v, n) {
    return v == null || !isFinite(v) ? "—" : v.toFixed(n);
}

export function quantile(a, p) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const i = clamp((s.length - 1) * p, 0, s.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function niceTicks(lo, hi, want) {
    const raw = (hi - lo) / Math.max(want, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
    return out;
}

export function tickDigits(t, cap) {
    if (t.length < 2) return Math.min(cap, 2);
    const step = Math.abs(t[1] - t[0]);
    const need = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
    return Math.min(need, cap);
}

/** 관측 대 모델 성적. ts_web.skill 과 **같은 식이어야 한다.**
    방향은 원형으로 잰다 — 359도와 1도의 차이는 2도지 358도가 아니다.
    표본이 NMIN 보다 적으면 아예 내지 않는다 (몇 시간짜리 우연을 성적표로
    굳히지 않기 위해서다). */
export function recomputeStats(o, m, circular, nmin = NMIN) {
    let n = 0, so = 0, sm = 0, sd = 0, sd2 = 0, soo = 0, smm = 0, som = 0, sa = 0;
    const len = Math.min(o.length, m.length);
    for (let i = 0; i < len; i++) {
        const a = o[i], b = m[i];
        if (a == null || b == null) continue;
        let dd = b - a;
        if (circular) dd = ((dd + 180) % 360 + 360) % 360 - 180;
        n++; so += a; sm += b; sd += dd; sd2 += dd * dd; sa += Math.abs(dd);
        soo += a * a; smm += b * b; som += a * b;
    }
    if (n < nmin) return null;
    const mo = so / n, mm = sm / n;
    const vo = Math.max(soo / n - mo * mo, 0), vm = Math.max(smm / n - mm * mm, 0);
    const cov = som / n - mo * mm;
    // 관측이 내내 한 값이면 센서가 굳은 것이다 (ts_web.skill 과 같은 판정).
    if (!circular && vo < 1e-10) return null;
    return {
        n, bias: sd / n, rmse: Math.sqrt(sd2 / n), mae: sa / n,
        r: (vo > 1e-12 && vm > 1e-12) ? cov / Math.sqrt(vo * vm) : null,
        sdr: vo > 1e-12 ? Math.sqrt(vm / vo) : null,
    };
}

function stampKST(d, withHour) {
    const s = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    return withHour ? `${s} ${p2(d.getUTCHours())}:00` : s;
}

// ─────────────────────────────────────────────────────────────────────
export class Observations {
    constructor(map, store, opts = {}) {
        this.map = map;
        this.store = store;
        this.opts = opts;

        this.meta = null;
        this.latest = null;
        this.stations = [];
        this.byId = new Map();
        this.data = new Map();          // id -> 시계열 payload (한 번 받으면 둔다)

        this.v = null;                  // 지금 검증 중인 변수
        this.sel = null;                // 선택된 관측소 id
        this.pay = null;                // 그 관측소의 payload
        this.D0 = 0; this.N = 0;        // 그래프 시간축 [D0, D0+N-1] (절대 시각색인)

        this.nets = new Set();
        this.q = "";
        this.sortBy = "rmse-";          // 잘 맞는 지점부터 (index.html 의 selected 와 맞출 것)
        this.dom = {};                  // 변수 -> [RMSE 하한, 상한]
        this.mode = "time";             // "time" | "scatter"
        this.x0 = 0; this.x1 = 0;       // 보이는 구간 (소수 허용)
        this.hover = -1;

        this.on = false;                // 패널 열림
        this.dotsOn = false;            // 지도 표식 보임
        this.layered = false;
        this.field = { model: null, v: null };
        this.userVar = false;           // 사용자가 변수를 직접 골랐나
        this.cursor = 0;                // 예보 스텝
        this._curH = -1;

        this.cv = null; this.tip = null; this.ro = null;
        this.drag = null; this.pinch = null;
        this.pts = new Map();
        this.lastClk = null; this.lastClkStep = -1;

        this.ui = {
            panel: $("obspanel"), detail: $("obsdetail"),
            seg: $("ob-segbar"), q: $("ob-q"), sort: $("ob-sort"),
            chips: $("ob-chips"), cnt: $("ob-cnt"), list: $("ob-list"),
            foot: $("ob-foot"),
            nm: $("ob-nm"), meta: $("ob-meta"), body: $("ob-body"),
            now: null,          // 상세를 그릴 때마다 새로 만든다
        };
        window.addEventListener("resize", () => this._draw());
    }

    // ── 준비 ─────────────────────────────────────────────────────────
    async init() {
        const [st, lt] = await Promise.all([
            fetch("obs/stations.json", { cache: "no-cache" }).then((r) => r.json()),
            fetch("obs/latest.json", { cache: "no-cache" }).then((r) => r.json())
                .catch(() => null),
        ]);
        this.meta = st;
        this.latest = lt;
        this.epoch = Date.parse(st.epoch);

        /* 지도 쪽 표와 파이썬이 실제로 쓴 표가 같은지 본다. 어긋나면 각도가
           통째로 180도 뒤집히는데 화면은 멀쩡해 보인다. */
        this.convBad = checkConvention(st.dir_convention);

        /* 관측은 10분마다 갈리고 경로는 그대로다. 시계열 파일에 갱신 도장을
           찍어 캐시가 옛날 것을 물고 있지 않게 한다. */
        this.store.obsV = st.generated;

        this.stations = st.stations;
        for (const s of this.stations) {
            s.netname = (st.nets[s.net] || {}).label || s.net;
            if (!s.stats) s.stats = {};
            this.byId.set(s.id, s);
        }
        this._domains();

        /* 기본 변수는 **검증 가능한 관측소가 가장 많은 것**. 관측만 있고 모델
           성적이 없는 변수를 첫 화면에 띄우면 지도가 통째로 회색이라 이 기능이
           고장 난 줄 안다. */
        let best = null, bn = -1;
        for (const v of this._vars()) {
            const n = this.stations.filter((s) => s.stats[v]).length;
            if (n > bn) { bn = n; best = v; }
        }
        this.v = best || this._vars()[0] || "hs";

        this._bindUI();
        this._buildSeg();
        this._buildChips();
        this._renderList();
        this._renderFoot();
        this._addLayers();
        return this;
    }

    _vars() {
        return VORDER.filter((v) => this.meta.vars[v]
            && this.stations.some((s) => s.vars.includes(v)));
    }

    _vm(v) {
        const m = (this.meta && this.meta.vars[v]) || {};
        return {
            label: m.label || v,
            unit: m.unit || "",
            nd: m.nd != null ? m.nd : 2,
            circular: m.circular != null ? m.circular : DIRVAR.has(v),
            model: m.model !== undefined ? m.model : (FALLBACK_MODEL[v] || null),
            datum: m.datum, dirmode: m.dirmode,
        };
    }

    _domains() {
        for (const v of VORDER) {
            const a = [];
            for (const s of this.stations) {
                const t = s.stats[v];
                if (t && t.rmse != null) a.push(t.rmse);
            }
            if (a.length >= 3) {
                let lo = quantile(a, 0.10), hi = quantile(a, 0.90);
                if (hi - lo < 1e-6) { lo = Math.min(...a); hi = Math.max(...a); }
                this.dom[v] = [lo, hi];
            } else if (a.length) {
                this.dom[v] = [Math.min(...a), Math.max(...a)];
            }
        }
    }

    _ramp(v, x) {
        if (x == null || !isFinite(x)) return NO_DATA;
        const d = this.dom[v];
        if (!d) return RAMP[2];
        const t = clamp((x - d[0]) / Math.max(d[1] - d[0], 1e-9), 0, 1);
        return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))];
    }

    // ── 지도 표식 ────────────────────────────────────────────────────
    _geojson() {
        const v = this.v, M = this._vm(v);
        return {
            type: "FeatureCollection",
            features: this.stations.map((s) => {
                const has = s.vars.includes(v);
                const t = has ? s.stats[v] : null;
                const on = has && (!this.nets.size || this.nets.has(s.net));
                const lv = this.latest && this.latest.obs[s.id]
                    ? this.latest.obs[s.id][v] : null;
                let lab = t && t.rmse != null
                    ? `${M.label} RMSE ${fmt(t.rmse, M.nd)} ${M.unit}`
                    : (has ? `${M.label} 검증 표본 부족` : `${M.label} 자료 없음`);
                if (lv) lab += ` · 최근 ${fmt(lv[0], M.nd)} ${M.unit}`;
                return {
                    type: "Feature",
                    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
                    properties: { id: s.id, name: s.name, on: on ? 1 : 0,
                                  col: on ? this._ramp(v, t && t.rmse) : NO_DATA,
                                  lab },
                };
            }),
        };
    }

    _addLayers() {
        if (this.layered || !this.map) return;
        if (!this.map.isStyleLoaded()) { this.map.once("idle", () => this._addLayers()); return; }
        const map = this.map;
        map.addSource("obst", { type: "geojson", data: this._geojson() });

        /* 이 변수 자료가 없는 지점은 아예 안 그린다. 예전엔 작고 흐린 점으로
           깔아 위치라도 보여 줬는데, 지도에 회색 점이 절반이라 어디를 눌러야
           뭐가 나오는지 알 수 없었다. 검증 화면에서 쓸모 있는 것은 "이 변수를
           실제로 재는 곳"뿐이다. */
        map.addLayer({
            id: "obst-on", type: "circle", source: "obst",
            filter: ["==", ["get", "on"], 1],
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 4.4, 7, 7, 12, 11],
                "circle-color": ["get", "col"], "circle-opacity": 0.95,
                // 겹치는 표식은 밝은 링으로 떼어 놓는다
                "circle-stroke-width": 1.6,
                "circle-stroke-color": "rgba(255,255,255,.62)",
            },
        });
        map.addLayer({
            id: "obst-sel", type: "circle", source: "obst",
            filter: ["==", ["get", "id"], "__none__"],
            paint: {
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 8, 7, 12, 12, 17],
                "circle-color": "rgba(0,0,0,0)",
                "circle-stroke-width": 2.4, "circle-stroke-color": "#ffffff",
            },
        });

        /* 이름표를 심볼 레이어로 넣으면 글립 서버가 필요하고 공개 글립셋에는
           한글이 없다. 그래서 호버 팝업으로 붙인다. */
        this.pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false,
                                          offset: 12, className: "stpop" });
        for (const id of ["obst-on"]) {
            map.on("click", id, (e) => {
                e.originalEvent.stopPropagation();
                this.select(e.features[0].properties.id, false);
            });
            map.on("mousemove", id, (e) => {
                map.getCanvas().style.cursor = "pointer";
                const f = e.features[0].properties;
                this.pop.setLngLat(e.features[0].geometry.coordinates)
                    .setHTML(`<b>${f.name}</b><span>${f.lab}</span>`).addTo(map);
            });
            map.on("mouseleave", id, () => {
                map.getCanvas().style.cursor = "";
                if (this.pop) this.pop.remove();
            });
        }
        this.layered = true;
        this.setVisible(this.dotsOn);
    }

    setVisible(on) {
        this.dotsOn = !!on;
        if (!this.layered) return;
        for (const id of ["obst-on", "obst-sel"]) {
            if (this.map.getLayer(id))
                this.map.setLayoutProperty(id, "visibility", this.dotsOn ? "visible" : "none");
        }
        if (!this.dotsOn && this.pop) this.pop.remove();
    }

    _refreshMap() {
        if (!this.layered || !this.map.getSource("obst")) return;
        this.map.getSource("obst").setData(this._geojson());
        this.map.setFilter("obst-sel", ["==", ["get", "id"], this.sel || "__none__"]);
    }

    // ── 바깥에서 부르는 것 ───────────────────────────────────────────
    /** 색칠판이 바뀌었다. 사용자가 검증 변수를 직접 고르지 않았으면 따라간다. */
    setField(model, v) {
        this.field = { model, v };
        if (!this.meta) return;
        const ov = FIELD2OBS[`${model}.${v}`];
        if (ov && !this.userVar && ov !== this.v && this._vars().includes(ov)) {
            this.v = ov;
            this._resetRange();
            this._syncSeg(); this._syncChips();
            this._renderList(); this._refreshMap(); this._renderFoot();
            if (this.sel) this._renderDetail();
        }
        this._curH = -1;
        if (this.sel) { this._renderNow(); this._draw(); }
    }

    /** 시간 막대가 움직였다. t 는 **지금 보고 있는 모델의** 예보 스텝이다. */
    setCursor(t) {
        this.cursor = t;
        const h = this._cursorH();
        if (h === this._curH) return;           // 정시가 안 바뀌었으면 다시 안 그린다
        this._curH = h;
        if (this.sel && this.pay) { this._renderNow(); this._draw(); }
    }

    toggle(on) {
        const want = on == null ? !this.on : !!on;
        if (want === this.on) return;
        this.on = want;
        if (this.ui.panel) this.ui.panel.classList.toggle("closed", !this.on);
        const b = $("btn-obs");
        if (b) b.classList.toggle("on", this.on);
        if (!this.on) { this._closeDetail(); return; }
        if (!this.dotsOn) {
            const c = $("obs-check");
            if (c) c.checked = true;
            this.setVisible(true);
        }
        this._renderList(); this._refreshMap(); this._renderFoot();
    }

    get detailOpen() { return !!(this.ui.detail && !this.ui.detail.hidden); }

    // ── 목록 / 필터 ──────────────────────────────────────────────────
    _visible() {
        const q = this.q.trim();
        let a = this.stations.filter((s) => s.vars.includes(this.v));
        if (this.nets.size) a = a.filter((s) => this.nets.has(s.net));
        if (q) a = a.filter((s) => s.name.includes(q) || s.netname.includes(q));
        const key = (s) => { const t = s.stats[this.v]; return t && t.rmse != null ? t.rmse : -1; };
        const byName = (x, y) => x.name.localeCompare(y.name, "ko");
        if (this.sortBy === "rmse") a.sort((x, y) => key(y) - key(x) || byName(x, y));
        else if (this.sortBy === "rmse-") a.sort((x, y) => key(x) - key(y) || byName(x, y));
        else if (this.sortBy === "name") a.sort(byName);
        else a.sort((x, y) => y.lat - x.lat);
        return a;
    }

    _renderList() {
        const L = this.ui.list;
        if (!L) return;
        const a = this._visible(), M = this._vm(this.v);
        L.innerHTML = "";
        if (this.ui.cnt) this.ui.cnt.textContent = `${a.length}개`;
        if (!a.length) {
            L.appendChild(el("div", "ob-empty", "조건에 맞는 관측소가 없습니다."));
            return;
        }
        const f = document.createDocumentFragment();
        for (const s of a) {
            const t = s.stats[this.v];
            const b = el("button", "ob-st" + (s.id === this.sel ? " on" : ""));
            b.type = "button";
            const dot = el("span", "ob-dot");
            dot.style.background = this._ramp(this.v, t && t.rmse);
            const tx = el("div", "ob-st-txt");
            tx.appendChild(el("div", "ob-st-nm", s.name));
            tx.appendChild(el("div", "ob-st-sub",
                `${s.netname} · N ${t ? t.n.toLocaleString() : 0}`));
            const val = el("div", "ob-st-val", t && t.rmse != null ? fmt(t.rmse, M.nd) : "—");
            b.append(dot, tx, val);
            b.onclick = () => this.select(s.id, true);
            f.appendChild(b);
        }
        L.appendChild(f);
    }

    _buildSeg() {
        const bar = this.ui.seg;
        if (!bar) return;
        bar.innerHTML = "";
        for (const v of this._vars()) {
            const n = this.stations.filter((s) => s.vars.includes(v)).length;
            const b = el("button", "ob-seg" + (v === this.v ? " on" : ""));
            b.type = "button";
            b.dataset.v = v;
            b.appendChild(el("span", null, this._vm(v).label));
            b.appendChild(el("span", "ob-seg-n", String(n)));
            b.onclick = () => {
                this.v = v; this.userVar = true;
                this._resetRange(); this._syncSeg(); this._syncChips();
                this._renderList(); this._refreshMap(); this._renderFoot();
                if (this.sel) this._renderDetail();
            };
            bar.appendChild(b);
        }
    }

    _syncSeg() {
        if (!this.ui.seg) return;
        for (const b of this.ui.seg.children) b.classList.toggle("on", b.dataset.v === this.v);
    }

    _buildChips() {
        const C = this.ui.chips;
        if (!C) return;
        C.innerHTML = "";
        const nm = {};
        for (const s of this.stations) nm[s.net] = s.netname;
        const nets = [...new Set(this.stations.map((s) => s.net))]
            .sort((a, b) => nm[a].localeCompare(nm[b], "ko"));
        for (const n of nets) {
            const b = el("button", "ob-chip", nm[n]);
            b.type = "button";
            b.dataset.net = n;
            b.onclick = () => {
                if (b.disabled) return;
                if (this.nets.has(n)) this.nets.delete(n); else this.nets.add(n);
                b.classList.toggle("on", this.nets.has(n));
                this._renderList(); this._refreshMap();
            };
            C.appendChild(b);
        }
        this._syncChips();
    }

    /* 고른 변수에 자료가 없는 관측망 칩은 눌러도 0개가 나온다. 미리 막는다. */
    _syncChips() {
        const C = this.ui.chips;
        if (!C) return;
        for (const b of C.children) {
            const n = b.dataset.net;
            const k = this.stations.filter((s) => s.net === n && s.vars.includes(this.v)).length;
            b.disabled = k === 0;
            b.title = k ? `${k}개 관측소` : `${this._vm(this.v).label} 자료 없음`;
            if (!k && this.nets.has(n)) { this.nets.delete(n); b.classList.remove("on"); }
        }
    }

    _renderFoot() {
        const F = this.ui.foot;
        if (!F) return;
        F.innerHTML = "";
        const M = this._vm(this.v), d = this.dom[this.v];
        F.appendChild(el("span", null, `${M.label} RMSE`));
        const r = el("div", "ob-ramp");
        for (const c of RAMP) { const i = el("i"); i.style.background = c; r.appendChild(i); }
        if (d) F.append(el("b", null, fmt(d[0], M.nd)), r, el("b", null, fmt(d[1], M.nd)));
        else F.appendChild(r);
        F.appendChild(el("span", null, M.unit || "—"));
    }

    // ── 선택 / 상세 ──────────────────────────────────────────────────
    async select(id, fly) {
        const st = this.byId.get(id);
        if (!st) return;
        if (!this.on) this.toggle(true);
        this.sel = id;
        this.userVar = false;
        this._renderList(); this._refreshMap();
        if (this.opts.onSelect) this.opts.onSelect(id);
        if (fly && this.map) {
            this.map.easeTo({ center: [st.lon, st.lat],
                              zoom: Math.max(this.map.getZoom(), 8), duration: 700 });
        }

        const D = this.ui.detail;
        D.hidden = false;
        this.ui.nm.textContent = st.name;
        const gd = Object.entries(st.grid || {})
            .map(([m, d]) => `${m.toUpperCase()} ${d < 0.05 ? "격자내" : d.toFixed(1) + "km"}`)
            .join(" · ");
        this.ui.meta.textContent =
            `${st.netname} · ${st.lat.toFixed(4)}°N ${st.lon.toFixed(4)}°E`
            + (gd ? ` · 대응 ${gd}` : "");

        let d = this.data.get(id);
        if (!d) {
            this.ui.body.innerHTML = '<div class="ob-empty">시계열 불러오는 중…</div>';
            try {
                d = await this.store.json(`ts/${id}.json.br`);
            } catch (err) {
                this.ui.body.innerHTML =
                    `<div class="ob-empty">시계열을 불러오지 못했습니다.<br>` +
                    `<small>${err.message}</small></div>`;
                return;
            }
            this.data.set(id, d);
        }
        if (this.sel !== id) return;                 // 그 사이에 다른 지점을 눌렀다

        this.pay = d;
        this.cv = null;
        this.D0 = d.t0;
        let hi = d.t0 + d.n - 1;
        for (const m of Object.keys(d.fc)) {
            if (m === "t0" || m === "n") continue;
            const t = this._fcT0(m) + d.fc.n - 1;
            if (t > hi) hi = t;
        }
        this.N = hi - this.D0 + 1;
        this._curH = -1;

        const av = this._avail();
        if (!av.includes(this.v) && av.length) this.v = av[0];
        this._resetRange();
        this._renderDetail();
    }

    _closeDetail() {
        if (this.ui.detail) this.ui.detail.hidden = true;
        this.sel = null; this.pay = null; this.cv = null; this.ui.now = null;
        if (this.ro) { this.ro.disconnect(); this.ro = null; }
        this._renderList(); this._refreshMap();
    }

    /* 예측이 시작하는 절대 시각. 축은 **하나**다 (가장 새 사이클).

       전에는 모델마다 제 사이클 시각에서 시작하게 뒀다. 그러면 MOHID 가
       이틀 밀린 날 그 모델의 예측선이 과거선과 같은 구간에 겹쳐, 한 색으로
       두 줄이 나란히 그려졌다. 지금은 ts_web.py 가 공용 축으로 옮겨 담고
       못 미치는 뒷구간을 비워 보낸다 — 옛 payload 호환으로 모델별 t0 가
       있으면 그것도 받아 준다. */
    _fcT0(m) {
        const d = this.pay.fc[m];
        return d && d.t0 != null ? d.t0 : this.pay.fc.t0;
    }

    /* 이 모델의 예보가 공용 축에서 끝나는 칸. 뒤처진 사이클이면 축 끝보다
       앞에서 끊긴다 — 그 뒤는 예보가 아예 없다. */
    _fcEnd(m) {
        const e = this.pay.fc.end;
        const n = this.pay.fc.n - 1;
        return e && e[m] != null ? e[m] : n;
    }

    _cursorH() {
        if (!this.pay) return -1;
        return Math.round(this._fcT0(this.field.model) + this.cursor);
    }

    /* 이 관측소에서 **검증할 수 있는** 변수.

       모델 쪽은 볼 것도 없다 — 격자에서 뽑아 오므로 어느 지점이든 13개가 다
       있다. 그걸 기준으로 삼으면 수온계 하나뿐인 조위관측소에도 탭이 13개
       뜨고, 눌러 봐야 "관측 결측"만 나온다. 관측이 있는 것만 센다. */
    _avail() {
        const p = this.pay;
        if (!p) return [];
        return VORDER.filter((v) => this.meta.vars[v]
            && p.obs[v] && p.obs[v].some((x) => x != null));
    }

    /* 한 변수의 세 계열을 **같은 길이·같은 시작**의 배열로 편다.

       관측·모델과거는 payload.t0 에서, 예측은 모델의 사이클 시각에서 시작한다.
       셋을 색인 하나로 훑을 수 있게 여기서 한 번에 맞춰 둔다 — 그리기·통계·
       산점도·툴팁이 전부 같은 색인을 쓰므로, 여기서 한 칸이라도 밀리면 화면
       전체가 조용히 거짓말을 한다.

       기준면이 다른 변수(조위)는 payload.anomaly 의 평균을 각각 빼서 편차로
       맞춘다. 안 그러면 관측(DL 기준)과 모델(평균해면 기준)이 수십 cm 어긋난다. */
    _pair(v) {
        const p = this.pay, M = this._vm(v), m = M.model;
        const N = this.N;
        const an = (p.anomaly && p.anomaly[v]) || null;
        const off = (k) => (an && an[k] != null ? an[k] : 0);
        const oo = off("obs"), mo = m ? off(m) : 0;

        const obs = new Array(N).fill(null);
        const mod = new Array(N).fill(null);
        const fcs = new Array(N).fill(null);
        const oa = p.obs[v], ha = m && p.his[m] ? p.his[m][v] : null;
        for (let i = 0; i < p.n && i < N; i++) {
            if (oa && oa[i] != null) obs[i] = oa[i] - oo;
            if (ha && ha[i] != null) mod[i] = ha[i] - mo;
        }
        let fs = -1;
        if (m && p.fc[m] && p.fc[m][v]) {
            const fa = p.fc[m][v];
            fs = this._fcT0(m) - this.D0;
            for (let i = 0; i < fa.length; i++) {
                const k = fs + i;
                if (k >= 0 && k < N && fa[i] != null) fcs[k] = fa[i] - mo;
            }
        }
        return { obs, mod, fcs, model: m, fcStart: fs,
                 fcLast: m ? fs + this._fcEnd(m) : -1,
                 hasHis: !!ha, hasFcs: fs >= 0,
                 unit: M.unit, label: M.label, nd: M.nd,
                 circular: M.circular, anomaly: !!an };
    }

    _resetRange() {
        /* 기본은 **최근 30일 + 예측**. 여기는 예측 사이트라 "전체"(2026년 전부)로
           열면 정작 궁금한 앞뒤 며칠이 1px 안에 뭉친다. 전체는 단추로 남긴다. */
        const N = Math.max(this.N, 4);
        this.x1 = N - 1;
        this.x0 = Math.max(0, N - 1 - (24 * 30 + 96));
    }

    _setSpan(a, span) {
        const N = this.N;
        span = clamp(span, 3, Math.max(3, N - 1));
        this.x0 = clamp(a, 0, Math.max(0, (N - 1) - span));
        this.x1 = this.x0 + span;
    }

    _zoomNow(hours) {
        const c = clamp(this._cursorH() - this.D0, 0, this.N - 1);
        const half = Math.round(hours / 2);
        this.x0 = clamp(c - half, 0, this.N - 1);
        this.x1 = clamp(c + half, 0, this.N - 1);
        if (this.x1 - this.x0 < 3) {
            this.x0 = clamp(this.x1 - 3, 0, this.N - 1);
            this.x1 = clamp(this.x0 + 3, 0, this.N - 1);
        }
        this._draw();
    }

    /* 선 색은 **모델 색**이다 (지도 좌상단 단추와 같은 색). 과거와 예측은
       색조가 아니라 세기로 가른다 — 같은 모델인데 색이 달라 보이면 두 모델을
       견주는 그림으로 잘못 읽힌다. */
    _cHis() { return mcolA(this._vm(this.v).model, 0.5); }
    _cFcs() { return mcol(this._vm(this.v).model); }

    _tAt(i) { return new Date(this.epoch + (this.D0 + i) * HOUR + KSTMS); }

    // ── 상세 그리기 ──────────────────────────────────────────────────
    _renderDetail() {
        const p = this.pay;
        if (!p) return;
        const B = this.ui.body;
        B.innerHTML = "";
        const A = this._avail();

        /* 변수 탭은 **모델마다 한 줄**로 나눈다. 열셋을 한 줄에 흘려 놓으면
           어느 변수가 어느 모델 건지 알 수가 없다. 줄 머리에 모델 이름을
           제 색으로 박는다 — 지도 좌상단 모델 단추와 같은 색이다. */
        const tabs = el("div", "ob-vtabs");
        const mkTab = (v) => {
            const b = el("button", "ob-vtab" + (v === this.v ? " on" : ""), this._vm(v).label);
            b.type = "button";
            b.onclick = () => {
                this.v = v; this.userVar = true;
                this._resetRange(); this._syncSeg(); this._syncChips();
                this._renderDetail(); this._renderList();
                this._refreshMap(); this._renderFoot();
            };
            return b;
        };
        const done = new Set();
        for (const m of MORDER) {
            const vs = A.filter((v) => this._vm(v).model === m);
            if (!vs.length) continue;
            const row = el("div", "ob-vrow");
            row.style.setProperty("--mc", mcol(m));
            row.appendChild(el("div", "ob-vrow-n", m.toUpperCase()));
            for (const v of vs) { row.appendChild(mkTab(v)); done.add(v); }
            tabs.appendChild(row);
        }
        const rest = A.filter((v) => !done.has(v));   // 모델을 모르는 변수
        if (rest.length) {
            const row = el("div", "ob-vrow");
            row.style.setProperty("--mc", "#93a2b8");
            row.appendChild(el("div", "ob-vrow-n", "기타"));
            for (const v of rest) row.appendChild(mkTab(v));
            tabs.appendChild(row);
        }
        B.appendChild(tabs);

        if (!A.includes(this.v)) {
            B.appendChild(el("div", "ob-empty",
                `이 관측소에는 ${this._vm(this.v).label} 자료가 없습니다.`));
            return;
        }

        const M = this._vm(this.v), P = this._pair(this.v);

        /* 지금 예보 시각의 값 — 시간 막대와 나란히 볼 때만 뜻이 있는 줄이다 */
        /* id 를 안 붙이고 손잡이를 들고 있는다. index.html 에 없는 id 를
           $() 로 찾으면 마크업만 보고는 어디서 오는 줄이 몰라 나중에 지워진다. */
        this.ui.now = el("div", "ob-now");
        B.appendChild(this.ui.now);

        /* 규약이 어긋난 채로 방향 통계를 내면 숫자가 거짓말을 한다. */
        if (M.circular && this.convBad && this.convBad.length) {
            const w = el("div", "ob-warn",
                `방향 규약이 어긋났습니다 — ${this.convBad.join(", ")}`);
            B.appendChild(w);
        }

        const t = recomputeStats(P.obs, P.mod, M.circular);
        const cards = el("div", "ob-cards");
        const add = (l, val, u) => {
            const c = el("div", "ob-card");
            c.appendChild(el("div", "ob-card-l", l));
            const vv = el("div", "ob-card-v");
            vv.textContent = val;
            if (u) vv.appendChild(el("span", "ob-card-u", u));
            c.appendChild(vv);
            cards.appendChild(c);
        };
        if (t) {
            add("RMSE", fmt(t.rmse, M.nd), P.unit);
            add("편향", (t.bias >= 0 ? "+" : "") + fmt(t.bias, M.nd), P.unit);
            if (!M.circular) {
                add("상관 R", t.r == null ? "—" : fmt(t.r, 3), "");
                add("표준편차비", t.sdr == null ? "—" : fmt(t.sdr, 2), "");
            } else {
                add("MAE", fmt(t.mae, M.nd), P.unit);
            }
            add("자료수", t.n.toLocaleString(), "시간");
        } else {
            add("검증", P.hasHis ? "표본 부족" : "과거 모델 없음", "");
        }
        B.appendChild(cards);

        // 조작줄
        const cr = el("div", "ob-ctrls");
        const N = this.N;
        const mk = (lab, on, fn, title) => {
            const b = el("button", "ob-mini" + (on ? " on" : ""), lab);
            b.type = "button";
            if (title) b.title = title;
            b.onclick = fn;
            cr.appendChild(b);
            return b;
        };
        const span = (n, lab) => mk(lab, this.x1 === N - 1 && this.x0 === Math.max(0, N - 1 - n),
            () => { this.x1 = N - 1; this.x0 = Math.max(0, N - 1 - n); this._draw(); });
        mk("전체", this.x0 === 0 && this.x1 === N - 1,
            () => { this.x0 = 0; this.x1 = N - 1; this._draw(); }, "2026년부터 전부");
        span(24 * 90, "90일"); span(24 * 30, "30일"); span(24 * 7, "7일");
        if (P.hasFcs) {
            mk("예측", false, () => {
                this.x0 = clamp(P.fcStart - 24, 0, N - 1);
                this.x1 = N - 1;
                this._draw();
            }, "이번 사이클 예측이 걸친 구간");
        }
        mk("현재±3일", false, () => this._zoomNow(24 * 6), "시간 막대가 서 있는 시각 둘레만");
        cr.appendChild(el("div", "ob-spacer"));
        mk(this.mode === "scatter" ? "산점도" : "시계열", this.mode === "scatter", () => {
            this.mode = this.mode === "time" ? "scatter" : "time";
            this._renderDetail();
        });
        B.appendChild(cr);

        // 범례
        const lg = el("div", "ob-legend");
        const item = (c, n) => {
            const i = el("div", "ob-lg-it");
            const sw = el("i", "ob-lg-sw");
            sw.style.background = c;
            i.append(sw, el("span", null, n));
            lg.appendChild(i);
        };
        item(C_OBS, "관측");
        const MN = P.model ? P.model.toUpperCase() : "모델";
        if (P.hasHis) item(this._cHis(), `${MN} 과거`);
        if (P.hasFcs) item(this._cFcs(), `${MN} 예측`);
        if (this.mode === "time") item(C_NOW, "현재 예보 시각");
        lg.appendChild(el("span", null, "· 매시 정시 (KST)"));
        B.appendChild(lg);

        // 그래프
        const box = el("div", "ob-chartbox");
        const cv = el("canvas", "ob-chart");
        const tip = el("div", "ob-tip");
        box.append(cv, tip);
        B.appendChild(box);
        if (this.mode === "time") {
            B.appendChild(el("div", "ob-hint",
                "끌기 이동 · 휠 확대 · Shift+끌기 구간확대 · 두 번 누르면 처음으로"));
        }

        // 주의사항
        if (this.v === "ssh") {
            const n = el("div", "ob-note");
            n.innerHTML = "기준면이 달라 (관측 DL · 모델 평균해면) <b>편차끼리</b> 견줍니다.";
            B.appendChild(n);
        }
        if (M.circular) {
            const n = el("div", "ob-note");
            n.innerHTML = "북 기준 방위각"
                + (this.v === "wdir" ? "(불어오는 쪽)" : "(흐르는 쪽)")
                + ". 통계는 원형으로 잽니다.";
            B.appendChild(n);
        }
        if (this.v === "sst") {
            const n = el("div", "ob-note");
            n.innerHTML = "검증 상대는 MOHID 입니다.";
            B.appendChild(n);
        }
        if (P.hasFcs) {
            const ci = this._cycInfo(P.model);
            const n = el("div", "ob-note");
            n.innerHTML = `<b>예측선</b> ${MN} ${ci ? ci.txt : "최신"} 사이클`
                + (ci && ci.lag > 0 ? ` (다른 모델보다 ${ci.lag}일 늦음)` : "")
                + ". 통계에는 안 들어갑니다.";
            B.appendChild(n);
        }

        this._bindChart(cv, tip);
        this._draw();
        this._renderNow();
    }

    _renderNow() {
        const R = this.ui.now;
        if (!R || !this.pay) return;
        if (!this._avail().includes(this.v)) { R.innerHTML = ""; return; }
        const M = this._vm(this.v), P = this._pair(this.v);
        const i = clamp(this._cursorH() - this.D0, 0, this.N - 1);
        const o = P.obs[i];
        const m = P.fcs[i] != null ? P.fcs[i] : P.mod[i];
        const isF = P.fcs[i] != null;
        // 값이 없을 때 빈칸으로 두면 "안 그려진 것"인지 "없는 것"인지 모른다.
        const val = (x) => (x == null || !isFinite(x)
            ? '<span class="ob-miss">결측</span>'
            : `${fmt(x, M.nd)} ${P.unit}`);
        let df = (o != null && m != null) ? m - o : null;
        if (df != null && M.circular) df = ((df + 180) % 360 + 360) % 360 - 180;
        R.innerHTML =
            `<span class="ob-now-t">${stampKST(this._tAt(i), true)} KST</span>`
            + `<span class="ob-now-v"><i style="background:${C_OBS}"></i>관측 ${val(o)}</span>`
            + `<span class="ob-now-v"><i style="background:${isF ? this._cFcs() : this._cHis()}"></i>`
            + `모델${isF ? "(예측)" : ""} ${val(m)}</span>`
            + (df != null ? `<span class="ob-now-d">차 ${df >= 0 ? "+" : ""}`
                            + `${fmt(df, M.nd)} ${P.unit}</span>` : "");
    }

    /* 이 모델 예측이 어느 초기장에서 나온 것인지.

       모델마다 사이클이 다를 수 있어서(MOHID 원본이 늦는 날) "왜 이 예측이
       그저께서부터 시작하지?" 가 생긴다. 화면에 적어 두지 않으면 답이 없다. */
    _cycInfo(m) {
        const d = this.pay && this.pay.fc && this.pay.fc[m];
        if (!d || d.t0 == null) return null;
        const t = new Date(this.epoch + d.t0 * HOUR + KSTMS);
        const newest = this.pay.fc.t0;
        const lag = newest != null ? Math.round((newest - d.t0) / 24) : 0;
        return { txt: stampKST(t, true) + " KST 초기장", lag };
    }

    // ── 그래프 ───────────────────────────────────────────────────────
    _idxAtPx(px, w) {
        const iw = Math.max(1, w - PAD.l - PAD.r);
        return this.x0 + clamp((px - PAD.l) / iw, 0, 1) * (this.x1 - this.x0);
    }

    _pickIndex(px, w) {
        const iw = w - PAD.l - PAD.r;
        const t = clamp((px - PAD.l) / Math.max(iw, 1), 0, 1);
        return clamp(Math.round(this.x0 + t * (this.x1 - this.x0)), 0, this.N - 1);
    }

    /* ── 그래프 손놀림 ────────────────────────────────────────────
       ref 와 같다. 끌기를 '구간 골라 확대'로 두면 확대해 놓고 옆을 보려면
       방법이 없어서, 가장 흔한 몸짓인 끌기를 '옆으로 밀기'로 뒀다.
         · 그냥 누름       → 예측 구간이면 그 시각으로 이동
         · 끌기            → 그래프가 손을 따라 옆으로
         · 휠 / 두 손가락  → 커서 자리를 붙들고 확대·축소
         · Shift + 끌기    → 그 구간만 확대
         · 두 번 누름      → 처음 구간으로                              */
    _bindChart(cv, tip) {
        this.cv = cv; this.tip = tip;
        this.pts.clear(); this.pinch = null; this.drag = null;
        cv.classList.remove("grabbing", "zoomsel");
        cv.classList.toggle("nopan", this.mode !== "time");

        const cursor = (shift) => {
            const sel = this.drag ? this.drag.sel : shift;
            cv.classList.toggle("zoomsel", !!sel);
            cv.classList.toggle("grabbing", !!(this.drag && !sel));
        };

        cv.onpointermove = (e) => {
            const r = cv.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            if (this.pts.has(e.pointerId)) this.pts.set(e.pointerId, x);

            if (this.pinch) { this._applyPinch(r.width); this._draw(); return; }
            if (this.drag) {
                const d = this.drag;
                d.x = x;
                if (!d.moved && Math.abs(x - d.a) > 3) d.moved = true;
                if (d.moved && !d.sel) {
                    const iw = Math.max(1, d.w - PAD.l - PAD.r);
                    const sp = d.x1 - d.x0;
                    this._setSpan(d.x0 - (x - d.a) * sp / iw, sp);
                }
                this._draw();
                return;
            }
            cursor(e.shiftKey);
            this.hover = this._pickIndex(x, r.width);
            this._draw();
            this._showTip(x, y, r.width);
        };
        cv.onpointerleave = () => {
            if (this.drag || this.pinch) return;
            this.hover = -1;
            this.tip.classList.remove("on");
            this._draw();
        };

        cv.onpointerdown = (e) => {
            if (this.mode !== "time") return;
            const r = cv.getBoundingClientRect();
            const x = e.clientX - r.left;
            try { cv.setPointerCapture(e.pointerId); } catch (_) { /* 구형 브라우저 */ }
            this.pts.set(e.pointerId, x);
            this.tip.classList.remove("on");
            this.hover = -1;
            // 손가락이 둘이면 집기로 넘어간다 — 휴대폰에는 휠이 없다
            if (this.pts.size >= 2) {
                this.drag = null; this._startPinch(r.width);
                cursor(false); this._draw();
                return;
            }
            this.drag = { a: x, x, w: r.width, moved: false, sel: e.shiftKey,
                          x0: this.x0, x1: this.x1 };
            cursor(e.shiftKey);
        };

        cv.onpointercancel = (e) => {
            this.pts.delete(e.pointerId);
            if (this.pts.size < 2) this.pinch = null;
            this.drag = null;
            cursor(false);
            this._draw();
        };

        cv.onpointerup = (e) => {
            const hadPinch = this.pinch !== null;
            this.pts.delete(e.pointerId);
            if (this.pts.size < 2) this.pinch = null;
            if (hadPinch) {
                this.drag = null; this.lastClk = null;
                cursor(e.shiftKey); this._draw();
                return;
            }
            if (!this.drag) return;
            const dg = this.drag;
            this.drag = null;
            cursor(e.shiftKey);

            if (dg.moved && dg.sel) {                    // Shift + 끌기 = 구간 확대
                const i0 = this._pickIndex(Math.min(dg.a, dg.x), dg.w);
                const i1 = this._pickIndex(Math.max(dg.a, dg.x), dg.w);
                if (i1 - i0 >= 3) { this.x0 = i0; this.x1 = i1; }
                this.lastClk = null;
                this._draw();
                return;
            }
            if (dg.moved) { this.lastClk = null; this._draw(); return; }

            /* 안 끌었으면 그냥 누른 것이다. 그런데 겹눌림(확대 되돌리기)도 그냥
               누름 두 번으로 온다 — pointerup 이 dblclick 보다 먼저 오므로 첫
               누름에서 이미 시각을 옮겨 놓고 나서야 겹눌림인 걸 알게 된다.
               그래서 옮기기 전 스텝을 적어 두고, 곧바로 같은 자리를 또 누르면
               그 시각을 되돌려 놓고 확대만 푼다. 한 번 누름은 안 늦어진다. */
            const now = performance.now();
            if (this.lastClk && now - this.lastClk.t < 320
                && Math.abs(dg.a - this.lastClk.x) < 8) {
                this.lastClk = null;
                if (this.lastClkStep >= 0 && this.opts.onSeek) this.opts.onSeek(this.lastClkStep);
                this._resetRange();
                this._curH = -1;
                this._draw();
                return;
            }
            this.lastClkStep = Math.round(this.cursor);
            this.lastClk = { t: now, x: dg.a };
            this._seek(this._pickIndex(dg.a, dg.w));
        };

        cv.onwheel = (e) => {
            if (this.mode !== "time") return;
            e.preventDefault();
            const r = cv.getBoundingClientRect();
            const px = e.clientX - r.left, iw = Math.max(1, r.width - PAD.l - PAD.r);
            const c = this._idxAtPx(px, r.width);
            const sp = clamp((this.x1 - this.x0) * (e.deltaY > 0 ? 1.25 : 0.8), 3, this.N - 1);
            // 커서 밑에 있던 시각을 그 자리에 붙들어 둔다
            this._setSpan(c - clamp((px - PAD.l) / iw, 0, 1) * sp, sp);
            this._draw();
        };

        if (this.ro) this.ro.disconnect();
        if (typeof ResizeObserver === "function") {
            this.ro = new ResizeObserver(() => this._draw());
            this.ro.observe(cv.parentElement);
        }
    }

    _startPinch(w) {
        const v = [...this.pts.values()];
        const mid = (v[0] + v[1]) / 2;
        this.pinch = { d: Math.max(Math.abs(v[0] - v[1]), 1),
                       span: this.x1 - this.x0, c: this._idxAtPx(mid, w) };
    }

    _applyPinch(w) {
        const v = [...this.pts.values()];
        if (v.length < 2 || !this.pinch) return;
        const d = Math.max(Math.abs(v[0] - v[1]), 1), mid = (v[0] + v[1]) / 2;
        const iw = Math.max(1, w - PAD.l - PAD.r);
        const sp = clamp(this.pinch.span * this.pinch.d / d, 3, this.N - 1);
        this._setSpan(this.pinch.c - clamp((mid - PAD.l) / iw, 0, 1) * sp, sp);
    }

    /** 그래프에서 고른 시각으로 시간 막대를 옮긴다. 색칠판은 최신 사이클
        한 벌뿐이라 예측 구간 밖은 옮길 곳이 없다 — 조용히 무시한다. */
    _seek(i) {
        if (!this.pay || !this.opts.onSeek) return;
        const h = this.D0 + i;
        const s = h - this._fcT0(this.field.model);
        if (s < 0 || s > this.pay.fc.n - 1) return;
        this.opts.onSeek(s);
    }

    _draw() {
        const cv = this.cv;
        if (!cv || !cv.isConnected || !this.pay) return;
        if (!this._avail().includes(this.v)) return;
        const M = this._vm(this.v), P = this._pair(this.v);

        const dpr = window.devicePixelRatio || 1;
        const W = cv.parentElement.clientWidth;
        if (!W) return;
        const H = Math.max(190, Math.min(300, Math.round(W * 0.56)));
        if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
            cv.width = Math.round(W * dpr);
            cv.height = Math.round(H * dpr);
        }
        cv.style.height = H + "px";
        const g = cv.getContext("2d");
        if (!g) return;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        g.font = "10px system-ui,-apple-system,sans-serif";
        g.textBaseline = "middle";

        if (this.mode === "scatter") { this._scatter(g, W, H, P, M); return; }

        const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
        const a = this.x0, b = this.x1, span = Math.max(b - a, 1);
        /* 옆으로 미는 동작을 매끄럽게 하려고 x0·x1 은 소수점을 갖는다. 화면
           좌표는 소수 그대로 쓰고, 자료를 훑는 첨자만 정수로 감싼다. */
        const ia = clamp(Math.floor(a), 0, this.N - 1);
        const ib = clamp(Math.ceil(b), 0, this.N - 1);

        let lo = Infinity, hi = -Infinity;
        for (let i = ia; i <= ib; i++) {
            for (const arr of [P.obs, P.mod, P.fcs]) {
                const q = arr[i];
                if (q != null) { if (q < lo) lo = q; if (q > hi) hi = q; }
            }
        }
        if (!isFinite(lo)) {
            g.fillStyle = "rgba(232,238,246,.34)";
            g.textAlign = "center";
            g.fillText("이 구간에 자료가 없습니다", W / 2, H / 2);
            return;
        }
        if (M.circular) { lo = 0; hi = 360; }
        const padY = (hi - lo) * 0.10 || 1;
        lo -= padY; hi += padY;

        const X = (i) => PAD.l + (i - a) / span * iw;
        const Y = (v) => PAD.t + (1 - (v - lo) / (hi - lo)) * ih;

        /* 이 모델의 예보가 축 끝까지 못 미친다 (옛 사이클에 남은 날).
           빈 자리를 그냥 비워 두면 "그릴 걸 못 그렸나" 싶다. 왜 없는지 적는다. */
        if (P.hasFcs && P.fcLast >= 0 && P.fcLast < b) {
            const gx = Math.max(PAD.l, X(P.fcLast));
            g.fillStyle = "rgba(255,255,255,.045)";
            g.fillRect(gx, PAD.t, PAD.l + iw - gx, ih);
            g.save();
            g.beginPath(); g.rect(gx, PAD.t, PAD.l + iw - gx, ih); g.clip();
            g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1;
            for (let x = gx - ih; x < PAD.l + iw; x += 9) {
                g.beginPath(); g.moveTo(x, H - PAD.b); g.lineTo(x + ih, PAD.t); g.stroke();
            }
            g.restore();
            if (PAD.l + iw - gx > 54) {
                g.textAlign = "center"; g.textBaseline = "middle";
                g.font = "11px ui-sans-serif,system-ui,sans-serif";
                g.fillStyle = "rgba(255,220,140,.6)";
                g.fillText("예보 없음", (gx + PAD.l + iw) / 2, PAD.t + 14);
            }
        }

        // 예측 구간 음영 — 여기부터는 관측이 아직 없다
        if (P.hasFcs && P.fcStart <= b) {
            const fx = Math.max(PAD.l, X(P.fcStart));
            g.fillStyle = "rgba(242,179,61,.055)";
            g.fillRect(fx, PAD.t, PAD.l + iw - fx, ih);
            if (P.fcStart >= a) {
                g.strokeStyle = "rgba(242,179,61,.28)";
                g.lineWidth = 1;
                g.beginPath();
                g.moveTo(Math.round(fx) + 0.5, PAD.t);
                g.lineTo(Math.round(fx) + 0.5, H - PAD.b);
                g.stroke();
            }
        }

        // 격자
        const yt = M.circular ? [0, 90, 180, 270, 360] : niceTicks(lo, hi, 5);
        const yd = M.circular ? 0 : tickDigits(yt, M.nd);
        const dirLab = { 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" };
        g.lineWidth = 1;
        g.textAlign = "right";
        for (const v of yt) {
            const y = Math.round(Y(v)) + 0.5;
            if (y < PAD.t - 1 || y > H - PAD.b + 1) continue;
            g.strokeStyle = "rgba(255,255,255,.07)";
            g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(W - PAD.r, y); g.stroke();
            g.fillStyle = "rgba(232,238,246,.34)";
            g.fillText(M.circular ? dirLab[v] : v.toFixed(yd), PAD.l - 7, y);
        }
        const nt = clamp(Math.floor(iw / 86), 2, 7);
        g.textAlign = "center";
        const withHour = span < 24 * 20;
        for (let k = 0; k <= nt; k++) {
            const i = Math.round(a + span * k / nt), x = Math.round(X(i)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.05)";
            g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
            g.fillStyle = "rgba(232,238,246,.34)";
            g.fillText(stampKST(this._tAt(i), withHour), x, H - PAD.b + 11);
        }
        if (lo < 0 && hi > 0) {
            const y = Math.round(Y(0)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.18)";
            g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(W - PAD.r, y); g.stroke();
        }

        // 지금 보고 있는 예보 시각
        const ni = this._cursorH() - this.D0;
        if (ni >= a && ni <= b) {
            const x = Math.round(X(ni)) + 0.5;
            g.strokeStyle = C_NOW; g.lineWidth = 1.4;
            g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
            g.fillStyle = C_NOW;
            g.beginPath();
            g.moveTo(x - 3.4, PAD.t); g.lineTo(x + 3.4, PAD.t);
            g.lineTo(x, PAD.t + 4.6); g.closePath(); g.fill();
        }

        /* 선. 픽셀당 표본이 2개를 넘으면 폴리라인 대신 **픽셀 기둥**을 세운다.
           2026년치 시간자료가 5천 점이 넘어 400px 안에 그대로 그리면 선이
           스스로를 덮어 굵은 띠가 되고, 무엇보다 최댓값·최솟값이 사라진다. */
        const ppx = span / iw;
        const line = (arr, col, width) => {
            g.strokeStyle = col;
            g.lineWidth = width;
            g.lineJoin = "round";
            g.lineCap = "round";
            g.beginPath();
            const solo = [];
            if (ppx > 2) {
                for (let px = 0; px < iw; px++) {
                    const i0 = Math.max(ia, Math.round(a + px * ppx));
                    const i1 = Math.min(ib, Math.round(a + (px + 1) * ppx));
                    let mn = Infinity, mx = -Infinity;
                    for (let i = i0; i <= i1; i++) {
                        const v = arr[i];
                        if (v != null) { if (v < mn) mn = v; if (v > mx) mx = v; }
                    }
                    if (!isFinite(mn)) continue;
                    const x = PAD.l + px + 0.5;
                    g.moveTo(x, Y(mx));
                    g.lineTo(x, Y(mn) === Y(mx) ? Y(mn) + 0.6 : Y(mn));
                }
            } else {
                let pen = false, prev = null;
                for (let i = ia; i <= ib; i++) {
                    const v = arr[i];
                    if (v == null) { pen = false; prev = null; continue; }
                    // 방향은 359->1 이 이어진 값이다. 그냥 이으면 화면을 가로지른다.
                    if (pen && M.circular && Math.abs(v - prev) > 180) pen = false;
                    const x = X(i), y = Y(v);
                    if (pen) g.lineTo(x, y);
                    else {
                        g.moveTo(x, y); pen = true;
                        const nx = i < ib ? arr[i + 1] : null;
                        if (nx == null || (M.circular && Math.abs(nx - v) > 180)) solo.push(x, y);
                    }
                    prev = v;
                }
            }
            g.stroke();
            if (solo.length) {
                g.fillStyle = col;
                for (let k = 0; k < solo.length; k += 2) {
                    g.beginPath(); g.arc(solo[k], solo[k + 1], 1.7, 0, 6.2832); g.fill();
                }
            }
        };
        /* 관측을 먼저 깔고 모델을 그 위에 얹는다. 검증 그래프에서 읽고 싶은
           것은 "모델이 관측을 얼마나 따라가느냐"이고, 눈이 좇는 선은 모델
           쪽이다. 관측이 위에 있으면 두 선이 붙는 구간에서 모델이 통째로
           가려져 잘 맞는지 어긋나는지 분간이 안 됐다. */
        line(P.obs, C_OBS, 2);
        line(P.mod, this._cHis(), 1.8);
        line(P.fcs, this._cFcs(), 2.2);

        // Shift+끌기 구간 표시
        if (this.drag && this.drag.moved && this.drag.sel) {
            const x0 = Math.min(this.drag.a, this.drag.x);
            const x1 = Math.max(this.drag.a, this.drag.x);
            g.fillStyle = "rgba(255,255,255,.10)";
            g.fillRect(x0, PAD.t, x1 - x0, ih);
            g.strokeStyle = "rgba(255,255,255,.4)";
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(x0 + 0.5, PAD.t); g.lineTo(x0 + 0.5, H - PAD.b);
            g.moveTo(x1 + 0.5, PAD.t); g.lineTo(x1 + 0.5, H - PAD.b);
            g.stroke();
        }

        // 호버 십자선 + 점
        if (this.hover >= a && this.hover <= b && !this.drag) {
            const x = Math.round(X(this.hover)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.32)";
            g.lineWidth = 1;
            g.setLineDash([3, 3]);
            g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
            g.setLineDash([]);
            for (const [arr, c] of [[P.obs, C_OBS], [P.mod, this._cHis()], [P.fcs, this._cFcs()]]) {
                const v = arr[this.hover];
                if (v == null) continue;
                g.fillStyle = c;
                g.beginPath(); g.arc(x - 0.5, Y(v), 3.6, 0, 6.2832); g.fill();
                g.strokeStyle = "rgba(7,11,18,.9)"; g.lineWidth = 1.6; g.stroke();
            }
        }

        g.save();
        g.translate(11, PAD.t + ih / 2);
        g.rotate(-Math.PI / 2);
        g.fillStyle = "rgba(232,238,246,.50)";
        g.textAlign = "center";
        g.fillText(`${P.label} (${P.unit})` + (P.anomaly ? " 편차" : ""), 0, 0);
        g.restore();
    }

    _scatter(g, W, H, P, M) {
        const pad = { l: 46, r: 12, t: 10, b: 30 };
        const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
        const sa = clamp(Math.floor(this.x0), 0, this.N - 1);
        const sb = clamp(Math.ceil(this.x1), 0, this.N - 1);
        let lo = Infinity, hi = -Infinity, n = 0;
        for (let i = sa; i <= sb; i++) {
            const o = P.obs[i], m = P.mod[i];
            if (o == null || m == null) continue;
            n++; lo = Math.min(lo, o, m); hi = Math.max(hi, o, m);
        }
        if (!n) {
            g.fillStyle = "rgba(232,238,246,.34)";
            g.textAlign = "center";
            g.fillText("겹치는 자료가 없습니다", W / 2, H / 2);
            return;
        }
        const p = (hi - lo) * 0.06 || 1;
        lo -= p; hi += p;
        const X = (v) => pad.l + (v - lo) / (hi - lo) * iw;
        const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih;

        const tk = niceTicks(lo, hi, 4), td = tickDigits(tk, M.nd);
        g.lineWidth = 1;
        for (const v of tk) {
            const x = Math.round(X(v)) + 0.5, y = Math.round(Y(v)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.06)";
            g.beginPath();
            g.moveTo(pad.l, y); g.lineTo(W - pad.r, y);
            g.moveTo(x, pad.t); g.lineTo(x, H - pad.b);
            g.stroke();
            g.fillStyle = "rgba(232,238,246,.34)";
            g.textAlign = "right"; g.fillText(v.toFixed(td), pad.l - 6, y);
            g.textAlign = "center"; g.fillText(v.toFixed(td), x, H - pad.b + 11);
        }
        g.strokeStyle = "rgba(255,255,255,.34)";
        g.lineWidth = 1.4;
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(X(lo), Y(lo)); g.lineTo(X(hi), Y(hi)); g.stroke();
        g.setLineDash([]);

        // 점이 만 개를 넘으면 캔버스가 뭉개지기만 한다. 솎아 그린다.
        const step = Math.max(1, Math.floor(n / 6000));
        g.fillStyle = "rgba(30,134,188,.5)";
        let k = 0;
        for (let i = sa; i <= sb; i++) {
            const o = P.obs[i], m = P.mod[i];
            if (o == null || m == null) continue;
            if ((k++ % step)) continue;
            g.beginPath(); g.arc(X(o), Y(m), 1.5, 0, 6.2832); g.fill();
        }
        const ni = clamp(this._cursorH() - this.D0, sa, sb);
        const o = P.obs[ni], m = P.mod[ni];
        if (o != null && m != null) {
            g.fillStyle = C_NOW;
            g.beginPath(); g.arc(X(o), Y(m), 4.2, 0, 6.2832); g.fill();
            g.strokeStyle = "rgba(7,11,18,.9)"; g.lineWidth = 1.6; g.stroke();
        }
        g.fillStyle = "rgba(232,238,246,.50)";
        g.textAlign = "center";
        g.fillText(`관측 (${P.unit})`, pad.l + iw / 2, H - 4);
        g.save();
        g.translate(11, pad.t + ih / 2);
        g.rotate(-Math.PI / 2);
        g.fillText(`${P.model ? P.model.toUpperCase() : "모델"} 과거 (${P.unit})`, 0, 0);
        g.restore();
    }

    _showTip(px, py, w) {
        if (!this.tip || !this.pay) return;
        if (this.mode !== "time" || this.hover < 0) {
            this.tip.classList.remove("on");
            return;
        }
        const M = this._vm(this.v), P = this._pair(this.v), i = this.hover;
        const o = P.obs[i], h = P.mod[i], f = P.fcs[i];
        if (o == null && h == null && f == null) {
            this.tip.classList.remove("on");
            return;
        }
        const m = f != null ? f : h;
        let df = (o != null && m != null) ? m - o : null;
        if (df != null && M.circular) df = ((df + 180) % 360 + 360) % 360 - 180;
        const val = (x) => (x == null || !isFinite(x) ? "결측" : `${fmt(x, M.nd)} ${P.unit}`);
        const row = (c, l, x) =>
            `<div class="ob-tip-r"><i class="ob-tip-d" style="background:${c}"></i>${l} ${val(x)}</div>`;
        let s = `<div class="ob-tip-t">${stampKST(this._tAt(i), true)} KST</div>`
              + row(C_OBS, "관측", o);
        if (h != null) s += row(this._cHis(), "모델 과거", h);
        if (f != null) s += row(this._cFcs(), "모델 예측", f);
        if (df != null) {
            s += `<div class="ob-tip-r" style="color:rgba(232,238,246,.5)">`
               + `차 ${df >= 0 ? "+" : ""}${fmt(df, M.nd)} ${P.unit}</div>`;
        }
        this.tip.innerHTML = s;
        const bw = this.tip.offsetWidth || 120;
        this.tip.style.left = clamp(px, bw / 2 + 4, w - bw / 2 - 4) + "px";
        this.tip.style.top = Math.max(py - 10, 26) + "px";
        this.tip.classList.add("on");
    }

    // ── 배선 ─────────────────────────────────────────────────────────
    _bindUI() {
        if (this.ui.q) this.ui.q.oninput = (e) => { this.q = e.target.value; this._renderList(); };
        if (this.ui.sort) this.ui.sort.onchange = (e) => { this.sortBy = e.target.value; this._renderList(); };
        const dx = $("ob-dx");
        if (dx) dx.onclick = () => this._closeDetail();
    }
}
