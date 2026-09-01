/* 등치선을 CPU 로 뽑는다.  목적은 단 하나 — **라벨**이다.

   선 자체는 셰이더가 그린다 (render.js 의 isoline()). 화면 화소마다
   판정하니 확대해도 계단이 안 지고 시간 보간도 공짜다. 그런데 셰이더는
   "여기가 선이다" 까지만 알 뿐 그 선이 1004hPa 인지 1008hPa 인지 화면에
   적어 줄 방법이 없다. 색만 보고는 고기압 쪽으로 세는 건지 저기압 쪽으로
   세는 건지도 모른다.

   그래서 같은 자료를 CPU 에서 한 번 더 훑어 **꺾은선**으로 만들고, 그걸
   MapLibre 심볼 레이어에 넘겨 글자를 앉힌다. 심볼 레이어를 쓰는 이유는
   직접 그리면 다시 만들어야 할 것들 — 곡선을 따라 눕히기, 글자가 뒤집히지
   않게 세우기, 겹치는 라벨 지우기, 간격 유지 — 을 이미 다 하기 때문이다.

   같은 값을 두 군데서 따로 계산하는 게 마음에 걸릴 수 있는데, 둘 다 입력이
   같다 (코드 -> raw LUT -> 이중선형). 셈이 어긋날 자리가 없다. */

/* 마칭 스퀘어 16가지. 각 칸이 만드는 선분 목록이고, 숫자는 변 번호다.
     0 = 아래(v00-v10)  1 = 오른쪽(v10-v11)  2 = 위(v01-v11)  3 = 왼쪽(v00-v01)
   5·10 은 안장점이라 칸 평균으로 갈라야 한다 — 아래에서 따로 다룬다. */
const CASES = [
    [], [[3, 0]], [[0, 1]], [[3, 1]],
    [[1, 2]], null, [[0, 2]], [[3, 2]],
    [[2, 3]], [[2, 0]], null, [[2, 1]],
    [[1, 3]], [[1, 0]], [[0, 3]], [],
];

/** 격자좌표를 1/4096 로 반올림한 열쇠. 이웃 칸이 같은 변에서 만든 점은
    보간식이 글자 그대로 같아 값이 정확히 일치한다 — 이어붙일 수 있다. */
const key = (x, y) => ((x * 4096) | 0) + "," + ((y * 4096) | 0);

/**
 * @param {number} nx,ny   격자 크기
 * @param {Float64Array|Float32Array} f  물리값 (길이 nx*ny, lat-major). NaN = 결측
 * @param {number[]} levels  뽑을 등치선 값
 * @returns {Array<{level:number, lines:number[][]}>}  lines 는 [i0,j0,i1,j1,…] 격자좌표
 */
export function marchingSquares(nx, ny, f, levels) {
    const out = levels.map((L) => ({ level: L, lines: [] }));

    for (let li = 0; li < levels.length; li++) {
        const L = levels[li];
        const segs = [];                       // [x0,y0,x1,y1] 평평하게

        for (let j = 0; j < ny - 1; j++) {
            const r0 = j * nx, r1 = r0 + nx;
            for (let i = 0; i < nx - 1; i++) {
                const v00 = f[r0 + i], v10 = f[r0 + i + 1];
                const v01 = f[r1 + i], v11 = f[r1 + i + 1];
                // 결측이 한 귀퉁이라도 있으면 이 칸은 건너뛴다. 해안에서
                // 육지값을 0 으로 읽어 엉뚱한 선을 긋는 사고를 막는다.
                if (!(v00 === v00 && v10 === v10 && v01 === v01 && v11 === v11)) continue;

                let c = 0;
                if (v00 >= L) c |= 1;
                if (v10 >= L) c |= 2;
                if (v11 >= L) c |= 4;
                if (v01 >= L) c |= 8;
                if (c === 0 || c === 15) continue;

                // 변 위의 교점. 필요한 것만 센다.
                const ex = (a, b) => (L - a) / (b - a);
                const pt = (e) => {
                    if (e === 0) return [i + ex(v00, v10), j];
                    if (e === 1) return [i + 1, j + ex(v10, v11)];
                    if (e === 2) return [i + ex(v01, v11), j + 1];
                    return [i, j + ex(v00, v01)];
                };

                let pairs = CASES[c];
                if (pairs === null) {
                    /* 안장점. 칸 평균이 등치선 위냐 아래냐로 두 갈래를 고른다.
                       아무렇게나 이으면 선이 X 자로 교차해 라벨이 그 위에
                       얹힌다. */
                    const avg = (v00 + v10 + v01 + v11) / 4;
                    const hi = avg >= L;
                    pairs = c === 5 ? (hi ? [[3, 0], [1, 2]] : [[3, 2], [0, 1]])
                                    : (hi ? [[2, 1], [0, 3]] : [[2, 3], [0, 1]]);
                }
                for (const [a, b] of pairs) {
                    const pa = pt(a), pb = pt(b);
                    segs.push(pa[0], pa[1], pb[0], pb[1]);
                }
            }
        }
        out[li].lines = joinSegments(segs);
    }
    return out;
}

