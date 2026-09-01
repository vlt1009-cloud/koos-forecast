/* 지점 조회 — 지도를 누르면 그 자리의 **모든 모델·모든 변수**가 뜬다.

   색칠판은 한 번에 변수 하나만 보여 준다. 그래서 "지금 이 앞바다가 어떤
   상태냐"를 알려면 탭을 열일곱 번 눌러야 했다. 여기서는 한 번 누르면 세
   모델 값이 한 창에 같이 뜬다.

   ── 어디서 읽어 오나
   격자 청크(한 시각 × 격자 전체)로 한 지점의 시계열을 뽑으려면 파일 17개를
   받아야 한다. 세 모델 전부면 44MB — 누를 때마다 그럴 수는 없다. 그래서
   축을 뒤집은 **지점판**을 따로 굽는다 (pipeline/encode_points.py).
   한 지점의 97시간이 연달아 놓이고 공간은 12km 남짓마다 하나만 남긴다.
   변수 하나가 100~900KB 라 한 번 받으면 그 뒤로는 어디를 눌러도 즉시 뜬다.

   그래서 팝업 숫자는 상태줄(마우스 올렸을 때)의 원해상도 값과 소수점
   아래가 조금 다를 수 있다. 같은 코드·같은 역양자화를 쓰므로 어긋나는
   것은 **어느 격자칸을 집었느냐**뿐이다.

   ── 시간을 맞추는 법
   모델마다 사이클이 다를 수 있다 (MOHID 는 하루이틀 늦다). 그래서 "지금
   보고 있는 스텝"을 그대로 세 모델에 쓰면 안 된다. 활성 모델의 스텝을
   **절대시각**으로 바꾼 뒤 모델마다 자기 t0 로 다시 스텝을 센다. 범위를
   벗어나면 값 대신 그렇다고 적는다.

   ── 화면 둘
   작은 팝업은 **모델을 세로 칸으로 나란히** 놓는다. 한 줄에 하나씩 쌓으면
   변수 열셋이 세로로 400px 넘게 늘어져 지도를 다 가린다.
   자세히 보기는 큰 창 하나다. 변수마다 쪼그만 그래프를 늘어놓되 축 눈금에
   숫자를 붙일 만한 크기(가로 300px 이상)를 확보하고, 모자라면 칸 수를
   줄인다 — 작게 많이 넣는 것보다 읽히는 게 먼저다. */

import { codeToValue } from "./store.js";
import { DIRMODE, bearing, compass } from "./dirconv.js";

const HOUR = 3600e3;
const KSTMS = 9 * HOUR;
const WD = ["일", "월", "화", "수", "목", "금", "토"];

const C_MOD = "#F2B33D";        // 모델 (색을 못 찾았을 때만 쓰는 기본값)
/* 관측은 **자홍**이다. 파랑은 WRF 색(밝은 하늘색)과 구별이 안 됐고 흰색은
   눈금·글씨와 섞여 볼품이 없었다. 모델 셋(하늘·민트·주황) 어느 쪽과도
   색상환에서 멀리 떨어진 자리가 여기다. */
const C_OBS = "#ff4fa3";        // 관측
const NEAR_KM = 25;             // 이 안에 관측소가 있으면 시계열에 얹는다

const PANEL_MIN = 300;          // 이보다 좁아지면 칸 수를 줄인다
const PANEL_MIN2 = 200;         // 모델별 한 줄 안에서는 여기까지 붙인다
const PANEL_H = 176;            // 칸 높이 기본값 (창 높이에 맞춰 늘린다)
const PANEL_HMAX = 300;
const BAND_H = 24;              // 모델 이름 줄 높이

/* 모델 색은 좌상단 모델 단추와 **같은 색**이다 (style.css 의 --wrf/--swan/
   --mohid). 거기서 읽어 오므로 한쪽만 고쳐 어긋나는 일이 없다. 못 읽으면
   (스타일이 아직 안 붙었거나 시험용 가짜 DOM) 아래 표로 떨어진다. */
const MCOL_FB = { wrf: "#5bc8ff", swan: "#7ee0a8", mohid: "#ffb454" };
const MCOL = {};
function mcol(m) {
    if (m in MCOL) return MCOL[m];
    let v = "";
    try {
        v = getComputedStyle(document.documentElement)
            .getPropertyValue("--" + m).trim();
    } catch (e) { v = ""; }
    return (MCOL[m] = v || MCOL_FB[m] || C_MOD);
}
/** 같은 색을 옅게 (칸 바탕·눈금에 쓴다). */
function mcolA(m, a) {
    const c = mcol(m);
    const h = /^#([0-9a-f]{6})$/i.exec(c);
    if (!h) return c;
    const n = parseInt(h[1], 16);
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function nice(v) {
    const a = Math.abs(v);
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(a % 1 ? 1 : 0);
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
}

function kst(d) {
    const k = new Date(d.getTime() + KSTMS);
    return { M: k.getUTCMonth() + 1, D: k.getUTCDate(), h: k.getUTCHours(),
             w: WD[k.getUTCDay()] };
}
const stamp = (d) => { const k = kst(d);
    return `${k.M}/${k.D}(${k.w}) ${String(k.h).padStart(2, "0")}시`; };

function km(a, b, c, d) {                       // 대충 거리(km). 우리 위도에서 충분하다
    const y = (a - c) * 111.2;
    const x = (b - d) * 111.2 * Math.cos((a + c) / 2 * Math.PI / 180);
    return Math.hypot(x, y);
}

/** 눈금값 서너 개. 1·2·5 배수로 떨어뜨려야 축 숫자가 읽힌다. */
function ticks(lo, hi, want = 4) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / want;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
                                   .find((s) => span / s <= want + 0.5) || 10 * mag;
    const out = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(t);
    return out;
}

