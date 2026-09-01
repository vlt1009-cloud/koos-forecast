/* 자료 계층. 매니페스트 · 격자 · 청크 캐시 · 워커 풀.

   청크 하나 = 한 변수 6프레임. SWAN 은 720×712 니까 한 청크가 3.1MB 이고
   한 변수를 통째로 들면 52MB 다. 그래서 LRU 로 상한을 둔다. 재생 중에는
   앞쪽을 미리 받아 두어야 끊기지 않으므로, 상한은 "지금 보는 변수 한 벌 +
   조금" 정도로 잡았다.

   워커는 4개. brotli 해제 + 역델타가 청크당 20~40ms 걸리는데, 이걸 메인
   스레드에서 하면 재생이 눈에 띄게 튄다. 워커에서 uint8 그대로 넘겨받아
   바로 GPU 텍스처로 올린다 — 메인 스레드는 float 로 펴지 않는다. */

const NWORKER = 4;

/* LRU 상한. 예전에는 "40개"로 세었는데, 그러면 4배속 재생이 영원히 안 부드러워
   진다. 한 변수 121스텝이 21청크고 색칠판·속력·방향 셋을 같이 보므로 한 바퀴에
   63청크가 필요하다 — 40개 상한이면 앞머리가 늘 쫓겨나 두 바퀴째도 처음부터
   다시 받는다. 개수가 아니라 **바이트**로 재고, 한 바퀴가 통째로 들어가게
   잡는다 (SWAN 청크가 720x712x6 = 2.9MiB 로 제일 크다. 63개 = 185MiB).
   WRF·MOHID 는 청크가 0.75MiB 라 세 변수를 다 들어도 47MiB 다. */
const MAX_BYTES = 220 * 1024 * 1024;
const MAX_CHUNKS = 128;

export class Store {
    constructor(base = "data") {
        this.base = base;
        this.manifest = null;
        this.grids = {};
        this._chunks = new Map();       // "model/var/ci" -> Promise<{hdr,q}>
        this._size = new Map();         // 같은 키 -> 푼 바이트 (0 = 아직 오는 중)
        this._points = new Map();       // "model/var" -> Promise<{hdr,q}>  (지점판)
        this._lru = [];
        this._workers = [];
        this._busy = [];                // 워커별 "지금 일하는 중"
        this._q = [];                   // 대기줄. 급한 것이 앞에 선다.
        this._seq = 0;
        this._pending = new Map();
        this.wasmUsed = false;
    }

    async init() {
        const r = await fetch(`${this.base}/manifest.json`, { cache: "no-cache" });
        if (!r.ok) throw new Error(`매니페스트를 못 읽었다 (${r.status})`);
        this.manifest = await r.json();

        /* 예측장은 날마다 **같은 경로에 덮어쓴다**. 그대로 두면 CDN 이나
           브라우저가 어제 것을 그대로 물고 있어도 알 길이 없다 — 화면은
           멀쩡한데 하루 늦은 예보를 보여 준다. 그래서 매니페스트에서 읽은
           도장을 모든 자료 URL 뒤에 붙인다. 매니페스트만 no-cache 로
           받으면 나머지는 영원히 캐시해도 안전하다.

           도장은 **사이클이 아니라 자료 내용의 지문**이다 (manifest.build).
           사이클로 찍으면, 같은 사이클 안에서 다시 인코딩했을 때 주소가
           그대로라 브라우저가 아침 청크를 계속 물고 있는다. 청크는 6칸
           단위라 새로 받은 청크와 묵은 청크의 이음매가 딱 6칸 경계에
           떨어진다 — "26일 23시와 27일 00시가 완전 딴 시점" 이 그거였다. */
        this.v = this.manifest.build || this.manifest.cycle
              || this.manifest.generated || "";

        for (const m of this.manifest.model_order) {
            const g = await fetch(this.url(`${m}/grid.json`)).then(x => x.json());
            this.grids[m] = g;
        }
        for (let i = 0; i < NWORKER; i++) {
            /* 워커 주소는 **이 모듈 기준**으로 잡는다. 그냥 문자열로 주면
               문서(HTML) 기준이라, /v2/ 처럼 다른 경로에 얹은 페이지에서는
               /v2/chunk_worker.js 를 찾다가 404 로 죽는다. */
            const w = new Worker(new URL("chunk_worker.js", import.meta.url),
                                 { type: "module" });
            w.onmessage = (e) => this._onmsg(e.data);
            this._workers.push(w);
            this._busy.push(false);
        }
        return this;
    }

