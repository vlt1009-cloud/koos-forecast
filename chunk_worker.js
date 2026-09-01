/* 청크 디코더 워커.
   한 파일 = 한 변수 6시간(6프레임) 분량. 안에 든 것은
     brotli( 헤더 28B + uint8[프레임수 * 노드수] )
   이고 uint8 스트림은 시간델타 -> 공간델타 순으로 눌려 있다.

   압축 해제는 두 갈래다.
     1) 서버가 Content-Encoding: br 로 내려주면 브라우저가 이미 풀어놨다 (비용 0).
     2) 아니면 WASM brotli 로 여기서 푼다 (203KB, 필요할 때만 받는다).
   첫 4바이트 매직으로 어느 쪽인지 판별하므로 서버 설정을 몰라도 동작한다.

   메인 스레드에는 역델타까지 끝낸 uint8 코드만 넘긴다. float 로 펴서 넘기면
   전송·메모리가 낭비된다. 실수 변환은 실제로 그릴 프레임에서만 한다.
   uint8 코드 그대로 GPU 텍스처에 올릴 수 있다는 점이 더 크다.

   **코드 0 은 결측(육지)이다.** 유효값은 1~255. 정형격자는 절반이 육지라
   따로 표시할 자리가 필요했다 (SCHISM 비정형 메시에는 없던 규칙이다).
   셰이더가 0 을 보면 투명하게 버린다. */

const MAGIC = 0x4B4F3031;   // "KO01"
const FMAGIC = 0x4B4F3046;  // "KO0F" — 정밀 지점판 타일 (koos_common.PtFine)
let brotliDec = null;       // 지연 초기화

async function ensureBrotli() {
    if (brotliDec) return brotliDec;
    /* 인수를 주지 않으면 모듈이 import.meta.url 기준으로 .wasm 을 찾는다.
       직접 경로를 넘기면 문서 기준으로 해석돼 워커 위치와 어긋난다. */
    const mod = await import("./vendor/brotli_dec_wasm.js");
    await mod.default();
    brotliDec = mod.decompress;
    return brotliDec;
}

function readHeader(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== MAGIC) return null;
    return {
        nf:    dv.getUint16(4, true),
        kind:  dv.getUint8(6),
        flags: dv.getUint8(7),
        nn:    dv.getUint32(8, true),
        a: dv.getFloat32(12, true), b: dv.getFloat32(16, true),
        c: dv.getFloat32(20, true), d: dv.getFloat32(24, true)
    };
}

/* 역델타. 제자리에서 처리한다. uint8 덧셈은 (x)&255 로 자연히 mod 256 이 된다. */
function undelta(q, nf, nn, flags) {
    if (flags & 0x1) {                      // 공간델타 되돌리기 (노드 방향 누적)
        for (let f = 0; f < nf; f++) {
            const o = f * nn;
            let acc = q[o];
            for (let k = 1; k < nn; k++) { acc = (acc + q[o + k]) & 255; q[o + k] = acc; }
        }
    }
    if (flags & 0x2) {                      // 시간델타 되돌리기 (프레임 방향 누적)
        for (let f = 1; f < nf; f++) {
            const o = f * nn, p = o - nn;
            for (let k = 0; k < nn; k++) q[o + k] = (q[p + k] + q[o + k]) & 255;
        }
    }
}

async function load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    let buf = await res.arrayBuffer();

    let hdr = readHeader(buf);
    let wasm = false;
    if (!hdr) {
        wasm = true;                             // 서버가 안 풀어줬다 -> 직접 푼다
        const dec = await ensureBrotli();
        const out = dec(new Uint8Array(buf));
        buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
        hdr = readHeader(buf);
        if (!hdr) throw new Error("청크 형식 불일치: " + url);
    }

    const q = new Uint8Array(buf, 28, hdr.nf * hdr.nn).slice();
    undelta(q, hdr.nf, hdr.nn, hdr.flags);
    return { hdr, q, wasm };
}

/* 격자 이진파일(grid_ij.bin.br 등)도 여기서 받는다. 청크 형식이 아니라
   그냥 float32 덩어리라 매직으로는 판별을 못 한다. 대신 .br 로 끝나면
   눌린 것으로 보고, 브라우저가 이미 풀었는지는 길이로 가린다:
   푼 결과의 바이트 수를 호출 쪽이 알고 있으므로 그걸 받아서 맞춰 본다. */