/** 흩어진 선분을 끝점끼리 이어 꺾은선으로. 라벨을 곡선 따라 눕히려면
    짧은 토막이 아니라 긴 선 하나여야 한다 — 토막마다 글자를 앉히려 들면
    자리가 없어 전부 지워진다. */
function joinSegments(segs) {
    const n = segs.length / 4;
    const ends = new Map();                  // 점열쇠 -> [선분번호…]
    for (let s = 0; s < n; s++) {
        for (const e of [0, 1]) {
            const k = key(segs[s * 4 + e * 2], segs[s * 4 + e * 2 + 1]);
            let a = ends.get(k);
            if (!a) ends.set(k, a = []);
            a.push(s);
        }
    }

    const used = new Uint8Array(n);
    const lines = [];

    /** 점 (x,y) 에서 아직 안 쓴 선분을 하나 집어 반대쪽 끝을 돌려준다. */
    const walk = (x, y) => {
        const a = ends.get(key(x, y));
        if (!a) return null;
        for (const s of a) {
            if (used[s]) continue;
            const o = s * 4;
            const same = ((segs[o] * 4096) | 0) === ((x * 4096) | 0) &&
                         ((segs[o + 1] * 4096) | 0) === ((y * 4096) | 0);
            used[s] = 1;
            return same ? [segs[o + 2], segs[o + 3]] : [segs[o], segs[o + 1]];
        }
        return null;
    };

    for (let s = 0; s < n; s++) {
        if (used[s]) continue;
        used[s] = 1;
        const o = s * 4;
        const pts = [segs[o], segs[o + 1], segs[o + 2], segs[o + 3]];

        // 앞으로
        let x = segs[o + 2], y = segs[o + 3], hop;
        while ((hop = walk(x, y))) { pts.push(hop[0], hop[1]); x = hop[0]; y = hop[1]; }
        // 뒤로 (앞에 붙인다)
        x = segs[o]; y = segs[o + 1];
        while ((hop = walk(x, y))) { pts.unshift(hop[0], hop[1]); x = hop[0]; y = hop[1]; }

        if (pts.length >= 6) lines.push(pts);   // 점 3개 미만은 라벨이 못 앉는다
    }
    return lines;
}

/** 격자좌표 꺾은선 -> 경위도. 곡선격자는 lonlat[ny][nx][2] 를 이중선형으로 읽고,
    정형격자는 lon0 + i*dlon 으로 바로 센다. */
export function toLonLat(pts, g, lonlat) {
    const out = [];
    const nx = g.nx, ny = g.ny;
    for (let k = 0; k < pts.length; k += 2) {
        const x = pts[k], y = pts[k + 1];
        if (lonlat) {
            const i0 = Math.min(nx - 2, Math.max(0, Math.floor(x)));
            const j0 = Math.min(ny - 2, Math.max(0, Math.floor(y)));
            const fx = x - i0, fy = y - j0;
            const at = (i, j) => (j * nx + i) * 2;
            const a = at(i0, j0), b = at(i0 + 1, j0), c = at(i0, j0 + 1), d = at(i0 + 1, j0 + 1);
            const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy),
                  w01 = (1 - fx) * fy,       w11 = fx * fy;
            out.push([
                lonlat[a] * w00 + lonlat[b] * w10 + lonlat[c] * w01 + lonlat[d] * w11,
                lonlat[a + 1] * w00 + lonlat[b + 1] * w10 + lonlat[c + 1] * w01 + lonlat[d + 1] * w11,
            ]);
        } else {
            out.push([g.lon0 + x * g.dlon, g.lat0 + y * g.dlat]);
        }
    }
    return out;
}

/* 꺾은선을 편다.

   양자화가 0.5hPa 단위라 등치선이 계단처럼 지그재그로 나온다. 셰이더가
   그리는 선은 화소마다 이중선형으로 판정해 매끄럽게 보이지만, 여기서 뽑은
   꼭짓점 목록은 그 계단을 그대로 담고 있다 — 실측하니 꼭짓점의 92%가 26도
   넘게 꺾였다. MapLibre 는 text-max-angle 보다 심하게 꺾인 자리에는 글자를
   앉히지 않으므로, 이걸 그냥 넘기면 **라벨이 거의 한 개도 안 뜬다.**
   (실제로 그렇게 내보냈다.)

   Taubin(λ/μ) 방식을 쓴다. 라플라스 평활을 그냥 반복하면 닫힌 고리가 눈에
   띄게 쪼그라들어 라벨이 셰이더가 그린 선에서 벗어난다. μ 단계가 그 수축을
   되돌린다. */