    _onmsg(d) {
        const p = this._pending.get(d.id);
        if (!p) return;
        this._pending.delete(d.id);
        this._busy[p.w] = false;
        this._pump();
        if (d.ok) {
            if (d.wasm) this.wasmUsed = true;
            if (d.raw) p.res(d.raw);
            else if (d.obj !== undefined) p.res(d.obj);
            else p.res({ hdr: d.hdr, q: d.q });
        } else p.rej(new Error(d.error));
    }

    /* 워커에 **바로** 던지지 않고 대기줄을 거친다.

       예전에는 요청이 오는 대로 워커 4개에 돌아가며 꽂았다. 그런데 재생 중
       apply() 는 앞을 데우는 요청(prefetch)을 먼저 걸고 지금 칸을 부른다 —
       일부러 그렇게 해 뒀다. 그러면 지금 당장 필요한 청크가 앞을 데우는
       청크 열두 개 **뒤에** 줄을 서게 된다. 워커 하나가 청크 하나에
       회선왕복+brotli 로 100~200ms 를 쓰니, 6칸마다 꼬박 한 번씩 색칠판이
       멎었다. 입자는 CPU 적분이라 안 멎으니 "입자는 부드러운데 컬러맵만
       툭툭" 하는 그 증상이 정확히 이거다.

       그래서 두 가지를 둔다.
         1) 급한 것(prio)은 대기줄 **맨 앞**에 선다.
         2) 데우는 것은 워커를 다 채우지 않는다 — 하나는 늘 비워 둬서,
            급한 요청이 오면 기다림 없이 바로 시작한다. */
    _fetch(url, extra, prio) {
        const id = ++this._seq;
        const job = { id, msg: Object.assign({ id, url }, extra),
                      prio: prio ? 1 : 0, res: null, rej: null };
        const p = new Promise((res, rej) => { job.res = res; job.rej = rej; });
        p._job = job;
        this._enqueue(job);
        return p;
    }

    _enqueue(job) {
        if (job.prio) {
            let k = 0;
            while (k < this._q.length && this._q[k].prio) k++;
            this._q.splice(k, 0, job);
        } else this._q.push(job);
        this._pump();
    }

    /** 데우려고 걸어 둔 요청이 **지금 필요해졌다**. 대기줄 앞으로 당긴다.
        이게 없으면 청크가 캐시에 "오는 중"으로 잡혀 있다는 이유로 그대로
        뒷줄에 남아, 급하다고 부른 쪽이 똑같이 기다린다. */
    promote(p) {
        const j = p && p._job;
        if (!j || j.prio) return;
        const k = this._q.indexOf(j);
        j.prio = 1;
        if (k >= 0) { this._q.splice(k, 1); this._enqueue(j); }
    }

    /** 빈 워커에 대기줄을 흘려 넣는다. */
    _pump() {
        for (;;) {
            if (!this._q.length) return;
            let w = -1, busy = 0;
            for (let i = 0; i < this._workers.length; i++)
                if (this._busy[i]) busy++; else if (w < 0) w = i;
            if (w < 0) return;
            // 데우는 일이 워커를 다 먹지 않게 한 자리는 남긴다.
            if (!this._q[0].prio && busy >= this._workers.length - 1) return;
            const job = this._q.shift();
            this._busy[w] = true;
            this._pending.set(job.id, { res: job.res, rej: job.rej, w });
            this._workers[w].postMessage(job.msg);
        }
    }

    /** 아직 시작도 안 한 **데우기** 요청을 버린다. 시간축을 크게 옮기거나
        변수를 갈아타면 방금 걸어 둔 앞자락이 통째로 쓸모없어진다. 그대로
        두면 새로 필요한 청크가 그 뒤에 줄을 선다. */
    dropWarm() {
        const keep = [];
        for (const j of this._q) {
            if (j.prio) { keep.push(j); continue; }
            j.rej(new Error("취소"));
        }
        this._q = keep;
    }