async function loadRaw(url, bytes) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    let buf = await res.arrayBuffer();
    if (buf.byteLength !== bytes) {          // 아직 눌려 있다 -> 직접 푼다
        const dec = await ensureBrotli();
        const out = dec(new Uint8Array(buf));
        buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    }
    if (buf.byteLength !== bytes)
        throw new Error(`${url}: ${buf.byteLength}바이트, ${bytes} 이어야 한다`);
    return buf;
}

/* 정밀 지점판 타일. 한 파일에 그 타일(대표칸 16×16)의 **모든 변수**가 든다.

     16B 머리 + 변수이름 8B씩 + 변수마다 uint16[지점 x 시각]

   uint16 은 시간축 델타로 눌려 있고, 낮은 바이트 평면과 높은 바이트 평면이
   갈라져 저장돼 있다 — 델타가 작아 높은 평면이 거의 0/255 라 통째로 눌린다.
   메인 스레드에는 코드 그대로 넘긴다. 실수 변환은 실제로 그릴 한 지점
   (121칸) 에서만 한다. */
async function loadFine(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    let buf = await res.arrayBuffer();
    let dv = new DataView(buf);
    if (dv.getUint32(0, true) !== FMAGIC) {
        const dec = await ensureBrotli();
        const out = dec(new Uint8Array(buf));
        buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
        dv = new DataView(buf);
        if (dv.getUint32(0, true) !== FMAGIC) throw new Error("타일 형식 불일치: " + url);
    }
    const nvar = dv.getUint8(4), flags = dv.getUint8(5);
    const hdr = { npt: dv.getUint16(6, true), nt: dv.getUint16(8, true),
                  lev: dv.getUint16(10, true),
                  tx: dv.getUint16(12, true), ty: dv.getUint16(14, true) };
    const n = hdr.npt * hdr.nt;
    const bytes = new Uint8Array(buf);
    const need = 16 + nvar * 8 + nvar * 2 * n;
    if (bytes.length < need)
        throw new Error(`타일이 짧다: ${bytes.length} < ${need} (${url})`);
    const planes = {}, moved = [];
    for (let f = 0; f < nvar; f++) {
        let nm = "";
        for (let k = 0; k < 8; k++) {
            const c = bytes[16 + f * 8 + k];
            if (!c) break;
            nm += String.fromCharCode(c);
        }
        const o = 16 + nvar * 8 + f * 2 * n;
        const u = new Uint16Array(n);
        for (let k = 0; k < n; k++) u[k] = bytes[o + k] | (bytes[o + n + k] << 8);
        if (flags & 0x1) {                      // 시간델타 되돌리기 (안쪽 축)
            for (let p = 0; p < hdr.npt; p++) {
                const b = p * hdr.nt;
                let acc = u[b];
                for (let k = 1; k < hdr.nt; k++) { acc = (acc + u[b + k]) & 0xffff; u[b + k] = acc; }
            }
        }
        planes[nm] = u;
        moved.push(u.buffer);
    }
    return { obj: { hdr, planes }, moved };
}

/* 눌린 JSON(관측소 시계열). 크기를 미리 모르니 첫 바이트로 가린다 —
   JSON 은 '{' 로 시작하고 brotli 스트림이 우연히 0x7B 로 시작할 일은 없다
   (첫 바이트 하위 비트가 창 크기라 lgwin24 면 0x1B, 0x5B 꼴이 나온다). */
async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes[0] !== 0x7B) {
        const dec = await ensureBrotli();
        bytes = dec(bytes);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

self.onmessage = async (e) => {
    const { id, url, raw, json, fine, bytes } = e.data;
    try {
        if (fine) {
            const { obj, moved } = await loadFine(url);
            self.postMessage({ id, ok: true, obj }, moved);
            return;
        }
        if (json) {
            self.postMessage({ id, ok: true, obj: await loadJson(url) });
            return;
        }
        if (raw) {
            const buf = await loadRaw(url, bytes);
            self.postMessage({ id, ok: true, raw: buf }, [buf]);
            return;
        }
        const { hdr, q, wasm } = await load(url);
        self.postMessage({ id, ok: true, hdr, q, wasm }, [q.buffer]);
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err && err.message || err) });
    }
};