/* 방위각을 가리키는 화살표. 북(위)을 기준으로 시계 방향으로 돌린다 —
   방위각 정의와 CSS rotate 가 마침 같은 방향이라 각을 그대로 넣으면 된다. */
function arrowEl(deg) {
    const w = document.createElement("span");
    w.className = "pt-ar";
    w.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true">'
        + '<path d="M6 10.5V2.2M6 1.2 2.9 5.1M6 1.2 9.1 5.1"'
        + ' fill="none" stroke="currentColor" stroke-width="1.7"'
        + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
    w.style.transform = `rotate(${deg.toFixed(0)}deg)`;
    return w;
}

/** 캔버스에 그리는 같은 화살표 (길이 len px). */
function arrowPath(g, x, y, deg, len) {
    const r = deg * Math.PI / 180;
    const ux = Math.sin(r), uy = -Math.cos(r);      // 방위각 -> 화면 벡터
    const hx = x + ux * len / 2, hy = y + uy * len / 2;
    const tx = x - ux * len / 2, ty = y - uy * len / 2;
    g.beginPath();
    g.moveTo(tx, ty); g.lineTo(hx, hy);
    const h = len * 0.42;
    for (const a of [2.5, -2.5])
        g.lineTo(hx + Math.sin(r + a) * h, hy - Math.cos(r + a) * h), g.moveTo(hx, hy);
    g.stroke();
}

function mk(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
}


/* 코드 -> 실수. 0 은 결측이라 NaN 으로 편다. 여기서 한 번만 펴 두면
   그리기·값읽기·화살표가 같은 배열을 본다 (예전엔 세 군데서 따로 풀었다). */
function toReal(q, sp, lev) {
    const n = q.length, out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = q[k] ? codeToValue(sp, q[k], lev) : NaN;
    return out;
}