    /** data/ 아래 경로 + 사이클 도장. */
    url(path) {
        return this.v ? `${this.base}/${path}?v=${this.v}`
                      : `${this.base}/${path}`;
    }

    /** 격자 이진파일. bytes 는 푼 뒤의 크기 (눌렸는지 가리는 데 쓴다). */
    binary(path, bytes) {
        return this._fetch(this.url(path), { raw: true, bytes }, 1);
    }

    /* 눌린 JSON (관측소 시계열). 워커에서 풀고 파싱까지 해서 넘어온다.
       관측·시계열은 data/ 밖(site/obs, site/ts)에 있으므로 base 를 붙이지
       않는다 — 넘기는 경로가 곧 사이트 기준 경로다. 도장은 관측 갱신
       시각으로 따로 찍는다 (관측은 10분마다, 예측은 하루마다 바뀐다). */
    json(url) {
        if (url.startsWith("ts/")) url = "https://ust21-forecast.pages.dev/" + url;
        return this._fetch(this.obsV ? `${url}?v=${this.obsV}` : url,
                           { json: true }, 1);
    }

    spec(model, v) { return this.manifest.models[model].vars[v]; }
    vars(model) { return Object.keys(this.manifest.models[model].vars); }
    nchunk(model, v) { return this.spec(model, v).chunks; }

    /** 청크 하나. 같은 것을 두 번 받지 않는다. */
    chunk(model, v, ci, prio) {
        const key = `${model}/${v}/${ci}`;
        let p = this._chunks.get(key);
        if (p) {
            if (prio) this.promote(p);
            const k = this._lru.indexOf(key);
            if (k >= 0) this._lru.splice(k, 1);
            this._lru.push(key);
            return p;
        }
        p = this._fetch(this.url(`${model}/${v}/${ci}.br`), null, prio);
        p.then((c) => { this._size.set(key, c.q.byteLength); this._trim(); },
               () => { this._chunks.delete(key); this._size.delete(key); });
        this._chunks.set(key, p);
        this._size.set(key, 0);
        this._lru.push(key);
        this._trim();
        return p;
    }

    /** 상한을 넘으면 오래 안 쓴 것부터 버린다. 지금 그려지는 프레임은 앱이
        따로 들고 있으므로, 여기서 버려도 화면이 비지는 않는다 (다시 부르면
        다시 받을 뿐이다). */
    _trim() {
        let tot = 0;
        for (const k of this._lru) tot += this._size.get(k) || 0;
        while (this._lru.length > 2 &&
               (this._lru.length > MAX_CHUNKS || tot > MAX_BYTES)) {
            const k = this._lru.shift();
            tot -= this._size.get(k) || 0;
            this._chunks.delete(k);
            this._size.delete(k);
        }
    }

    /** 이 모델의 자료가 **공용 시간축**보다 몇 칸 앞서 시작하나.

       화면 시간축은 가장 새 사이클(대개 WRF) 하나로 고정한다. MOHID 원본이
       하루이틀 늦게 나오는 날에는 그 모델만 옛 사이클에 남는데, 전에는 모델
       마다 축을 따로 썼다 — MOHID 로 갈아타는 순간 시계가 이틀 뒤로 튀고,
       검증 그래프에는 과거선과 예측선이 같은 구간에 나란히 두 줄 그려졌다.
       이제 축은 하나다. 뒤처진 모델은 제 시각 자리에 놓이고, 축 끝까지 닿지
       못하는 뒷구간은 그냥 비운다 (결측). */
    shift(model) {
        const mm = this.manifest.models[model];
        if (!mm || !mm.t0 || !this.manifest.t0) return 0;
        return Math.round((Date.parse(this.manifest.t0) - Date.parse(mm.t0))
                          / (this.manifest.dt * 1000));
    }

    /** 공용 스텝 -> 이 모델 자료의 스텝. 자료가 닿지 않으면 null. */
    mstep(model, step) {
        const k = (step | 0) + this.shift(model);
        return k < 0 || k >= this.manifest.nstep ? null : k;
    }