export function smooth(pts, passes = 8) {
    if (pts.length < 5) return pts;
    const closed = Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 &&
                   Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
    let a = pts.map((p) => [p[0], p[1]]);
    const n = a.length;
    const step = (w) => {
        const b = a.map((p) => [p[0], p[1]]);
        for (let i = 0; i < n; i++) {
            let im = i - 1, ip = i + 1;
            if (im < 0)  { if (!closed) continue; im = n - 2; }
            if (ip >= n) { if (!closed) continue; ip = 1; }
            b[i][0] = a[i][0] + w * ((a[im][0] + a[ip][0]) / 2 - a[i][0]);
            b[i][1] = a[i][1] + w * ((a[im][1] + a[ip][1]) / 2 - a[i][1]);
        }
        if (closed) b[n - 1] = [b[0][0], b[0][1]];
        a = b;
    };
    for (let k = 0; k < passes; k++) { step(0.62); step(-0.65); }
    return a;
}

/** 거의 일직선인 점을 버린다. 라벨만 앉히면 되니 촘촘할 이유가 없고,
    GeoJSON 이 작아야 지도에 넘기는 값이 싸다. tol 은 도(degree). */
export function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let ax = pts[0][0], ay = pts[0][1];
    for (let i = 1; i < pts.length - 1; i++) {
        const [bx, by] = pts[i], [cx, cy] = pts[i + 1];
        // 점 b 가 선분 a-c 에서 얼마나 벗어나 있나 (외적 / 밑변 길이)
        const dx = cx - ax, dy = cy - ay;
        const len = Math.hypot(dx, dy);
        const dev = len < 1e-12 ? 0 : Math.abs((bx - ax) * dy - (by - ay) * dx) / len;
        if (dev > tol) { out.push(pts[i]); ax = bx; ay = by; }
    }
    out.push(pts[pts.length - 1]);
    return out;
}

/**
 * 등치선 GeoJSON 한 벌. 라벨용이다.
 *
 * @param {object} g       grid.json
 * @param {Uint8Array} codes  이번 프레임 코드 (0 = 결측)
 * @param {Float32Array} raw  코드 -> 물리값 (256칸)
 * @param {number} step    등치선 간격
 * @param {number} bold    이 배수는 굵은 선 (properties.bold = 1)
 * @param {Float32Array} lonlat  곡선격자면 [ny][nx][2], 아니면 null
 */
export function isolineGeoJSON(g, codes, raw, step, bold, lonlat) {
    const nx = g.nx, ny = g.ny;
    const f = new Float64Array(nx * ny);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < f.length; k++) {
        const c = codes[k];
        if (c === 0) { f[k] = NaN; continue; }
        const v = raw[c];
        f[k] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    if (!(hi > lo)) return { type: "FeatureCollection", features: [] };

    const levels = [];
    for (let L = Math.ceil(lo / step) * step; L <= hi; L += step) levels.push(+L.toFixed(6));
    // 등치선이 수백 벌이면 라벨은 어차피 다 지워지고 셈만 오래 걸린다.
    if (levels.length > 60) levels.length = 60;

    /* 격자 한 칸의 대략 크기(도). 곡선격자는 dlon 이 없으니 경계상자로 센다. */
    const cell = Math.abs(g.dlon) || (Math.abs(g.bounds[1][1] - g.bounds[0][1]) / nx) || 0.04;
    /* 간략화는 아주 살짝만 한다. MapLibre 는 글자 한 자마다 선을 따라가며
       방향이 text-max-angle 보다 크게 꺾이면 라벨을 포기하는데, 점을 솎으면
       같은 곡률이 몇 안 되는 꼭짓점에 몰려 그 자리에서 각이 튄다. 실측:
       tol=0.12칸이면 꼭짓점의 60%가 26도를 넘고, 0.02칸이면 10%다. */
    const tol = cell * 0.02;
    /* 아주 짧은 선은 버린다. 값을 0.5hPa 단위로 양자화해 담기 때문에 평탄한
       기압골 한가운데서 값이 등치선을 살짝 넘나드는 곳마다 지름 몇 km 짜리
       고리가 생긴다. 오늘 자료로는 선 66개 중 43개가 그런 것인데 전체 길이의
       9%밖에 안 된다 — 선으로는 안 보이지만 라벨을 앉히면 숫자만 잔뜩 뜬다. */
    const minLen = cell * 12;
    const features = [];
    for (const { level, lines } of marchingSquares(nx, ny, f, levels)) {
        for (const pts of lines) {
            const ll = simplify(smooth(toLonLat(pts, g, lonlat)), tol);
            if (ll.length < 2) continue;
            let len = 0;
            for (let k = 1; k < ll.length; k++)
                len += Math.hypot(ll[k][0] - ll[k - 1][0], ll[k][1] - ll[k - 1][1]);
            if (len < minLen) continue;
            features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: ll },
                properties: {
                    level,
                    label: String(Math.round(level)),
                    bold: bold > 0 && Math.abs(level / bold - Math.round(level / bold)) < 1e-6 ? 1 : 0,
                },
            });
        }
    }
    return { type: "FeatureCollection", features };
}