export class PointInfo {
    /**
     * @param {object} o  { store, map, cellAt(lng,lat,model), ensureGeom(model),
     *                      getStep(), onSeek(step), getModel() }
     */
    constructor(o) {
        this.o = o;
        this.store = o.store;
        this.map = o.map;
        this.obs = null;                 // koos.js 가 준비되면 꽂아 준다
        this.at = null;                  // {lng,lat}  누른 자리 — 값을 뜨는 기준
        this.mark = null;                // {lng,lat}  표식 자리 (아래 _snap)
        this.gen = 0;
        this.series = new Map();         // "model/var" -> Float32Array | null (결측 NaN)
        this.pop = null;
        this.det = null;                 // 상세 창 DOM
        this.detOpen = false;
        this.station = null;             // 가까운 관측소 (있으면)
        this.snap = null;                // 표식을 격자칸으로 옮겼으면 {km,model}
        this.obsPay = null;
        this._reopen = false;
        window.addEventListener("resize", () => this._drawDetail());
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.detOpen) this.closeDetail();
        });
    }

    // ── 지점판 읽기 ──────────────────────────────────────────────────
    /** 이 모델 지점판에서 (lng,lat) 이 몇 번째 지점인가. 밖이면 null. */
    _idx(model, lng, lat) {
        const pt = this.store.ptMeta(model);
        if (!pt) return null;
        const k = this.o.cellAt(lng, lat, model);
        if (k == null) return null;
        const g = this.store.grids[model];
        const i = k % g.nx, j = (k - i) / g.nx;
        const id = Math.min(pt.nx - 1, Math.floor(i / pt.stride));
        const jd = Math.min(pt.ny - 1, Math.floor(j / pt.stride));
        return jd * pt.nx + id;
    }

    /** 지점판이 이 블록에서 **실제로 읽는 칸**의 경위도.

        지점판은 서너 칸에 하나만 남긴 판이다 (SWAN 은 6칸 = 12km 마다).
        그래서 누른 자리와 값을 뜬 칸이 최대 반 블록(SWAN 이면 4km) 어긋
        난다. 색칠판은 누른 칸을 칠하니, 파고처럼 해안에서 급히 꺾이는 값은
        같은 자리에서 색은 0.4m 인데 팝업은 1.5m 라고 적는다 — 실제로 27일
        예보 48스텝의 이 어긋남이 99퍼센타일 0.35m, 최대 2.07m (0~5m 컬러바의
        41%) 였다. 시각별로 봉우리가 오는 시간까지 달라지니 "시계열이랑
        컬러맵이 안 맞는다, 순서가 뒤엉켰다"로 읽힌다.

        그래서 **표식만** 읽은 칸으로 옮긴다. 그러면 팝업의 활성 모델
        숫자와 표식 자리 색이 같은 칸 값이다. 값을 뜨는 기준(this.at)은
        누른 자리 그대로 둔다 — 표식까지 따라 옮기면 다른 모델의 블록이
        같이 밀려서, 바다를 눌렀는데 SWAN·MOHID 만 육지로 뜨는 일이
        생긴다 (실제로 시험에서 그렇게 걸렸다).
        옛 사이클(cells.br 이 없는 판)이면 null 을 주고 표식을 안 옮긴다. */
    async _snap(model, lng, lat) {
        const cp = this.store.ptCells(model);
        if (!cp) return null;
        const idx = this._idx(model, lng, lat);
        if (idx == null) return null;
        let cells;
        try { cells = await cp; } catch (e) { return null; }
        if (!cells || idx >= cells.length) return null;
        const ll = this.o.cellLngLat && this.o.cellLngLat(model, cells[idx]);
        if (!ll || !isFinite(ll[0]) || !isFinite(ll[1])) return null;
        return { lng: ll[0], lat: ll[1], km: km(lat, lng, ll[1], ll[0]) };
    }

    /** 한 변수의 이 지점 시계열 — **실수값** Float32Array. 결측은 NaN.

        예전엔 uint8 코드를 그대로 넘겨 그릴 때마다 풀었다. 그런데 그 코드는
        변수의 전체 범위를 254칸으로 나눈 것이라, 한 지점이 나흘 동안 훑는
        폭이 몇 칸 안 된다 — 실제로 재 보니 SWAN swell 10칸, 파고 24칸,
        WRF 기온 13칸이고 1시간 변화의 중앙값은 0칸이었다. 176px 높이 그림에
        올리면 8~17px 짜리 계단이 그대로 보인다. 값이 틀린 게 아니라 **해상도가
        모자란** 것이다.

        그래서 팝업 전용 정밀 타일(12비트, 4095칸)이 있으면 그쪽을 먼저 쓴다.
        타일 한 장이 대표칸 16×16 의 모든 변수를 담으므로, 모델 하나 눌러도
        받는 건 수십 KB 다 (거친 판 전체는 8.5MB). 타일이 없거나(옛 사이클,
        대표칸이 바뀌어 무효가 된 경우) 그 변수가 안 들어 있으면 거친 판으로
        되돌아간다 — 계단은 지지만 값은 늘 제자리 칸의 것이다. */
    async _series(model, v, lng, lat) {
        const idx = this._idx(model, lng, lat);
        if (idx == null) return null;
        const sp = this.store.spec(model, v);
        const fine = await this._fine(model, v, idx);
        if (fine) return fine.map(sp);
        const { hdr, q } = await this.store.point(model, v);
        if (idx >= hdr.nf) return null;
        return toReal(q.subarray(idx * hdr.nn, (idx + 1) * hdr.nn), sp, 254);
    }

    /** 정밀 타일에서 이 지점·이 변수의 코드를 꺼낸다. 못 꺼내면 null. */
    async _fine(model, v, idx) {
        const f = this.store.ptFine(model);
        const pt = this.store.ptMeta(model);
        if (!f || !pt || !(f.vars || []).includes(v)) return null;
        const T = f.tile;
        const id = idx % pt.nx, jd = (idx - id) / pt.nx;
        const tx = Math.floor(id / T), ty = Math.floor(jd / T);
        let tile;
        try { tile = await this.store.ptTile(model, ty, tx); } catch (e) { return null; }
        if (!tile) return null;
        const u = tile.planes[v];
        const nxl = Math.min(T, pt.nx - tx * T);
        const k = (jd - ty * T) * nxl + (id - tx * T);
        if (!u || k < 0 || k >= tile.hdr.npt) return null;
        const c = u.subarray(k * tile.hdr.nt, (k + 1) * tile.hdr.nt);
        return { map: (sp) => toReal(c, sp, tile.hdr.lev) };
    }

    /** 모델별 표시 변수 순서. 색칠판 차례를 따르고 방향은 짝에 붙인다. */
    _rows(model) {
        const mm = this.store.manifest.models[model];
        const pt = mm.pt;
        if (!pt) return [];
        const dir = (mm.vector || [])[1];
        const has = (v) => pt.vars.includes(v);
        return mm.order.filter(has).map((v) => ({
            v, dir: dir && has(dir) && (mm.vector || [])[0] === v ? dir : null,
        }));
    }

    /** 활성 모델의 스텝 -> 이 모델의 스텝. 범위 밖이면 null. */
    _stepOf(model, tAbs) {
        const t0 = Date.parse(this.store.manifest.models[model].t0
                              || this.store.manifest.t0);
        const s = Math.round((tAbs - t0) / (this.store.manifest.dt * 1000));
        return (s >= 0 && s < this.store.manifest.nstep) ? s : null;
    }

    _tAbs() {
        return this.store.time(this.o.getStep(), this.o.getModel()).getTime();
    }

    /** 화면 위쪽 절반을 누르면 창을 아래로, 아래쪽을 누르면 위로 편다.
        좌우도 같은 식으로 가장자리에서만 안쪽으로 밀어 준다. 규칙이 단순해야
        누를 때마다 창이 어디로 열릴지 예측이 된다. */
    _pickAnchor(lngLat) {
        try {
            const c = this.map.getContainer();
            const p = this.map.project(lngLat);
            const w = c.clientWidth || 1200, h = c.clientHeight || 800;
            const v = p.y < h / 2 ? "top" : "bottom";       // 위 절반 -> 아래로 펴짐
            if (p.x < w * 0.22) return v + "-left";
            if (p.x > w * 0.78) return v + "-right";
            return v;
        } catch (e) { return "bottom"; }
    }

    // ── 팝업 ─────────────────────────────────────────────────────────
    async open(lngLat) {
        const my = ++this.gen;
        this.series.clear();
        this.snap = null;
        this.station = null;
        this.obsPay = null;

        if (!this.pop) {
            /* anchor 는 열 때마다 우리가 정한다 (아래 pickAnchor).
               MapLibre 에 맡기면 창이 들어갈 자리가 있는 한 위쪽을 고집해서,
               화면 윗부분을 누르면 창이 지도 밖으로 잘려 나간다. */
            this.pop = new maplibregl.Popup({
                closeButton: true, closeOnClick: false, maxWidth: "none",
                className: "ptpop", offset: 12,
            });
            /* MapLibre 의 addTo 는 이미 붙어 있으면 먼저 remove() 를 부르고,
               remove() 는 'close' 를 쏜다. 그래서 이 처리기가 방금 잡은
               새 지점을 도로 지워 버렸다 — 팝업이 열려 있는 동안 지도를
               다시 누르면 아무것도 안 뜨던 까닭이 이것이다. */
            this.pop.on("close", () => {
                if (this._reopen) return;
                this.at = null;
                this.mark = null;
                this.closeDetail();
            });
        }
        this.body = mk("div", "pt-in");
        this._reopen = true;
        this.pop.options.anchor = this._pickAnchor(lngLat);
        this.pop.setLngLat(lngLat).setDOMContent(this.body).addTo(this.map);
        this._reopen = false;
        this.at = { lng: lngLat.lng, lat: lngLat.lat };
        this.mark = this.at;
        this._sm = null;                                // 새 지점 — 도장을 지운다
        this._paint();                                  // 뼈대 먼저 (즉시 반응)
        if (this.detOpen) this._drawDetail();           // 열려 있으면 새 지점으로 갈아 끼운다

        // WRF 곡선격자는 조회표가 있어야 지점을 찾는다.
        for (const m of this.store.manifest.model_order) {
            try { await this.o.ensureGeom(m); } catch (e) { /* 없으면 그 모델만 빈다 */ }
            if (my !== this.gen) return;
        }
        /* 표식을 지점판이 실제로 읽는 칸으로 옮긴다 (_snap 설명 참고).
           격자 조회표가 있어야 하므로 ensureGeom 뒤다. 맞출 수 있는 건
           활성 모델 하나뿐이다 — 세 모델의 대표 칸이 같은 자리일 리 없다. */
        this.snap = null;
        try {
            const sn = await this._snap(this.o.getModel(),
                                        this.at.lng, this.at.lat);
            if (my !== this.gen) return;
            if (sn && sn.km > 0.05) {
                this.mark = { lng: sn.lng, lat: sn.lat };
                this.snap = { km: sn.km, model: this.o.getModel() };
                this._reopen = true;
                this.pop.setLngLat(this.mark);
                this._reopen = false;
                this._paint();
            }
        } catch (e) { /* 못 맞추면 누른 자리 그대로 */ }

        this._findStation();

        // 변수를 받는 대로 칸을 채운다. 활성 모델부터.
        const order = [this.o.getModel(),
                       ...this.store.manifest.model_order.filter((m) => m !== this.o.getModel())];
        for (const m of order) {
            const want = [];
            for (const r of this._rows(m)) { want.push(r.v); if (r.dir) want.push(r.dir); }
            await Promise.all(want.map(async (v) => {
                try {
                    const s = await this._series(m, v, this.at.lng, this.at.lat);
                    if (my !== this.gen) return;
                    this.series.set(`${m}/${v}`, s);
                } catch (e) {
                    if (my === this.gen) this.series.set(`${m}/${v}`, null);
                }
            }));
            if (my !== this.gen) return;
            this._paint();
            if (this.detOpen) this._drawDetail();
        }
        if (this.detOpen) this._loadObs(my);
    }

    close() {
        if (this.pop) this.pop.remove();
        this.at = this.mark = null;
        this.closeDetail();
    }

    /** 시간이 바뀌면 숫자만 갈아 끼운다 (자료는 이미 다 들고 있다).
        재생 중에는 매 화면갱신마다 불린다 — 정시가 안 바뀌었으면 그냥
        나간다. 안 그러면 창 하나 띄워 둔 채 재생할 때 초당 60번 DOM 을
        다시 짜느라 색칠판까지 같이 버벅인다. */
    setStep() {
        if (!this.at) return;
        const s = this.o.getStep();
        if (s === this._sm) return;
        this._sm = s;
        this._paint();
        this._drawDetail();
    }

    _val(model, v, sm) {
        const s = this.series.get(`${model}/${v}`);
        if (s === undefined) return { s: "…" };
        if (s === null || sm == null) return { s: "—" };
        const x = s[sm];
        if (!isFinite(x)) {
            /* 코드 0 은 "값이 없다"일 뿐 육지라는 뜻이 아니다. 같은 지점이
               다른 시각에는 값을 가졌다면 바다인데 이 시각만 빈 것이다 —
               시간축 앞머리(직전 사이클분)에 원본 파일이 없던 때가 그렇다.
               둘을 같은 말로 적으면 결측을 육지로 읽는다. */
            return { s: s.some((k) => isFinite(k)) ? "결측" : "육지" };
        }
        const sp = this.store.spec(model, v);
        if (sp.kind === "dir") {
            const b = bearing(x, DIRMODE[`${model}.${v}`] || "to");
            /* deg 는 규약대로 적는 각(풍향·파향은 오는 쪽), tw 는 화살표가
               가리킬 각(실제로 움직이는 쪽 = 지도 입자와 같은 방향). 둘을
               섞으면 화살표와 입자가 정반대로 간다. */
            return { s: `${b.toFixed(0)}° ${compass(b)}`, x,
                     deg: b, tw: bearing(x, "to") };
        }
        return { s: `${nice(x)} ${sp.unit}`, x };
    }

    /* 모델을 가로로 나란히 놓는다. 세로로 쌓으면 변수 열셋이 400px 을
       넘겨 지도를 덮는다. 칸 하나 = 이름 한 줄 + 값 한 줄. */
    _paint() {
        if (!this.body || !this.at) return;
        const B = this.body;
        B.innerHTML = "";
        const tAbs = this._tAbs();

        const h = mk("div", "pt-h");
        h.append(mk("b", null,
                    `${this.mark.lat.toFixed(2)}°N ${this.mark.lng.toFixed(2)}°E`),
                 mk("span", null, `${stamp(new Date(tAbs))} KST`));
        B.appendChild(h);
        /* 표식을 옮겼으면 얼마나 옮겼는지 적는다. 안 적으면 누른 자리에서
           표식이 슬쩍 밀린 게 버그로 보인다. */
        if (this.snap)
            B.appendChild(mk("div", "pt-snap",
                `표식 = ${this.store.manifest.models[this.snap.model].label} `
                + `격자칸 (누른 자리에서 ${this.snap.km.toFixed(1)}km) · `
                + "색칠판과 같은 칸"));

        const cols = mk("div", "pt-cols");
        for (const m of this.store.manifest.model_order) {
            const rows = this._rows(m);
            if (!rows.length) continue;
            const mm = this.store.manifest.models[m];
            const sm = this._stepOf(m, tAbs);
            const c = mk("div", "pt-c");
            const cn = mk("div", "pt-cn");
            const cnm = mk("span", null, mm.label);
            cnm.style.color = mcol(m);          // 좌상단 모델 단추와 같은 색
            cn.append(cnm);
            if (sm == null) cn.append(mk("u", null, "이 시각 없음"));
            c.appendChild(cn);
            for (const r of rows) {
                const sp = this.store.spec(m, r.v);
                const cell = mk("div", "pt-e");
                cell.appendChild(mk("div", "pt-el", sp.label));
                cell.appendChild(mk("div", "pt-ev", this._val(m, r.v, sm).s));
                if (r.dir) {
                    const d = this._val(m, r.dir, sm);
                    if (d.x !== undefined) {
                        const dv = mk("div", "pt-ed");
                        dv.append(arrowEl(d.tw), mk("span", null, `${d.deg.toFixed(0)}°`));
                        cell.appendChild(dv);
                    }
                }
                c.appendChild(cell);
            }
            cols.appendChild(c);
        }
        B.appendChild(cols);

        const f = mk("div", "pt-f");
        const b = mk("button", "pt-more", this.detOpen ? "시계열 닫기" : "시계열 자세히 보기");
        b.type = "button";
        b.onclick = () => (this.detOpen ? this.closeDetail() : this.openDetail());
        f.appendChild(b);
        if (this.station)
            f.appendChild(mk("i", null, `${this.station.name} ${this.station.km.toFixed(0)}km`));
        B.appendChild(f);
    }

    // ── 가까운 관측소 ────────────────────────────────────────────────
    _findStation() {
        this.station = null;
        const list = this.obs && this.obs.stations;
        if (!list || !list.length || !this.at) return;
        let best = null, bd = NEAR_KM;
        for (const s of list) {
            const d = km(this.at.lat, this.at.lng, s.lat, s.lon);
            if (d < bd) { bd = d; best = s; }
        }
        if (best) this.station = Object.assign({ km: bd }, best);
    }

    // ── 상세 (시계열) — 큰 창 하나 ───────────────────────────────────
    async openDetail() {
        if (!this.det) {
            this.det = mk("div", "ptd");
            const box = mk("div", "ptd-in glass");
            const head = mk("div", "ptd-head");
            this.detTitle = mk("div", "ptd-nm", "—");
            /* 범례는 그릴 때마다 다시 짠다 — 어느 모델이 걸렸는지, 관측이
               붙었는지가 지점마다 다르다. */
            const leg = mk("div", "ptd-leg");
            this.legBox = leg;
            const x = mk("button", "ptd-x");
            x.type = "button"; x.textContent = "✕"; x.title = "닫기 (Esc)";
            x.onclick = () => this.closeDetail();
            head.append(this.detTitle, leg, x);
            this.detHead = head;
            this.detCv = mk("canvas", "ptd-cv");
            this.detBody = mk("div", "ptd-body");
            this.detBody.appendChild(this.detCv);
            box.append(head, this.detBody);
            this.det.appendChild(box);
            document.body.appendChild(this.det);
            this.det.addEventListener("click", (e) => {
                if (e.target === this.det) this.closeDetail();
            });
            this.detCv.addEventListener("click", (e) => this._seekFromChart(e));
        }
        this.detOpen = true;
        this.det.hidden = false;
        this._paint();
        this._drawDetail();
        this._loadObs(this.gen);
    }

    /** 관측은 있는 만큼만. 가까운 관측소가 있으면 그 시계열을 받아 얹는다. */
    async _loadObs(my) {
        if (!this.station || this.obsPay) return;
        const id = this.station.id;
        try {
            this.obsPay = await this.store.json(`ts/${id}.json.br`);
        } catch (e) { this.obsPay = null; }
        if (my === this.gen && this.detOpen) this._drawDetail();
    }

    closeDetail() {
        this.detOpen = false;
        if (this.det) this.det.hidden = true;
        if (this.at) this._paint();
    }

    /** 그릴 줄들: {model, v, label, unit, mod:[{t,y}], obs:[{t,y}]} */
    _lines() {
        const out = [];
        const dt = this.store.manifest.dt * 1000;
        const ep = this.obs ? this.obs.epoch : 0;
        for (const m of this.store.manifest.model_order) {
            const t0 = Date.parse(this.store.manifest.models[m].t0
                                  || this.store.manifest.t0);
            const mm = this.store.manifest.models[m];
            for (const r of this._rows(m)) {
                const s = this.series.get(`${m}/${r.v}`);
                if (!s) continue;
                const sp = this.store.spec(m, r.v);   // 이름·단위를 여기서 읽는다
                const mod = [];
                for (let k = 0; k < s.length; k++)
                    if (isFinite(s[k])) mod.push({ t: t0 + k * dt, y: s[k] });
                if (!mod.length) continue;
                let obs = null;
                const P = this.obsPay;
                /* 기준면이 다른 변수(조위)는 **편차끼리** 견준다.
                   관측 조위는 약최저저조면(DL)에서 잰 값이라 그 지점 수심이
                   통째로 들어가 있고(어떤 항은 4.7m), MOHID 는 평균해면
                   기준의 해수면 변동만 낸다. 그대로 겹치면 두 선이 몇 미터
                   떨어져 그려져 아무 뜻이 없다. 겹치는 구간 평균을 각각 빼
                   같은 자리에 놓는다 — ts_web.py 가 미리 재 둔 값이다. */
                const an = (P && P.anomaly && P.anomaly[r.v]) || null;
                const oo = an && an.obs != null ? an.obs : 0;
                const mo = an && an[m] != null ? an[m] : 0;
                if (mo) for (const q of mod) q.y -= mo;
                if (P && P.obs && P.obs[r.v]) {
                    obs = [];
                    const a = P.obs[r.v];
                    for (let k = 0; k < a.length; k++)
                        if (a[k] != null) obs.push({ t: ep + (P.t0 + k) * HOUR, y: a[k] - oo });
                    if (!obs.length) obs = null;
                }
                out.push({ model: m, tag: mm.label, v: r.v, label: sp.label,
                           unit: sp.unit, mod, obs, dir: r.dir || null, t0,
                           anom: !!an, mo });
            }
        }
        return out;
    }

    /** 범례. 걸린 모델을 제 색으로 하나씩, 관측이 있으면 관측도. */
    _syncLeg(L) {
        const leg = this.legBox;
        if (!leg) return;
        leg.innerHTML = "";
        const key = (col, t) => {
            const w = mk("span", "ptd-k");
            const d = mk("i"); d.style.background = col;
            const s = mk("span", null, t); s.style.color = col;
            w.append(d, s);
            leg.appendChild(w);
        };
        const seen = new Set();
        for (const l of L) {
            if (seen.has(l.model)) continue;
            seen.add(l.model);
            key(mcol(l.model), `${l.tag} 예측`);
        }
        if (this.obsPay) key(C_OBS, "관측");
    }

    _drawDetail() {
        if (!this.detOpen || !this.det || !this.at) return;
        const L = this._lines();
        this.detTitle.textContent =
            `${this.mark.lat.toFixed(3)}°N ${this.mark.lng.toFixed(3)}°E`
            + (this.station
               ? `   ·   가까운 관측소 ${this.station.name} (${this.station.km.toFixed(0)}km)`
               : "   ·   25km 안에 관측소 없음")
            + (this.snap ? `   ·   ${this.store.manifest.models[this.snap.model].label} 격자칸` : "");
        this._syncLeg(L);

        const cv = this.detCv;
        const W = Math.max(320, this.detBody.clientWidth - 4);
        if (!L.length) { cv.width = 1; cv.height = 1; return; }

        /* 줄을 **모델별로** 나눈다. 열셋을 한 판에 죽 늘어놓으면 어느 게
           어느 모델 건지 알 수 없다 — WRF 다섯, SWAN 넷, MOHID 넷이 섞여
           4열 격자에 담기면 줄이 모델 경계를 가로지른다. 모델마다 제 줄을
           주고 이름표를 붙이면 한눈에 갈린다. 폭이 모자라 한 줄에 다 못
           담으면 그 모델 안에서만 접는다 (모델 경계는 안 넘는다). */
        const GAP = 10;
        const bands = [];
        for (const m of this.store.manifest.model_order) {
            const ls = L.filter((l) => l.model === m);
            if (!ls.length) continue;
            /* 한 줄에 다 담아 본다. 칸이 PANEL_MIN2 밑으로 내려가면
               (좁은 화면) 그때만 접는다 — 축 숫자가 안 읽히는 게 더 나쁘다. */
            let nc = ls.length;
            if ((W - GAP * (nc - 1)) / nc < PANEL_MIN2)
                nc = Math.max(1, Math.floor((W + GAP) / (PANEL_MIN2 + GAP)));
            bands.push({ m, ls, nc, nr: Math.ceil(ls.length / nc),
                         pw: (W - GAP * (nc - 1)) / nc });
        }
        if (!bands.length) { cv.width = 1; cv.height = 1; return; }

        /* 칸 높이는 **창에 남는 만큼** 늘린다. 176px 로 박아 두면 세 줄이
           640px 밖에 안 돼 900px 창 아래가 휑하게 남았다. 줄이 접혀 넘칠
           때는 기본값으로 돌아가고 창이 스크롤된다. */
        const rows = bands.reduce((a, b) => a + b.nr, 0);
        const chrome = bands.length * BAND_H + (bands.length - 1) * GAP * 2
                     + (rows - bands.length) * GAP;
        /* 남는 높이는 창이 아니라 **화면**에서 잰다. 창을 내용에 맞춰
           줄이도록(.ptd-in height:auto) 해 놨기 때문에 창 높이를 물으면
           내용 높이가 되돌아온다 — 서로 물고 도는 계산이 된다. */
        const vh = (typeof window !== "undefined" && window.innerHeight) || 900;
        const headH = (this.detHead && this.detHead.clientHeight) || 52;
        const avail = Math.min(880, vh * 0.92) - headH - 24;   // padding 12*2
        let ph = PANEL_H;
        if (avail > 0)
            ph = Math.max(PANEL_H, Math.min(PANEL_HMAX, (avail - chrome) / rows));
        ph = Math.floor(ph);

        let H = 0;
        for (const b of bands) {
            b.top = H;
            H += BAND_H + b.nr * ph + GAP * (b.nr - 1) + GAP * 2;
        }
        H -= GAP * 2;

        const dpr = window.devicePixelRatio || 1;
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + "px"; cv.style.height = H + "px";
        const g = cv.getContext("2d");
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);

        const [t0, t1] = this._axis(L);
        this._px = [];
        const now = Date.now(), cur = this._tAbs();

        for (const b of bands) {
            this._drawBand(g, b, W, t0, t1);
            b.ls.forEach((l, i) => {
                const px = (i % b.nc) * (b.pw + GAP);
                const py = b.top + BAND_H + Math.floor(i / b.nc) * (ph + GAP);
                this._drawPanel(g, l, px, py, b.pw, ph, t0, t1, now, cur);
            });
        }
    }

    /* x 축 구간. **사이클 규칙**을 따른다 — 매니페스트의 표시 축(사이클
       시작 하루 전 ~ 예보 끝)을 그대로 쓴다.

       모델 예측 구간의 합집합으로 잡으면 안 된다. MOHID 원본이 며칠 늦게
       나오는 날이 있는데, 그러면 그 모델만 옛 사이클에 남아 축이 이틀 더
       왼쪽에서 시작한다 (오늘이 28일인데 24일부터). 정작 봐야 할 앞뒤
       이틀이 그만큼 눌린다. 뒤처진 모델은 제 구간만 그려지고 오른쪽이
       비는데, 그게 사실 그대로다. */
    _axis(L) {
        const man = this.store.manifest;
        const t0 = Date.parse(man.t0);
        const n = man.nstep || 0;
        if (isFinite(t0) && n > 1)
            return [t0, t0 + (n - 1) * man.dt * 1000];
        let a = Infinity, b = -Infinity;         // 매니페스트가 없으면 합집합
        for (const l of L) {
            a = Math.min(a, l.mod[0].t);
            b = Math.max(b, l.mod[l.mod.length - 1].t);
        }
        return [a, b];
    }

    /** 모델 이름 줄. 색은 좌상단 모델 단추와 같다. */
    _drawBand(g, b, W, t0, t1) {
        const mm = this.store.manifest.models[b.m] || {};
        const y = b.top + BAND_H - 8;
        const col = mcol(b.m);

        g.fillStyle = mcolA(b.m, 0.09);
        g.fillRect(0, b.top, W, BAND_H - 6);
        g.fillStyle = col;
        g.fillRect(0, b.top, 3, BAND_H - 6);

        g.textAlign = "left"; g.textBaseline = "alphabetic";
        g.font = "700 12.5px ui-sans-serif,system-ui,sans-serif";
        g.fillStyle = col;
        g.fillText(mm.label || b.m.toUpperCase(), 10, y);
        const w = g.measureText(mm.label || b.m).width;
        g.font = "10.5px ui-sans-serif,system-ui,sans-serif";
        g.fillStyle = mcolA(b.m, 0.6);
        g.fillText(`${b.ls.length}개 변수`, 16 + w, y);

        /* 이 모델이 옛 사이클에 남아 있으면 (MOHID 가 밀리는 날) 축 오른쪽이
           빈 채로 그려진다. 왜 비었는지 여기 적어 둔다. */
        const mt0 = Date.parse(mm.t0 || "");
        const dt = this.store.manifest.dt * 1000;
        const mt1 = mt0 + ((mm.nt || this.store.manifest.nstep || 1) - 1) * dt;
        if (isFinite(mt0) && (mt0 > t0 + dt || mt1 < t1 - dt)) {
            g.textAlign = "right";
            g.fillStyle = "rgba(255,220,140,.72)";
            g.fillText(`${mm.cycle || "옛"} 사이클 · ${stamp(new Date(mt0))}`
                       + ` ~ ${stamp(new Date(mt1))}`, W - 8, y);
            g.textAlign = "left";
        }
    }

    _drawPanel(g, l, px, py, pw, ph, t0, t1, now, cur) {
        const PL = 46, PR = 12, PT = 26, PB = 22;
        const x0 = px + PL, x1 = px + pw - PR;
        const y0 = py + PT, y1 = py + ph - PB;
        const X = (t) => x0 + (t - t0) / (t1 - t0) * (x1 - x0);
        this._px.push({ px, py, pw, ph, x0, x1, t0, t1 });
        const CM = mcol(l.model);               // 이 모델 색 (좌상단과 같다)

        g.fillStyle = "rgba(255,255,255,.035)";
        g.fillRect(px, py, pw, ph);
        g.fillStyle = mcolA(l.model, 0.055);    // 어느 모델 칸인지 바탕으로도
        g.fillRect(px, py, pw, ph);

        // 세로 범위 — 관측까지 포함해서 잡아야 관측선이 밖으로 안 나간다.
        let lo = Infinity, hi = -Infinity;
        const scan = (a) => { if (a) for (const p of a) if (p.t >= t0 && p.t <= t1) {
            if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; } };
        scan(l.mod); scan(l.obs);
        /* 축 구간에 걸치는 값이 하나도 없을 수 있다 — 이 모델이 옛 사이클에
           남아 예보가 이미 끝난 경우다. 그대로 두면 lo 가 Infinity 라 온
           칸이 NaN 으로 사라진다. 왜 비었는지 적고 빠진다. */
        if (!isFinite(lo) || !isFinite(hi)) {
            g.textAlign = "left"; g.textBaseline = "alphabetic";
            g.font = "600 12.5px ui-sans-serif,system-ui,sans-serif";
            g.fillStyle = "rgba(255,255,255,.55)";
            g.fillText(l.label, px + 10, py + 17);
            g.textAlign = "center"; g.textBaseline = "middle";
            g.font = "11.5px ui-sans-serif,system-ui,sans-serif";
            g.fillStyle = "rgba(255,255,255,.32)";
            g.fillText("이 구간에 예측 없음", px + pw / 2, py + ph / 2);
            return;
        }
        if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
        // 방향 화살표를 얹을 칸은 위를 더 비워 둔다 (선과 안 겹치게).
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad * (l.dir ? 2.6 : 1);
        const Y = (y) => y1 - (y - lo) / (hi - lo) * (y1 - y0);

        g.font = "11px ui-sans-serif,system-ui,sans-serif";
        g.textBaseline = "middle";
        g.textAlign = "right";
        for (const t of ticks(lo, hi, 4)) {
            const y = Math.round(Y(t)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.09)"; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
            g.fillStyle = "rgba(255,255,255,.55)";
            g.fillText(nice(t), x0 - 6, y);
        }

        /* 날짜 눈금. 칸 너비에 맞춰 **간격을 고른다**. 12시간으로 박아 두면
           닷새치가 좁은 칸에 들어올 때 글씨가 서로 겹쳐 아무것도 못 읽는다
           (칸이 4열이면 그림폭이 250px 남짓인데 라벨은 10개였다). */
        g.textBaseline = "top";
        g.textAlign = "center";
        const spanH = (t1 - t0) / HOUR;
        const LBLW = 40;                       // "8/28" 한 칸이 차지하는 폭
        let stepH = 3;
        for (const c of [3, 6, 12, 24, 48, 72]) {
            stepH = c;
            if ((x1 - x0) / (spanH / c) >= LBLW) break;
        }
        const d0 = new Date(t0 + KSTMS);
        let tk = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()) - KSTMS;
        while (tk <= t1) {
            const k = kst(new Date(tk));
            const day = k.h === 0;
            // 눈금선은 촘촘해도 되지만 글씨는 고른 간격에서만 찍는다.
            if (tk >= t0 && (day || k.h % 12 === 0)) {
                const x = Math.round(X(tk)) + 0.5;
                g.strokeStyle = day ? "rgba(255,255,255,.16)" : "rgba(255,255,255,.06)";
                g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1 + 3); g.stroke();
            }
            if (tk >= t0 && k.h % stepH === 0) {
                const x = Math.round(X(tk)) + 0.5;
                g.fillStyle = day ? "rgba(255,255,255,.62)" : "rgba(255,255,255,.4)";
                g.fillText(day ? `${k.M}/${k.D}` : `${k.h}시`, x, y1 + 6);
            }
            tk += 3 * HOUR;
        }

        // 지금 · 보고 있는 시각
        if (now > t0 && now < t1) {
            const x = Math.round(X(now)) + 0.5;
            g.strokeStyle = "rgba(120,230,160,.5)"; g.lineWidth = 1;
            g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke();
        }
        if (cur > t0 && cur < t1) {
            const x = Math.round(X(cur)) + 0.5;
            g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 1;
            g.setLineDash([4, 3]);
            g.beginPath(); g.moveTo(x, y0 - 6); g.lineTo(x, y1); g.stroke();
            g.setLineDash([]);
        }

        const line = (a, col, w) => {
            if (!a || a.length < 2) return;
            g.strokeStyle = col; g.lineWidth = w;
            g.lineJoin = "round"; g.lineCap = "round";
            g.beginPath();
            let on = false;
            for (const p of a) {
                if (p.t < t0 || p.t > t1) { on = false; continue; }
                const x = X(p.t), y = Y(p.y);
                if (on) g.lineTo(x, y); else { g.moveTo(x, y); on = true; }
            }
            g.stroke();
        };
        line(l.obs, C_OBS, 2.2);
        line(l.mod, CM, 1.8);

        /* 방향은 선으로 그리면 0/360 에서 위아래로 튀어 못 읽는다. 값 칸
           위쪽에 화살표를 일정 간격으로 눕혀 흐름이 도는 모양을 보인다.
           가리키는 쪽은 지도 입자와 같은 **가는 쪽**이다. */
        if (l.dir) {
            const ds = this.series.get(`${l.model}/${l.dir}`);
            const dt = this.store.manifest.dt * 1000;
            if (ds) {
                const n = Math.max(2, Math.floor((x1 - x0) / 30));
                g.strokeStyle = mcolA(l.model, 0.8); g.lineWidth = 1.4;
                g.lineCap = "round"; g.lineJoin = "round";
                for (let a = 0; a <= n; a++) {
                    const t = t0 + (t1 - t0) * a / n;
                    const k = Math.round((t - l.t0) / dt);
                    if (k < 0 || k >= ds.length || !isFinite(ds[k])) continue;
                    arrowPath(g, X(t), y0 + 9, bearing(ds[k], "to"), 11);
                }
            }
        }

        // 이름 · 단위 · 지금 값
        const sm = this._stepOf(l.model, cur);
        const vv = this._val(l.model, l.v, sm);
        // 그림이 편차면 머리에 적는 숫자도 편차여야 한다 (안 그러면 선과 어긋난다)
        const vs = l.anom && vv.x !== undefined
            ? `${nice(vv.x - l.mo)} ${l.unit}` : vv.s;
        g.textBaseline = "alphabetic";
        g.textAlign = "left";
        g.font = "600 12.5px ui-sans-serif,system-ui,sans-serif";
        g.fillStyle = "rgba(255,255,255,.92)";
        g.fillText(l.label, px + 10, py + 17);
        const wlab = g.measureText(l.label).width;
        // 모델 이름은 칸마다 안 적는다 — 줄 머리(_drawBand)에 한 번 있다.
        const sub = (l.unit || "") + (l.anom ? " · 편차" : "");
        if (sub.trim()) {
            g.font = "10.5px ui-sans-serif,system-ui,sans-serif";
            g.fillStyle = l.anom ? "rgba(255,220,140,.7)" : "rgba(255,255,255,.4)";
            g.fillText(sub, px + 14 + wlab, py + 17);
        }
        g.textAlign = "right";
        g.font = "600 12.5px ui-sans-serif,system-ui,sans-serif";
        g.fillStyle = CM;
        g.fillText(vs, px + pw - 10, py + 17);
    }

    /** 그래프를 누르면 그 시각으로 간다. */
    _seekFromChart(e) {
        if (!this._px || !this._px.length || !this.o.onSeek) return;
        const r = this.detCv.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const p = this._px.find((q) => mx >= q.px && mx <= q.px + q.pw
                                    && my >= q.py && my <= q.py + q.ph);
        if (!p) return;
        const u = (mx - p.x0) / (p.x1 - p.x0);
        if (u < 0 || u > 1) return;
        const t = p.t0 + u * (p.t1 - p.t0);
        const s = this._stepOf(this.o.getModel(), t);
        if (s != null) this.o.onSeek(s);
    }
}