    /** 이 모델의 예보가 공용 축에서 **어디까지** 닿나 (마지막 스텝). */
    lastStep(model) {
        /* 두 가지가 뒤를 자른다.
             1) 사이클이 뒤처져 축 자체가 짧다 (shift).
             2) 사이클은 맞는데 뒷날 원본이 아직 안 나왔다 — 청크는 121칸을
                다 차지하되 뒤가 결측(코드 0)이다. MOHID 는 예보일마다 파일이
                따로 떨어져 이쪽이 보통이다. 인코더가 센 값을 매니페스트의
                last 로 받는다.
           둘 중 먼저 끊기는 쪽이 답이다. */
        const mm = this.manifest.models[model];
        const byShift = this.manifest.nstep - 1 - this.shift(model);
        const byData = mm && mm.last != null ? mm.last : byShift;
        return Math.min(byShift, byData);
    }

    /** 스텝 하나의 코드 배열. 청크 안에서 몇 번째 프레임인지 골라 낸다.
        step 은 **공용 축** 기준이다. 이 모델이 안 닿는 시각이면 null. */
    async frame(model, v, step) {
        const fpc = this.manifest.frames_per_chunk;
        const s = this.mstep(model, step);
        if (s === null) return null;
        const ci = Math.floor(s / fpc), off = s - ci * fpc;
        const { hdr, q } = await this.chunk(model, v, ci, 1);
        const npt = hdr.nn;
        return q.subarray(off * npt, (off + 1) * npt);
    }

    /** 지점 조회판. 한 변수의 **모든 지점 × 모든 시각**이 한 파일에 들어 있다.
        (encode_points.py 참고. 담는 형식은 청크와 같은 KO01 이고 축만 뒤집혀
        있다 — nf=지점수, nn=시각수.) 청크와 달리 LRU 에 넣지 않는다: 한 번
        받으면 지도 어디를 눌러도 그대로 쓰이는 판이라 버릴 이유가 없다. */
    point(model, v) {
        const key = `${model}/${v}`;
        let p = this._points.get(key);
        if (p) return p;
        p = this._fetch(this.url(`${model}/pt/${v}.br`), null, 1);
        p.catch(() => { this._points.delete(key); });
        this._points.set(key, p);
        return p;
    }

    /** 지점판의 **대표 칸 자리** (블록마다 격자 1차원 색인 하나).
        지점판은 서너 칸에 하나씩만 남긴 판이라, 누른 자리와 실제로 읽는
        칸이 반 블록까지 어긋난다. 앱은 이걸 읽어 표식을 읽은 칸으로 옮긴다
        — 그래야 팝업 숫자와 그 자리 색이 같은 칸 값이 된다.
        옛 사이클에는 이 파일이 없다. 그러면 null 을 주고 예전처럼 군다. */
    ptCells(model) {
        const pt = this.ptMeta(model);
        if (!pt || !pt.cells) return null;
        const key = `${model}/__cells`;
        let p = this._points.get(key);
        if (p) return p;
        p = this.binary(`${model}/pt/cells.br`, pt.cells)
                .then((b) => new Uint32Array(b));
        p.catch(() => { this._points.delete(key); });
        this._points.set(key, p);
        return p;
    }

    /** 정밀 지점판 타일 하나 (한 파일에 그 타일의 **모든 변수**가 들어 있다).

        거친 지점판(pt/<var>.br)은 변수마다 판 하나 = 모델 셋 합쳐 8.5MB 를
        첫 클릭에 통째로 받는다. 게다가 uint8 이라 한 지점의 121시간이 코드로
        스무 칸 남짓밖에 안 움직여 그래프가 층계로 보인다.

        타일은 12비트(4095칸)로 뜬 대신 16×16 대표칸씩만 담는다. 모델당 한
        장 80KB 안팎이라, 받는 양은 오히려 백분의 일로 준다. 대표 칸이
        어긋난 사이클에는 타일이 아예 없다 — 그러면 거친 판으로 되돌아간다
        (계단은 보이지만 값이 딴 자리 것이 되지는 않는다).
        koos_common.PtFine 주석 참고. */
    ptTile(model, ty, tx) {
        const f = this.ptFine(model);
        if (!f || ty < 0 || tx < 0 || ty >= f.nty || tx >= f.ntx) return null;
        const key = `${model}/__f/${ty}_${tx}`;
        let p = this._points.get(key);
        if (p) return p;
        p = this._fetch(this.url(`${model}/pt/f/${ty}_${tx}.br`), { fine: true }, 1);
        p.catch(() => { this._points.delete(key); });
        this._points.set(key, p);
        return p;
    }

