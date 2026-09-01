/* 방향 표시 규약 — 지도(koos.js)와 그래프(ts.js)가 **같은 표**를 봐야 한다.

   저장된 것은 전부 수학각 rad (동=0, 반시계, **가는 쪽**) 이다. 화면에 적는
   각도는 변수마다 관례가 다르다:

     풍향  기상 관례로 "불어오는 쪽"     -> from
     파향  기상 관례로 "밀려오는 쪽"     -> from   (SWAN 원자료는 이미 뒤집혀
                                                    있어서 인코더에서 맞췄다)
     유향  해양 관례로 "흘러가는 쪽"     -> to

   같은 뜻의 표가 파이썬 쪽 ts_web.DISPLAY_DIR 에도 있다. 두 벌이 어긋나면
   지도에 적힌 각도와 그래프에 그린 각도가 180도 달라지는데, 둘 다 그럴듯해
   보여서 눈으로는 못 잡는다. 그래서 stations.json 이 실어 보내는
   dir_convention 과 켤 때마다 맞춰 본다 (checkConvention). */

export const DIRMODE = {
    "wrf.wdir": "from",     // 풍향
    "swan.wdir": "from",    // 파향
    "mohid.cdir": "to",     // 유향
};

/** 수학각(rad) -> 방위각(도, 북=0, 시계 방향). obs_common.math_to_naut 와 같다. */
export function bearing(rad, mode) {
    let d = 90 - rad * 180 / Math.PI;          // 수학각 -> 방위각(가는 쪽)
    if (mode === "from") d += 180;
    return ((d % 360) + 360) % 360;
}

export const COMPASS = [
    "북", "북북동", "북동", "동북동", "동", "동남동", "남동", "남남동",
    "남", "남남서", "남서", "서남서", "서", "서북서", "북서", "북북서"];

export const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

/* 파이썬 쪽 표와 대조. 어긋나면 화면 위에 대놓고 띄운다 — 조용히 넘어가면
   180도 뒤집힌 각도를 몇 달이고 그대로 내보내게 된다. */
export function checkConvention(remote) {
    if (!remote) return [];
    const bad = [];
    for (const [k, v] of Object.entries(DIRMODE))
        if (remote[k] && remote[k] !== v) bad.push(`${k}: 웹 ${v} vs 자료 ${remote[k]}`);
    if (bad.length)
        console.error("방향 규약 불일치 — dirconv.js 와 ts_web.py 를 맞출 것\n" +
                      bad.join("\n"));
    return bad;
}