    /** 이 모델에 정밀 타일이 있나. */
    ptFine(model) {
        const pt = this.ptMeta(model);
        return (pt && pt.fine) || null;
    }

    /** 이 모델에 지점 조회판이 있나. */
    ptMeta(model) {
        const mm = this.manifest.models[model];
        return (mm && mm.pt) || null;
    }

    /** 지금 오고 있는 요청 수. 앞을 얼마나 데울지 정하는 데 쓴다. */
    inflight() { return this._pending.size; }

    /** 재생이 끊기지 않게 뒤쪽 청크를 미리 받아 둔다. */
    prefetch(model, v, step, ahead = 2) {
        const fpc = this.manifest.frames_per_chunk;
        const nc = this.nchunk(model, v);
        const s = this.mstep(model, step);
        if (s === null) return;
        const ci = Math.floor(s / fpc);
        for (let k = 1; k <= ahead; k++) if (ci + k < nc) this.chunk(model, v, ci + k);
    }

    /** 공용 축 스텝 s 의 UTC 시각. 축은 하나뿐이므로 모델과 무관하다
        (모델 인자는 옛 호출부 호환으로 받아 두고 쓰지 않는다). */
    time(step, _model) {
        return new Date(Date.parse(this.manifest.t0)
                        + step * this.manifest.dt * 1000);
    }

    /** 이 모델의 사이클 태그 (YYYYMMDDHH). */
    cycleOf(model) {
        const mm = model && this.manifest.models[model];
        return (mm && mm.cycle) || this.manifest.cycle;
    }
}

/* ── 코드 -> 물리값. koos_common 의 q_* / q_levels 역함수와 같아야 한다.
      다르면 그림은 그럴듯한데 값만 틀린다. 인코더를 고치면 여기도 고칠 것.

      lev 는 코드 폭이다. 청크·거친 지점판은 254 (코드 1~255), 팝업 그래프용
      정밀 타일은 4094 (코드 1~4095). 곡선은 **같은 것**을 쓰고 칸 수만
      다르므로, 같은 물리값을 두 판에서 읽으면 반올림 차이만 난다. */
export function codeToValue(spec, code, lev = 254) {
    const cf = code - 1;
    if (spec.kind === "linear") return spec.a + cf * (spec.b - spec.a) / lev;
    if (spec.kind === "dir") return cf / lev * 2 * Math.PI - Math.PI;
    const t = cf / lev;                       // speed: (a,b,c,d)=(smax,sexp,split,sref)
    return t <= spec.c ? Math.pow(t / spec.c, 1 / spec.b) * spec.d
                       : spec.d + (t - spec.c) / (1 - spec.c) * (spec.a - spec.d);
}

/** 코드 -> 표시좌표 0~1 (vmin~vmax 로 자른 것). 셰이더에 올릴 256칸 LUT. */
export function valueLUT(spec) {
    const a = new Float32Array(256);
    const den = (spec.vmax - spec.vmin) || 1;
    for (let c = 1; c < 256; c++) {
        const t = (codeToValue(spec, c) - spec.vmin) / den;
        a[c] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    return a;
}

/** 방향 코드 -> 단위벡터. 각을 그냥 섞으면 ±180° 경계에서 터진다. */
export function dirLUT(spec) {
    const a = new Float32Array(256 * 2);
    for (let c = 1; c < 256; c++) {
        const r = codeToValue(spec, c);
        a[c * 2] = Math.cos(r);
        a[c * 2 + 1] = Math.sin(r);
    }
    return a;
}

/** 실제 물리값 LUT (마우스 올렸을 때 숫자로 읽어 주려고). */
export function rawLUT(spec) {
    const a = new Float32Array(256);
    for (let c = 1; c < 256; c++) a[c] = codeToValue(spec, c);
    return a;
}
