/* WebGL2 렌더러. MapLibre 커스텀 레이어 두 장 — 색칠판 + 방향 입자.

   격자는 모델마다 그대로 쓴다. 공통 격자로 다시 깔지 않는다. 대신 그리는
   방법을 격자 종류별로 나눈다:

     regular      (SWAN 720x712, MOHID 360x356)
       메르카토르 사각형 하나만 그리고, 프래그먼트에서 y 를 위도로 되돌린다.
       경도는 메르카토르에서 선형이라 그냥 나눈다. 정점이 4개뿐이라 싸다.

     curvilinear  (WRF 360x360 람베르트)
       격자점마다 정점을 두고 (i,j) 를 그대로 실어 보낸다. 래스터라이저가
       셀 안을 채워 주므로 좌표 역산이 필요 없다. 정점 12.9만, 삼각형 25.8만.

   보간은 셰이더에서 손으로 한다. NEAREST 로 네 칸을 찍어 보고 **코드 0
   (육지)은 빼고** 남은 칸의 가중치를 다시 정규화한다. GPU 의 LINEAR 에
   맡기면 해안에서 육지값이 바다로 번져 파고가 0 쪽으로 끌려간다.

   시간 보간은 프레임 두 장을 섞는다. 방향은 각도를 섞으면 +-180 경계에서
   터지므로 단위벡터로 바꿔 섞고 다시 각을 낸다.

   GL 상태는 우리 VAO 안에서만 건드리고 끝나면 되돌린다. MapLibre 는 같은
   컨텍스트를 쓰므로 어트리뷰트를 켜 놓은 채 나가면 지도 자체가 깨진다. */

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** 위도(도) -> MapLibre 메르카토르 y (0~1). */
export function mercY(lat) {
    const c = Math.max(-85.051129, Math.min(85.051129, lat));
    return (180 - R2D * Math.log(Math.tan(Math.PI / 4 + c * D2R / 2))) / 360;
}
export function mercX(lon) { return (lon + 180) / 360; }

/* ── 리본 입자의 붙박이 수치 ───────────────────────────────────────
   전부 ref/app/maplibre_schism.js 에서 그대로 가져왔다. 값 하나하나가
   "이렇게 안 하면 이렇게 보인다"의 결과라 함부로 만지면 안 된다. */
const PT = 30;                  // 입자당 꼬리 점 개수
const PSEG = PT - 1;            // 세그먼트
const PVERT = PT * 2;           // 정점 (좌/우 한 쌍씩)
const PSTRIDE = 8;              // a_pos2 + a_prev2 + a_next2 + a_spd1 + a_t1

/* 화면에서 세그먼트가 1픽셀보다 짧아지면 래스터라이저가 통째로 건너뛴다.
   -> 리본이 점선으로 끊긴다. 저장한 30점을 그대로 잇지 않고 호 길이 기준으로
   다시 표집해 세그먼트를 항상 1.5px 안팎으로 맞춘다. */
const TARGET_SEG_PX = 1.5;

const SPAWN_POOL_MAX = 3072;    // 태어날 자리 후보
const SIM_MS = 1000 / 48;       // 적분 주기. 화면 주사율과 분리한다.

/* 밀도 "보통" 일 때의 입자 수. 레퍼런스는 2800 을 쓰지만 그건 화면 전체가
   해류 하나일 때다. 여기는 색칠판 위에 얹는 오버레이라 그 밀도로 깔면
   흰 줄이 색을 다 덮는다 (레퍼런스도 오버레이일 때는 0.48 을 곱한다). */
const BASE_COUNT = 1200;

// ─────────────────────────────────────────────────────────────────────
// 셰이더
// ─────────────────────────────────────────────────────────────────────
const FIELD_VS = `#version 300 es
in vec2 a_merc;
in vec2 a_ij;
uniform mat4 u_matrix;
out vec2 v_merc;
out vec2 v_ij;
void main(){
  v_merc = a_merc;
  v_ij   = a_ij;
  gl_Position = u_matrix * vec4(a_merc, 0.0, 1.0);
}`;

const FIELD_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_merc;
in vec2 v_ij;
out vec4 fragColor;

uniform usampler2D u_fa;      // 프레임 A 코드
uniform usampler2D u_fb;      // 프레임 B 코드
uniform sampler2D  u_val;     // 256x1 R32F  : 코드 -> 표시좌표 0~1
uniform sampler2D  u_raw;     // 256x1 R32F  : 코드 -> 물리값 (등치선용)
uniform sampler2D  u_pal;     // 256x1 RGBA8 : 색상표
uniform ivec2 u_size;         // nx, ny
uniform vec2  u_origin;       // lon0, lat0    (regular 전용)
uniform vec2  u_delta;        // dlon, dlat    (regular 전용)
uniform float u_tf;           // 프레임 사이 0~1
uniform float u_opacity;
uniform int   u_curv;
uniform float u_iso;          // 등치선 간격(물리단위). 0 이면 안 그린다
uniform float u_isob;         // 이 배수마다 굵게. 0 이면 굵은 선 없음

/* 이중선형. **네 귀가 모두 값이 있을 때만** 칠한다.

   이 한 줄이 "격자 밖은 칠하지 않는다"를 지킨다. 색칠판은 격자점(칸 중심)
   사이를 메우는 그림이므로, 네 귀가 다 살아 있는 자리만 칠하면 칠해진
   넓이가 **격자선으로 둘러싸인 넓이와 정확히 같아진다**. 격자 보기를 켜고
   견주면 색이 선 밖으로 한 픽셀도 안 나간다.

   예전에는 살아 있는 귀로 가중치를 다시 정규화했다. 한 귀만 있어도 칠하니
   색이 마지막 격자점 너머로 반 칸 더 나갔고, 육지 쪽에 격자는 없는데 색만
   남는 자리가 생겼다. 보는 사람에게 그건 "여기도 계산한 값"이라는 거짓말이다.

   대신 폭 한 칸짜리 물길은 네 귀가 안 모여 색이 빠진다. 뭍에 색을 흘리는
   쪽보다는 이쪽이 낫다 — 없는 값을 지어내지는 않는다. */
bool bilin(usampler2D t, ivec2 i0, vec2 f, out float v, out float r){
  float acc = 0.0, racc = 0.0;
  for (int dy = 0; dy < 2; dy++){
    for (int dx = 0; dx < 2; dx++){
      ivec2 p = clamp(i0 + ivec2(dx, dy), ivec2(0), u_size - 1);
      uint c = texelFetch(t, p, 0).r;
      if (c == 0u) return false;              // 한 귀라도 비면 자료 밖이다
      float w = (dx == 0 ? 1.0 - f.x : f.x) * (dy == 0 ? 1.0 - f.y : f.y);
      int ci = int(c);
      acc  += w * texelFetch(u_val, ivec2(ci, 0), 0).r;
      // 등치선을 안 그리는 변수는 물리값이 필요 없다. 픽셀당 텍셀 읽기가
      // 절반으로 준다 — 그만큼 프레임률이 오르고, 프레임률이 곧 스텝 사이
      // 섞임의 해상도다 (4배속이면 한 스텝이 0.22초다).
      if (u_iso > 0.0) racc += w * texelFetch(u_raw, ivec2(ci, 0), 0).r;
    }
  }
  v = acc;                                    // 가중치 합은 언제나 1
  r = racc;
  return true;
}

/* 3차 B-스플라인 창(4x4). 등치선 전용이다.

   이중선형으로 뽑은 등압선은 격자 티가 심하게 난다. 이유는 보간이 아니라
   **양자화**다. 해면기압은 코드 한 칸이 약 0.1~0.5 hPa 인데 5km 격자에서
   이웃 칸 사이 실제 차이는 그보다 작다. 그래서 값이 계단처럼 평평한 판으로
   뭉치고, 등치선은 그 판의 경계 — 곧 격자선 — 을 따라 꺾인다. 이중선형은
   칸 경계에서 기울기가 끊기므로(C0) 그 꺾임을 그대로 드러낸다.

   B-스플라인은 C2 라 꺾임 자체가 없다. 커널이 전부 0 이상이라 육지(코드 0)를
   빼고 남은 가중치로 다시 정규화해도 값이 튀지 않는다 — Catmull-Rom 은
   음수 가중치가 있어 마스크 경계에서 터진다. 국소 정규화 RBF 와 같은 얼개고
   (콤팩트 지지 매끄러운 커널 + 가중치 재정규화), 픽셀당 16탭이면 끝난다.

   값을 정확히 지나가지 않고 살짝 뭉갠다. 등압선에는 그게 오히려 맞다 —
   0.5 hPa 양자화 잡음을 같이 뭉개 주기 때문이다. */
float bsw(float x){
  x = abs(x);
  if (x < 1.0) return (4.0 + x * x * (3.0 * x - 6.0)) / 6.0;
  if (x < 2.0) { float u = 2.0 - x; return u * u * u / 6.0; }
  return 0.0;
}

bool bspline(usampler2D t, vec2 g, out float v, out float r){
  ivec2 i0 = ivec2(floor(g)) - 1;
  vec2  f  = g - floor(g);
  float acc = 0.0, racc = 0.0, sw = 0.0;
  for (int dy = 0; dy < 4; dy++){
    float wy = bsw(float(dy) - 1.0 - f.y);
    for (int dx = 0; dx < 4; dx++){
      float w = wy * bsw(float(dx) - 1.0 - f.x);
      if (w <= 0.0) continue;
      ivec2 p = clamp(i0 + ivec2(dx, dy), ivec2(0), u_size - 1);
      uint c = texelFetch(t, p, 0).r;
      if (c == 0u) continue;
      int ci = int(c);
      acc  += w * texelFetch(u_val, ivec2(ci, 0), 0).r;
      racc += w * texelFetch(u_raw, ivec2(ci, 0), 0).r;
      sw   += w;
    }
  }
  if (sw < 1e-5) return false;
  v = acc / sw;
  r = racc / sw;
  return true;
}

/* 등치선 한 벌. 인자 s 는 **선 번호**다 (물리값 / 간격). 정수에 닿는 자리가 선.

   폭을 픽셀로 잡는 게 요령이다. fwidth(s) = 화면 1픽셀당 선 번호가 얼마나
   변하는가 이므로, 그걸 곱하면 확대해도 축소해도 선 굵기가 그대로 유지된다.
   고정 폭으로 두면 확대했을 때 실처럼 사라지고 축소하면 화면이 새까매진다.

   한 픽셀 안에 선이 여러 개 들어갈 만큼 축소되면(w 가 크면) 남는 건 모아레
   무늬뿐이라 아예 지운다. */
float isoline(float s, float px){
  float w = fwidth(s);
  if (w < 1e-7 || w > 10.0) return 0.0;
  float d  = abs(fract(s + 0.5) - 0.5);      // 가장 가까운 선까지 (선 번호 단위)
  float hw = px * w;                          // 반폭
  float ln = 1.0 - smoothstep(hw * 0.5, hw * 1.6, d);
  return ln * (1.0 - smoothstep(0.18, 0.42, w));   // 너무 촘촘하면 흐려 없앤다
}

void main(){
  vec2 g;
  if (u_curv == 1) {
    g = v_ij;
  } else {
    // 메르카토르 y -> 위도. 해석적으로 정확히 되돌린다.
    float lat = degrees(2.0 * atan(exp(radians(180.0 - 360.0 * v_merc.y)))
                        - 1.5707963267948966);
    float lon = v_merc.x * 360.0 - 180.0;
    g = vec2((lon - u_origin.x) / u_delta.x, (lat - u_origin.y) / u_delta.y);
  }
  /* 판 가장자리도 **맨 바깥 격자선**에서 끊는다. 예전엔 반 칸(-0.5) 더
     나갔는데, 그 반 칸에는 격자선이 없어 색만 삐져나온 테두리로 보였다. */
  if (g.x < 0.0 || g.y < 0.0 ||
      g.x > float(u_size.x) - 1.0 || g.y > float(u_size.y) - 1.0) discard;

  ivec2 i0 = ivec2(floor(g));
  vec2  fr = g - floor(g);
  float va, vb, ra, rb;
  bool oa, ob;
  /* 등치선을 얹는 판(해면기압)만 B-스플라인으로 간다. 16탭이라 값은
     비싸고, 바다만 있는 변수는 4x4 창이 육지를 두 칸쯤 물어 색이 뭍으로
     번진다. 기압은 육지에도 값이 있어(코드 0 이 없어) 번질 데가 없다. */
  if (u_iso > 0.0) {
    oa = bspline(u_fa, g, va, ra);
    ob = bspline(u_fb, g, vb, rb);
  } else {
    oa = bilin(u_fa, i0, fr, va, ra);
    ob = bilin(u_fb, i0, fr, vb, rb);
  }
  if (!oa && !ob) discard;
  float t = !ob ? va : (!oa ? vb : mix(va, vb, u_tf));
  float r = !ob ? ra : (!oa ? rb : mix(ra, rb, u_tf));

  /* 색상표의 **알파도 읽는다.** 여느 색상표는 전부 255 라 예전과 똑같이
     굴지만, 특보판처럼 "기준 아래는 아예 안 칠한다" 는 판을 색상표만
     갈아끼워 만들 수 있게 된다 — 셰이더를 따로 둘 이유가 없다. */
  vec4  c4 = texture(u_pal, vec2(clamp(t, 0.0, 1.0), 0.5));
  float av = u_opacity * c4.a;
  vec3  pc = c4.rgb * av;            // premultiplied
  float pa = av;

  /* 등압선. 색칠판 **위에** 얹는다 (source-over). 색칠판 투명도와 따로 놀게
     해야 배경을 비쳐 보려고 투명도를 낮춰도 선은 읽힌다. */
  if (u_iso > 0.0) {
    float thin = isoline(r / u_iso, 0.55);
    float bold = u_isob > 0.0 ? isoline(r / u_isob, 0.95) : 0.0;
    float la = max(thin * 0.62, bold * 0.92);
    if (la > 0.002) {
      vec3 lrgb = vec3(0.02, 0.04, 0.07);
      pc = lrgb * la + pc * (1.0 - la);
      pa = la + pa * (1.0 - la);
    }
  }

  fragColor = vec4(pc, pa);
}`;

/* ── 입자: 리본 ────────────────────────────────────────────────────
   ref/app/maplibre_schism.js 의 방식을 그대로 옮겼다. 예전에 여기 있던
   화면공간 잔상(ping-pong FBO + 점 찍기)은 지도를 움직일 때마다 꼬리를
   통째로 지워야 했고, 점이 수만 개라 화면이 하얗게 뭉갰다.

   지금은 입자 하나가 **30개 점을 잇는 연속 리본** 하나다. 적분은 CPU 에서
   경위도 공간으로 하고 (그래서 지도를 움직여도 꼬리가 안 지워진다), GPU 는
   점 배열을 받아 삼각형 두 장씩으로 이어 그린다.

   마이터 법선은 셰이더가 **투영을 통과한 뒤 화면 픽셀 좌표에서** 계산한다.
   CPU 가 메르카토르 방향공간에서 미리 계산해 넘기면 45도 대각선에서 폭이
   접혀 점선처럼 끊긴다 (레퍼런스가 겪은 그대로다). */
const RIBBON_VS = `#version 300 es
in vec2  a_pos;     // 메르카토르 0~1 (이 점)
in vec2  a_prev;    // 앞 점 (없으면 a_pos 와 같다)
in vec2  a_next;    // 뒤 점 (없으면 a_pos 와 같다)
in float a_spd;     // 그 지점의 빠르기
in float a_side;    // -1 / +1
in float a_t;       // 0(꼬리) ~ 1(머리)

uniform mat4  u_matrix;
uniform vec2  u_viewport;   // 디바이스 픽셀
uniform float u_halfpx;     // 반폭 (디바이스 픽셀, 페더 포함)

out float v_side;
out float v_t;
out float v_spd;

/* 클립좌표 -> 화면 픽셀. 뷰포트가 정사각이 아니므로 NDC 에서 바로
   정규화하면 대각선 방향의 폭이 틀어진다. */
vec2 toPx(vec4 c){ return (c.xy / c.w) * u_viewport * 0.5; }

void main(){
  vec4 cp = u_matrix * vec4(a_pos,  0.0, 1.0);
  vec2 P  = toPx(cp);
  vec2 A  = toPx(u_matrix * vec4(a_prev, 0.0, 1.0));
  vec2 B  = toPx(u_matrix * vec4(a_next, 0.0, 1.0));

  vec2 ta = P - A; float la = length(ta);
  vec2 tb = B - P; float lb = length(tb);
  ta = la > 1e-6 ? ta / la : vec2(0.0);
  tb = lb > 1e-6 ? tb / lb : vec2(0.0);
  if (la <= 1e-6) ta = tb;    // 꼬리 끝: 뒤쪽 접선이 없다
  if (lb <= 1e-6) tb = ta;    // 머리 끝: 앞쪽 접선이 없다

  vec2 m = vec2(0.0);
  if (dot(ta, ta) > 0.5) {    // 둘 다 없으면(빈 슬롯) 폭 0 으로 접는다
    vec2 t = ta + tb;
    float tl = length(t);
    if (tl > 1e-6) {
      t /= tl;
      // 꺾이는 안쪽에서 두 세그먼트의 테두리가 만나도록 늘린다.
      // 상한 3.0 은 급히 꺾일 때 마이터가 폭주하는 것을 막는다.
      m = vec2(-t.y, t.x) * min(3.0, 1.0 / max(0.35, dot(t, tb)));
    } else {
      m = vec2(-tb.y, tb.x);  // 180도 되접힘
    }
  }

  vec2 offPx = m * (a_side * u_halfpx);
  gl_Position = vec4(cp.xy / cp.w + offPx / u_viewport * 2.0, cp.z / cp.w, 1.0);

  v_side = a_side;
  v_t    = a_t;
  v_spd  = a_spd;
}`;

const RIBBON_FS = `#version 300 es
precision highp float;

in float v_side;
in float v_t;
in float v_spd;
out vec4 fragColor;

uniform float u_halfpx;   // 반폭 (페더 포함)
uniform float u_corepx;   // 실제 선 반폭
uniform float u_alpha;    // 전체 밝기
uniform float u_smax;     // 밝기 기준 빠르기

void main(){
  /* 중심선으로부터의 픽셀 거리. a_side 가 -1..+1 로 보간되므로
     |side|*halfpx 가 곧 거리다. */
  float dpx = abs(v_side) * u_halfpx;
  /* 픽셀당 표본을 한 번만 뜨는 래스터라이저에서 가는 리본을 smoothstep 으로
     깎으면 밝기가 길이 방향으로 오르내려 리본이 점선처럼 끊긴다. 폭 방향
     커버리지를 1픽셀 박스필터의 정확한 해(기울기 1인 선형 램프)로 두면
     한 픽셀 열의 커버리지 합이 위상과 무관해져 진동이 사라진다. */
  float aa = clamp(u_corepx + 0.5 - dpx, 0.0, 1.0);
  if (aa <= 0.004) discard;

  float head = pow(clamp(v_t, 0.0, 1.0), 1.7);

  /* 아래 색칠판이 이미 값을 색으로 말하고 있으니 입자는 흰 계열로 둔다.
     다만 빠르기를 알파에 조금 실어 준다 — 색칠판이 다른 변수(기온 등)일 때
     바람이 센 곳을 이걸로 읽을 수 있다. */
  float sn = clamp(v_spd / max(1e-6, u_smax), 0.0, 1.0);
  float a  = (0.02 + 0.98 * head) * (0.55 + 0.45 * sqrt(sn)) * aa * u_alpha;
  if (a <= 0.004) discard;

  vec3 rgb = mix(vec3(0.60, 0.68, 0.80), vec3(0.95, 0.97, 1.0), head);
  fragColor = vec4(rgb * a, a);          // premultiplied
}`;

// ─────────────────────────────────────────────────────────────────────
// GL 도우미
// ─────────────────────────────────────────────────────────────────────
function shader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
        throw new Error("셰이더 컴파일 실패:\n" + gl.getShaderInfoLog(s));
    return s;
}

function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error("셰이더 링크 실패:\n" + gl.getProgramInfoLog(p));
    // 위치를 미리 다 뽑아 둔다. 매 프레임 getUniformLocation 을 부르면
    // 드라이버가 문자열 조회를 해서 은근히 비싸다.
    const u = {}, a = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
        const nm = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, "");
        u[nm] = gl.getUniformLocation(p, nm);
    }
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i < n; i++) {
        const nm = gl.getActiveAttrib(p, i).name;
        a[nm] = gl.getAttribLocation(p, nm);
    }
    return { p, u, a };
}

function tex(gl, linear) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    return t;
}

/* 코드판을 GPU 로 올린다. **저장소는 처음 한 번만 잡는다.**

   texImage2D 는 "이 판을 이런 크기·형식으로 다시 정의한다"는 뜻이라, 크기가
   똑같아도 드라이버가 저장소를 새로 할당하고 옛 것을 버린다. SWAN 은 판
   하나가 720×712 = 512KB 다 — 정시마다 그 할당이 일어나고, 그 판이 바로
   직전 프레임에서 아직 그려지고 있으면 드라이버는 그리기가 끝날 때까지
   기다렸다가(파이프라인 멈춤) 할당한다. 폰의 타일 GPU 에서 특히 비싸다.
   "정시로 넘어갈 때만 툭 하고 걸린다"의 남은 절반이 여기였다.

   texStorage2D 로 한 번 잡아 두면 판은 불변이 되고, 그 뒤로는 texSubImage2D
   가 **있는 자리에 덮어쓰기만** 한다 — 할당도, 옛 저장소 회수도 없다.
   불변이라 크기가 달라지면(모델 갈아타기) 판 자체를 새로 만들어야 한다.
   그래서 쓰던 판을 돌려준다 — 부르는 쪽은 반드시 그 값을 다시 받아야 한다. */
function codeTex(gl, t, nx, ny, data) {
    if (t._nx !== nx || t._ny !== ny) {
        if (t._nx) { gl.deleteTexture(t); t = tex(gl); }   // 이미 굳은 판이다
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, nx, ny);
        t._nx = nx; t._ny = ny;
    } else {
        gl.bindTexture(gl.TEXTURE_2D, t);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nx, ny,
                     gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
    return t;
}

function f32Tex(gl, t, n, comps, data) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    const ifmt = comps === 1 ? gl.R32F : gl.RG32F;
    const fmt = comps === 1 ? gl.RED : gl.RG;
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, n, 1, 0, fmt, gl.FLOAT, data);
}

function rgbaTex(gl, t, w, h, data) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

function bindTex(gl, unit, t, prog, name) {
    if (prog.u[name] === undefined) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(prog.u[name], unit);
}

// ─────────────────────────────────────────────────────────────────────
// 모델별 격자 기하 (한 번 만들면 모델을 바꿔도 남겨 둔다)
// ─────────────────────────────────────────────────────────────────────
class Geometry {
    constructor(gl, model, grid, lonlat) {
        this.model = model;
        this.grid = grid;
        this.curv = grid.kind === "curvilinear";
        const [[latMin, lonMin], [latMax, lonMax]] = grid.bounds;
        this.bbox = [lonMin, latMin, lonMax - lonMin, latMax - latMin];
        this.lookupF32 = null;
        this.lookupRes = 0;
        this.lutBox = this.bbox;

        if (!this.curv) {
            // 사각형 하나. 정점 4개면 끝난다. (메르카토르 y 는 북쪽이 작다)
            const x0 = mercX(lonMin), x1 = mercX(lonMax);
            const y0 = mercY(latMax), y1 = mercY(latMin);
            const v = new Float32Array([x0, y0, 0, 0, x1, y0, 0, 0,
                                        x0, y1, 0, 0, x1, y1, 0, 0]);
            this.count = 4;
            this.mode = gl.TRIANGLE_STRIP;
            this.vbo = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
            gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
            this.ibo = null;
            return;
        }

        const nx = grid.nx, ny = grid.ny;
        const ll = new Float32Array(lonlat);
        const v = new Float32Array(nx * ny * 4);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const s = (j * nx + i) * 2, d = (j * nx + i) * 4;
                v[d] = mercX(ll[s]);
                v[d + 1] = mercY(ll[s + 1]);
                v[d + 2] = i;
                v[d + 3] = j;
            }
        }
        const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
        let k = 0;
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                idx[k++] = a; idx[k++] = b; idx[k++] = c;
                idx[k++] = b; idx[k++] = d; idx[k++] = c;
            }
        }
        this.count = idx.length;
        this.mode = gl.TRIANGLES;
        this.vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
        this.ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    }

    /* (lon,lat) -> (i,j) 조회표. 상자 안 0~1 좌표로 색인한다. 격자 밖은 -1.

       예전에는 이걸 RGBA8 텍스처로도 구워 올렸다. 입자를 셰이더에서 굴릴
       때 필요했기 때문인데, 이제 적분이 CPU 로 내려왔으므로 GPU 사본은
       쓰는 데가 없다 (색칠판은 정점마다 (i,j) 를 실어 보낸다). 1024² 짜리
       4MB 를 그냥 안 만든다. */
    setLookup(_gl, buf, res, meta) {
        this.lookupF32 = new Float32Array(buf);
        this.lookupRes = res;
        /* 조회표가 덮는 상자는 grid.bounds 와 같게 만들고 있지만, 같다고
           **가정**하면 나중에 조회표만 다시 구웠을 때 조용히 어긋난다.
           격자점은 lon_min..lon_max 에 균등하게 놓인다 (linspace). */
        this.lutBox = meta
            ? [meta.lon_min, meta.lat_min, meta.lon_max - meta.lon_min,
               meta.lat_max - meta.lat_min]
            : this.bbox;
    }

    bind(gl, prog) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.enableVertexAttribArray(prog.a.a_merc);
        gl.vertexAttribPointer(prog.a.a_merc, 2, gl.FLOAT, false, 16, 0);
        if (prog.a.a_ij !== undefined && prog.a.a_ij >= 0) {
            gl.enableVertexAttribArray(prog.a.a_ij);
            gl.vertexAttribPointer(prog.a.a_ij, 2, gl.FLOAT, false, 16, 8);
        }
        if (this.ibo) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    }

    draw(gl) {
        if (this.ibo) gl.drawElements(this.mode, this.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(this.mode, 0, this.count);
    }
}

// ─────────────────────────────────────────────────────────────────────
// 렌더러
// ─────────────────────────────────────────────────────────────────────
export class Renderer {
    constructor() {
        this.gl = null;
        this.geo = {};
        this.opacity = 0.85;
        this.flowOn = true;
        this.smax = 20;             // 입자 밝기 기준 빠르기
        this.sref = 12;             // 입자 걸음 기준 빠르기 (모델별 정규화)
        this.tf = 0;
        /* 섞임 비율을 **그릴 때** 다시 물어보는 갈고리.

           이게 없으면 이런 일이 난다: 정시에 자료가 걸리면 apply 가 판 두
           장을 맞바꾸고(A←옛 B, B←새 프레임) 곧바로 지도에 다시 그리라고
           시킨다. 그런데 this.tf 는 rAF 안에서만 새로 적히므로, 그 다시
           그리는 한 프레임은 **새 판을 옛 비율(≈1.0)로** 섞는다 — 화면이
           한 시간 앞으로 확 튀었다가 다음 프레임에 제자리로 끌려온다.
           "잠깐 앞뒤로 당기는 느낌"이 정확히 이거다. 그리기 직전에 한 번
           물어보면 판과 비율이 언제나 짝이 맞는다. */
        this.tfFn = null;
        this.ready = false;
        this._model = null;
        this._hasField = false;
        this._hasFlow = false;
        this._keyA = null; this._keyB = null;   // 지금 GPU 에 올라가 있는 두 프레임
        this._lutKey = null;                    // 지금 올라가 있는 색표

        // 시점. koos.js 가 지도 move 마다 넣어 준다.
        this.zoom = 6;
        this.bounds = null;         // [w, s, e, n]
        this.baseCount = BASE_COUNT;
        this.trailMul = 1;          // 꼬리 길이 배수 (레이어 패널)

        this.flow = null;           // CPU 쪽 유동장 (아래 _vecAt 이 읽는다)
        this._P = null;             // 입자 버퍼
        this._need = true;          // 다시 뿌려야 한다
        this._geomDirty = true;
        this._lastMs = 0;
        this._tick = 0;
        this._pool = null;
        this._poolN = 0;
        this._jitter = 0.05;
        this._uvA = new Float64Array(2);
        this._uvB = new Float64Array(2);
        this._vec = { u: 0, v: 0, speed: 0 };
    }

    init(gl) {
        if (this.gl) return;
        if (typeof WebGL2RenderingContext === "undefined" ||
            !(gl instanceof WebGL2RenderingContext))
            throw new Error("이 브라우저는 WebGL2 를 안 켜 준다");
        this.gl = gl;

        this.pField = program(gl, FIELD_VS, FIELD_FS);
        this.pRib = program(gl, RIBBON_VS, RIBBON_FS);

        this.vao = gl.createVertexArray();
        this.texA = tex(gl); this.texB = tex(gl);
        this.valTex = tex(gl); this.rawTex = tex(gl); this.palTex = tex(gl, true);

        this.bVert = gl.createBuffer();
        this.bStat = gl.createBuffer();
        this.bIdx = gl.createBuffer();
        this.ready = true;
    }

    /** 밀도 배수 (0.5 / 1 / 2 / 4). 상한을 두어 손이 미끄러져도 안 죽게 한다. */
    setDensity(mult) {
        const n = Math.max(200, Math.min(6000, Math.round(BASE_COUNT * mult)));
        if (n === this.baseCount) return;
        this.baseCount = n;
        this._need = true;
    }

    /** 지도 시점. reseed 는 pan/zoom 이 **끝났을 때**만 참으로 준다.
        태어날 자리를 다시 뽑는 일이 vectorAt 을 만 번 넘게 부르기 때문에
        드래그 중에 매 프레임 돌리면 지도가 끊긴다. */
    setView(zoom, bounds, reseed) {
        this.zoom = zoom;
        this.bounds = bounds;
        if (!reseed || !this._hasFlow) return;
        this._buildPool();
        const b = this._P;
        if (!b || !bounds) return;
        // 화면 밖으로 밀려난 입자는 순간이동시키지 않고 흘려보낸다.
        for (let p = 0; p < b.n; p++) {
            const lo = b.lon[p], la = b.lat[p];
            if (lo < bounds[0] || lo > bounds[2] || la < bounds[1] || la > bounds[3])
                b.drain[p] = 1;
        }
    }

    addGeometry(model, grid, lonlat) {
        this.geo[model] = new Geometry(this.gl, model, grid, lonlat);
        return this.geo[model];
    }

    /* ── 프레임 올리기 ──────────────────────────────────────────── */
    /* iso = {step, bold} 이면 그 간격으로 등치선을 겹쳐 그린다. rawLut 은
       코드->물리값 표다 — valLut 은 vmin..vmax 로 잘린 0~1 이라 표시범위를
       벗어난 등압선(태풍 중심의 970hPa 같은 것)이 통째로 사라진다. */
    setScalar(model, valLut, palette, codesA, codesB, rawLut, iso, keyA, keyB, lutKey) {
        const gl = this.gl, g = this.geo[model];
        /* 한 칸 나아갈 때 **새 프레임만** 올린다.

           스텝 N 의 뒷 프레임은 스텝 N+1 의 앞 프레임과 같은 자료다. 전에는
           그걸 매 스텝 다시 올렸다 — SWAN 은 판 하나가 512KB 라 초당 1MB 를
           헛되이 밀어 넣은 셈이고, 그 업로드가 정시마다 한 번씩 화면을
           붙잡았다. "1배속인데도 색칠판이 버벅인다"의 절반이 여기였다.
           이제 두 판을 맞바꾸고 뒤 판에만 새 자료를 넣는다. */
        const shift = keyA && this._model === model && this._keyB === keyA;
        if (shift) {
            const t = this.texA; this.texA = this.texB; this.texB = t;
            this.texB = codeTex(gl, this.texB, g.grid.nx, g.grid.ny, codesB || codesA);
        } else {
            this.texA = codeTex(gl, this.texA, g.grid.nx, g.grid.ny, codesA);
            this.texB = codeTex(gl, this.texB, g.grid.nx, g.grid.ny, codesB || codesA);
        }
        this._keyA = keyA || null;
        this._keyB = keyB || null;
        // 색표는 변수를 갈아끼울 때만 바뀐다. 정시마다 다시 올릴 이유가 없다.
        if (!lutKey || lutKey !== this._lutKey) {
            f32Tex(gl, this.valTex, 256, 1, valLut);
            f32Tex(gl, this.rawTex, 256, 1, rawLut || valLut);
            rgbaTex(gl, this.palTex, 256, 1, palette);
            this._lutKey = lutKey || null;
        }
        this.iso = rawLut && iso && iso.step > 0 ? iso : null;
        this._model = model;
        this._hasField = true;
    }

    /* 유동장은 이제 GPU 로 안 올린다. 적분이 CPU 로 내려왔으므로 코드 배열과
       LUT 를 그대로 들고 있으면 된다. 배열은 청크의 부분뷰라 복사가 없다. */
    setFlow(model, spdA, spdB, dirA, dirB, spdLut, dirLut, smax, sref) {
        const g = this.geo[model];
        const first = !this.flow || this.flow.model !== model;
        this.flow = {
            model, nx: g.grid.nx, ny: g.grid.ny, curv: g.curv, bbox: g.bbox,
            lon0: g.grid.lon0 || 0, lat0: g.grid.lat0 || 0,
            dlon: g.grid.dlon || 1, dlat: g.grid.dlat || 1,
            lut: g.lookupF32, lutRes: g.lookupRes, lutBox: g.lutBox,
            sa: spdA, sb: spdB || spdA, da: dirA, db: dirB || dirA,
            sl: spdLut, dl: dirLut,
        };
        this.smax = smax;
        this.sref = sref || smax * 0.6;
        this._hasFlow = true;
        // 모델이 바뀌면 격자도 도메인도 바뀐다. 옛 자리의 입자는 버린다.
        if (first) this._need = true;
    }

    clearField() {
        this._hasField = false;
        this._keyA = this._keyB = this._lutKey = null;   // 올라가 있는 게 없다
    }

    /* 색칠판과 **따로** 비운다. 예전엔 clearField 만 있어서, 그 시각에 자료가
       없으면 색은 사라지는데 입자는 계속 흘렀다 — 마지막으로 받아 둔 유동장을
       붙들고 있었기 때문이다. MOHID 처럼 뒷날 원본이 늦게 들어오는 모델에서는
       "결측이라 아무것도 없다"고 적어 놓고 화면에는 유향이 도는 꼴이 된다.
       남의 시각 흐름을 지금 것인 양 보이는 건 색을 늘려 그리는 것과 같은
       거짓말이라, 자료가 없으면 입자도 같이 끈다. */
    clearFlow() {
        this.flow = null;
        this._hasFlow = false;
        this._need = true;          // 다시 들어오면 처음부터 뿌린다
    }

    /** 입자를 처음부터 다시 뿌린다 (모델·변수가 바뀌었을 때). */
    resetParticles() { this._need = true; }

    // ── 유동장 표집 ─────────────────────────────────────────────────
    /* 코드 0 은 육지다. 네 칸 중 육지는 빼고 남은 가중치를 다시 정규화한다.
       방향은 각이 아니라 단위벡터로 들어 있으므로 (dirLUT) 그냥 더하면 된다.
       각을 더하면 ±180° 경계에서 값이 뒤집힌다. */
    _bilin(sp, dr, i0, j0, fx, fy, out) {
        const F = this.flow, nx = F.nx, ny = F.ny, sl = F.sl, dl = F.dl;
        let ax = 0, ay = 0, sw = 0;
        for (let dy = 0; dy < 2; dy++) {
            const j = j0 + dy < ny ? j0 + dy : ny - 1;
            const wy = dy ? fy : 1 - fy;
            if (wy <= 0) continue;
            for (let dx = 0; dx < 2; dx++) {
                const i = i0 + dx < nx ? i0 + dx : nx - 1;
                const k = j * nx + i;
                const cs = sp[k], cd = dr[k];
                if (cs === 0 || cd === 0) continue;
                const w = (dx ? fx : 1 - fx) * wy;
                if (w <= 0) continue;
                const s = sl[cs];
                ax += w * s * dl[cd * 2];
                ay += w * s * dl[cd * 2 + 1];
                sw += w;
            }
        }
        if (sw < 1e-5) return false;
        out[0] = ax / sw; out[1] = ay / sw;
        return true;
    }

    /** (lon,lat) 의 유동 벡터. 육지·격자 밖이면 null.
        돌려주는 객체는 **재사용**한다 — 초당 5만 번 불려 GC 가 톱니를 만든다. */
    _vecAt(lon, lat) {
        const F = this.flow;
        if (!F) return null;

        let gi, gj;
        if (F.curv) {
            if (!F.lut) return null;
            const B = F.lutBox;
            const px = (lon - B[0]) / B[2];
            const py = (lat - B[1]) / B[3];
            if (!(px >= 0 && px <= 1 && py >= 0 && py <= 1)) return null;
            const R = F.lutRes, R1 = R - 1;
            const o = (Math.round(py * R1) * R + Math.round(px * R1)) * 2;
            gi = F.lut[o]; gj = F.lut[o + 1];
            if (gi < 0 || gj < 0) return null;         // 격자 밖
        } else {
            gi = (lon - F.lon0) / F.dlon;
            gj = (lat - F.lat0) / F.dlat;
        }
        const nx1 = F.nx - 1, ny1 = F.ny - 1;
        if (!(gi >= 0 && gj >= 0 && gi <= nx1 && gj <= ny1)) return null;

        const i0 = gi | 0, j0 = gj | 0;
        const fx = gi - i0, fy = gj - j0;
        const A = this._uvA, B = this._uvB;
        const oa = this._bilin(F.sa, F.da, i0, j0, fx, fy, A);
        const ob = this._bilin(F.sb, F.db, i0, j0, fx, fy, B);
        if (!oa && !ob) return null;

        let u, v;
        if (!ob) { u = A[0]; v = A[1]; }
        else if (!oa) { u = B[0]; v = B[1]; }
        else { const t = this.tf; u = A[0] + (B[0] - A[0]) * t; v = A[1] + (B[1] - A[1]) * t; }

        const o = this._vec;
        o.u = u; o.v = v; o.speed = Math.sqrt(u * u + v * v);
        return o;
    }

    // ── 태어날 자리 ─────────────────────────────────────────────────
    /* 화면 안에서 무작위로 찍어 보고 물에 떨어진 점만 모은다. 이걸 안 하고
       매번 찍어 볼 때까지 되풀이하면, 화면 대부분이 육지일 때 한 입자가
       태어나는 데 수십 번씩 걸려 적분이 통째로 밀린다. */
    _buildPool() {
        this._poolN = 0;
        const F = this.flow;
        if (!F) return;
        if (!this._pool) this._pool = new Float64Array(SPAWN_POOL_MAX * 2);

        const fill = (w, s, e, n) => {
            const lonSpan = e - w, latSpan = n - s;
            let k = this._poolN, tries = 0;
            const maxTries = SPAWN_POOL_MAX * 5;
            while (k < SPAWN_POOL_MAX && tries < maxTries) {
                tries++;
                const lon = w + Math.random() * lonSpan;
                const lat = s + Math.random() * latSpan;
                if (this._vecAt(lon, lat)) {
                    this._pool[k * 2] = lon; this._pool[k * 2 + 1] = lat; k++;
                }
                // 물이 거의 없는 화면이면 일찍 빠져나온다
                if (tries === 800 && k - this._poolN < 24) break;
            }
            this._poolN = k;
            return e - w > 0 && n - s > 0
                ? Math.min(0.5, Math.sqrt(lonSpan * latSpan / Math.max(1, k)) * 0.9)
                : 0.05;
        };

        const [lonMin, latMin, lonSpan, latSpan] = F.bbox;
        let w = lonMin, s = latMin, e = lonMin + lonSpan, n = latMin + latSpan;
        const bd = this.bounds;
        if (bd) {
            // 가장자리에서 태어나면 곧바로 화면 밖으로 나간다. 살짝 안쪽으로.
            const px = (bd[2] - bd[0]) * 0.04, py = (bd[3] - bd[1]) * 0.04;
            const w2 = Math.max(w, bd[0] + px), e2 = Math.min(e, bd[2] - px);
            const s2 = Math.max(s, bd[1] + py), n2 = Math.min(n, bd[3] - py);
            if (w2 < e2 && s2 < n2) { w = w2; e = e2; s = s2; n = n2; }
        }
        this._jitter = fill(w, s, e, n);

        // 화면에 물이 거의 없으면 도메인 전체에서 다시 뽑는다. 그래야 화면을
        // 육지로 채워 놓아도 입자가 0이 되어 영영 안 살아나는 일이 없다.
        if (this._poolN < 64) {
            this._jitter = fill(lonMin, latMin, lonMin + lonSpan, latMin + latSpan);
        }
    }

    _spawnPoint() {
        if (this._poolN <= 0) this._buildPool();
        if (this._poolN <= 0) return null;
        const k = (Math.random() * this._poolN) | 0;
        const lon = this._pool[k * 2], lat = this._pool[k * 2 + 1];
        /* 풀이 고정 3072점이라 그대로 쓰면 같은 자리에서 계속 태어나 격자처럼
           뭉친다. 살짝 흔들되 흔든 자리가 육지면 원래 점을 쓴다. */
        const jl = lon + (Math.random() - 0.5) * this._jitter;
        const jt = lat + (Math.random() - 0.5) * this._jitter;
        if (this._vecAt(jl, jt)) { this._sp0 = jl; this._sp1 = jt; return true; }
        this._sp0 = lon; this._sp1 = lat;
        return true;
    }

    // ── 입자 버퍼 ───────────────────────────────────────────────────
    _ensureCap(want) {
        const P = this._P;
        if (P && P.cap >= want) return P;

        const cap = Math.max(64, want);
        const b = {
            n: 0, cap, uploaded: 0,
            lon: new Float64Array(cap), lat: new Float64Array(cap),
            u: new Float32Array(cap), v: new Float32Array(cap), spd: new Float32Array(cap),
            age: new Int32Array(cap), maxAge: new Int32Array(cap),
            fill: new Int32Array(cap), head: new Int32Array(cap), drain: new Int32Array(cap),
            trail: new Float32Array(cap * PT * 3),      // mercX, mercY, speed
            vert: new Float32Array(cap * PVERT * PSTRIDE),
            stat: new Float32Array(cap * PVERT),        // a_side
            idx: new Uint32Array(cap * PSEG * 6),
            // 리샘플용 임시. 입자마다 새로 잡으면 프레임마다 GC 가 돈다.
            tx: new Float64Array(PT), ty: new Float64Array(PT), ts: new Float32Array(PT),
            cum: new Float64Array(PT),
            rx: new Float64Array(PT), ry: new Float64Array(PT), rs: new Float32Array(PT),
        };
        // 갓 잡은 칸은 비어 있다. drain=1 로 두면 다음 프레임에 알아서 태어난다.
        b.drain.fill(1);
        for (let p = 0; p < cap; p++) {
            const vb = p * PVERT;
            for (let i = 0; i < PT; i++) { b.stat[vb + i * 2] = -1; b.stat[vb + i * 2 + 1] = 1; }
            const ib = p * PSEG * 6;
            for (let j = 0; j < PSEG; j++) {
                const v0 = vb + j * 2, o = ib + j * 6;
                b.idx[o] = v0; b.idx[o + 1] = v0 + 1; b.idx[o + 2] = v0 + 2;
                b.idx[o + 3] = v0 + 1; b.idx[o + 4] = v0 + 3; b.idx[o + 5] = v0 + 2;
            }
        }
        this._P = b;
        return b;
    }

    /* stagger 면 남은 수명을 흩뿌린다. 안 그러면 처음 뿌린 입자가 한꺼번에
       죽어 화면 전체가 깜빡인다. */
    _spawn(p, stagger) {
        const b = this._P;
        const ok = this._spawnPoint();
        const lon = ok ? this._sp0 : this.flow.bbox[0];
        const lat = ok ? this._sp1 : this.flow.bbox[1];

        b.lon[p] = lon; b.lat[p] = lat;
        /* 수명이 길수록 입자가 수렴대로 쓸려가 쌓인다(=쏠림). 주기적으로
           갈아엎어 분포를 태어날 때의 균등 분포 쪽으로 되돌린다. */
        b.maxAge[p] = 240 + ((Math.random() * 210) | 0);
        b.age[p] = stagger ? ((Math.random() * b.maxAge[p]) | 0) : 0;
        b.head[p] = 0;
        b.fill[p] = 1;
        b.drain[p] = 0;

        const vec = ok ? this._vecAt(lon, lat) : null;
        if (vec) { b.u[p] = vec.u; b.v[p] = vec.v; b.spd[p] = vec.speed; }
        else { b.u[p] = 0; b.v[p] = 0; b.spd[p] = 0; b.drain[p] = 1; }

        const o = p * PT * 3;
        b.trail[o] = mercX(lon); b.trail[o + 1] = mercY(lat); b.trail[o + 2] = b.spd[p];
    }

    /* 축소하면 같은 화면에 담기는 바다가 넓어지는데 입자 수는 그대로다. 즉
       단위면적당 잉크가 급격히 올라가 선끼리 붙어 얼룩 하나로 뭉개진다.
       선 사이에 어두운 틈이 남아 있어야 흐름의 결이 보인다. */
    _densityMul() {
        const z = this.zoom;
        if (z <= 4) return 0.55;
        if (z >= 9) return 1.0;
        return 0.55 + (z - 4) * (0.45 / 5);
    }

    _wantCount() {
        return Math.max(200, Math.round(this.baseCount * this._densityMul()));
    }

    _reseed() {
        const want = this._wantCount();
        // 확대해서 목표치가 늘 때 재할당이 일어나면 기존 상태가 통째로 날아간다.
        // 상한(baseCount)으로 한 번에 잡아 둔다.
        const b = this._ensureCap(Math.max(want, this.baseCount));
        this._buildPool();
        b.n = want;
        for (let p = 0; p < want; p++) this._spawn(p, true);
        this._need = false;
        this._geomDirty = true;
    }

    /* 한 스텝에 몇 도를 가는가. sref 로 나눠 두면 바람(10m/s)과 해류(0.3m/s)가
       같은 빠르기로 흘러 보인다 — 모델을 바꿔도 화면 느낌이 유지된다.
       확대(dz>0)는 화면 이동 픽셀을 지키도록 강하게, 축소(dz<0)는 완만하게
       보정한다. 축소하면 같은 픽셀 속도라도 체감이 몇 배 빠르기 때문이다. */
    _flowStep() {
        const dz = this.zoom - 7;
        const f = Math.pow(2, -(dz >= 0 ? 0.88 : 0.45) * dz);
        return 0.006 * Math.max(0.03, Math.min(4.0, f)) / Math.max(1e-6, this.sref);
    }

    /* 꼬리 길이에 하한과 상한을 같이 건다. 하한만 있으면 느린 곳은 점, 빠른
       곳은 밧줄이 되어 길이 차이가 열 배를 넘는다. 그러면 빠른 흐름을 따라
       밧줄이 뭉쳐 보이고 나머지는 비어 보인다 (= "한곳에 모인다").
       길이는 좁은 범위로 묶고, 빠르기는 밝기로만 말한다. */
    _trailPx() {
        const z = this.zoom, m = this.trailMul;
        let mn, mx;
        if (z <= 4.5) { mn = 11; mx = 26; }
        else if (z >= 8) { mn = 7; mx = 58; }
        else { const f = (z - 4.5) / 3.5; mn = 11 - 4 * f; mx = 26 + 32 * f; }
        return { min: mn * m, max: mx * m };
    }

    /* 꼬리 길이 = 기록한 점 수 × 기록 간격의 이동량. 축소하면 한 스텝의 화면
       이동이 작아져 30점 꼬리가 몇 픽셀로 쪼그라든다. 빠르기를 올려 늘리면
       "너무 빠르다"가 되니 대신 기록 간격을 벌린다. */
    _stride() {
        const z = this.zoom;
        if (z <= 4) return 4;
        if (z <= 5) return 3;
        if (z <= 6.2) return 2;
        return 1;
    }

    // ── 적분 ────────────────────────────────────────────────────────
    _advance(scale) {
        const b = this._P, n = b.n;
        const dt = this._flowStep() * scale;
        this._tick++;
        // 이번 스텝에 꼬리 점을 새로 남길지, 머리 점만 갱신할지
        const advance = (this._tick % this._stride()) === 0;

        for (let p = 0; p < n; p++) {
            if (b.drain[p] > 0) {
                /* 소멸은 순간이동이 아니라 "꼬리가 머리를 따라잡는" 방식.
                   죽는 즉시 다른 곳에서 전체 길이로 튀어나오면 눈에 거슬린다. */
                if (b.fill[p] > 1) b.fill[p]--;
                else this._spawn(p, false);
                continue;
            }

            const lat = b.lat[p];
            let coslat = Math.cos(lat * D2R);
            if (coslat < 1e-6) coslat = 1e-6;

            const nlon = b.lon[p] + (b.u[p] * dt) / coslat;
            const nlat = lat + b.v[p] * dt;

            const vec = this._vecAt(nlon, nlat);
            if (!vec) { b.drain[p] = 1; continue; }     // 육지에 닿으면 흘려보낸다

            b.lon[p] = nlon; b.lat[p] = nlat;
            b.u[p] = vec.u; b.v[p] = vec.v; b.spd[p] = vec.speed;

            b.age[p]++;
            if (b.age[p] > b.maxAge[p]) b.drain[p] = 1;

            /* advance 가 아닐 때는 머리 칸을 덮어쓴다. 머리는 항상 실제
               위치라 지연이 없고, 점 간격만 stride 배로 벌어진다. */
            let h = b.head[p];
            if (advance) {
                h = (h + 1) % PT;
                b.head[p] = h;
                if (b.fill[p] < PT) b.fill[p]++;
            } else if (b.fill[p] < 1) {
                b.fill[p] = 1;
            }
            const o = (p * PT + h) * 3;
            b.trail[o] = mercX(nlon); b.trail[o + 1] = mercY(nlat); b.trail[o + 2] = vec.speed;
        }
    }

    // ── 기하 ────────────────────────────────────────────────────────
    /* 꼬리 점들을 하나의 연속 리본으로 편다. 예전 방식(세그먼트마다 독립된
       캡슐)은 이음매에서 알파가 두 번 겹쳐 밝은 구슬이 생겨 염주처럼 보였다. */
    _buildVerts() {
        const b = this._P, n = b.n;
        const V = b.vert, TR = b.trail;
        const world = 512 * Math.pow(2, this.zoom);
        const range = this._trailPx();
        const minMerc = range.min / world;
        const maxMerc = range.max / world;
        const segMerc = TARGET_SEG_PX / world;
        const tx = b.tx, ty = b.ty, ts = b.ts, cum = b.cum;
        const rx = b.rx, ry = b.ry, rs = b.rs;

        for (let p = 0; p < n; p++) {
            const vb = p * PVERT * PSTRIDE;
            const fill = b.fill[p];

            if (fill < 1) {                       // 빈 칸은 폭 0 으로 접어 둔다
                for (let i = 0; i < PVERT; i++) {
                    const o = vb + i * PSTRIDE;
                    V[o] = 0; V[o + 1] = 0; V[o + 2] = 0; V[o + 3] = 0;
                    V[o + 4] = 0; V[o + 5] = 0; V[o + 6] = 0; V[o + 7] = 0;
                }
                continue;
            }

            // 링버퍼를 시간순으로 편다
            const head = b.head[p], start = (head - fill + 1 + PT * 2) % PT, tb = p * PT * 3;
            for (let i = 0; i < fill; i++) {
                const o = tb + ((start + i) % PT) * 3;
                tx[i] = TR[o]; ty[i] = TR[o + 1]; ts[i] = TR[o + 2];
            }

            cum[0] = 0;
            for (let i = 1; i < fill; i++) {
                const dx = tx[i] - tx[i - 1], dy = ty[i] - ty[i - 1];
                cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy);
            }
            const total = cum[fill - 1];

            let M;
            if (total < minMerc) {
                // 너무 짧다 -> 흐름 방향으로 최소 길이만큼 편 짧은 대시로 그린다
                let dx, dy;
                if (total > 1e-13) {
                    dx = (tx[fill - 1] - tx[0]) / total;
                    dy = (ty[fill - 1] - ty[0]) / total;
                } else {
                    // 메르카토르 y 는 남쪽으로 커진다. (u, v) -> (u, -v)
                    const uu = b.u[p], vv = -b.v[p];
                    const l = Math.sqrt(uu * uu + vv * vv);
                    if (l > 1e-13) { dx = uu / l; dy = vv / l; } else { dx = 1; dy = 0; }
                }
                const hx = tx[fill - 1], hy = ty[fill - 1], hs = ts[fill - 1];
                M = 2;
                rx[0] = hx - dx * minMerc; ry[0] = hy - dy * minMerc; rs[0] = hs;
                rx[1] = hx; ry[1] = hy; rs[1] = hs;
            } else {
                /* 상한을 넘으면 오래된 쪽을 잘라내고 최근 구간만 그린다.
                   기록은 그대로 두므로 머리 위치나 움직임에는 영향이 없다. */
                const from = total > maxMerc ? total - maxMerc : 0;
                const span = total - from;
                M = 1 + Math.round(span / segMerc);
                if (M < 2) M = 2; else if (M > PT) M = PT;

                let j = 0;
                for (let k = 0; k < M; k++) {
                    const target = from + span * k / (M - 1);
                    while (j < fill - 2 && cum[j + 1] < target) j++;
                    const seg = cum[j + 1] - cum[j];
                    const f = seg > 1e-16 ? (target - cum[j]) / seg : 0;
                    rx[k] = tx[j] + (tx[j + 1] - tx[j]) * f;
                    ry[k] = ty[j] + (ty[j + 1] - ty[j]) * f;
                    rs[k] = ts[j] + (ts[j + 1] - ts[j]) * f;
                }
            }

            const pad = PT - M;
            // 남는 앞칸은 꼬리 자리에 폭 0 으로 접어 둔다
            for (let i = 0; i < pad; i++) {
                const o = vb + i * 2 * PSTRIDE;
                const x = rx[0], y = ry[0], s = rs[0];
                for (let h = 0; h < 2; h++) {
                    const q = o + h * PSTRIDE;
                    V[q] = x; V[q + 1] = y;
                    V[q + 2] = x; V[q + 3] = y;      // prev = pos -> 접선 없음
                    V[q + 4] = x; V[q + 5] = y;      // next = pos -> 접선 없음
                    V[q + 6] = s; V[q + 7] = 0;
                }
            }

            for (let k = 0; k < M; k++) {
                /* 마이터 법선은 셰이더가 투영 뒤 화면 픽셀 공간에서 만든다.
                   여기서는 이웃 두 점만 실어 보낸다. 양 끝에서는 자기 자신을
                   넣어 "그쪽 접선 없음"을 표시한다. */
                const x = rx[k], y = ry[k], sp = rs[k], t = k / (M - 1);
                const qx = k > 0 ? rx[k - 1] : x, qy = k > 0 ? ry[k - 1] : y;
                const nx = k < M - 1 ? rx[k + 1] : x, ny = k < M - 1 ? ry[k + 1] : y;
                const o = vb + (pad + k) * 2 * PSTRIDE;
                for (let h = 0; h < 2; h++) {
                    const q = o + h * PSTRIDE;
                    V[q] = x; V[q + 1] = y;
                    V[q + 2] = qx; V[q + 3] = qy;
                    V[q + 4] = nx; V[q + 5] = ny;
                    V[q + 6] = sp; V[q + 7] = t;
                }
            }
        }
    }

    /* 선 반폭(CSS 픽셀). 너무 가늘면 래스터라이저가 픽셀을 통째로 건너뛰어
       회색 보풀만 남는다. */
    _halfCss() {
        const z = this.zoom;
        if (z <= 4.8) return 0.50;
        if (z <= 6.5) return 0.58;
        if (z <= 8.5) return 0.68;
        return 0.80;
    }

    /* 축소하면 밀도를 낮추므로 그만큼 살짝 밝게 올린다. */
    _alphaScale() {
        const z = this.zoom;
        let boost = 1.0;
        if (z <= 5) boost = 1.14;
        else if (z < 9) boost = 1.14 - (z - 5) * (0.14 / 4);
        return 0.68 * boost;
    }

    /* MapLibre 는 GL 상태를 JS 쪽에 **캐싱**한다 (Context 안의 current 값).
       우리가 뒤에서 몰래 바꿔 놓고 안 되돌리면, 캐시는 옛날 값을 믿고
       다시 세팅하지 않는다 — 다음 프레임에 베이스맵이 사라지거나 깊이
       판정이 뒤집힌다. 그래서 우리가 만지는 것은 전부 원래대로 돌린다.
       null 로 되돌리면 안 된다. **들어올 때 있던 값**으로 되돌려야 한다.
       (getParameter 가 싸지는 않지만 레이어당 열 번 남짓이라 견딜 만하다.) */
    _begin() {
        const gl = this.gl;
        this._save = {
            vao:   gl.getParameter(gl.VERTEX_ARRAY_BINDING),
            prog:  gl.getParameter(gl.CURRENT_PROGRAM),
            fb:    gl.getParameter(gl.FRAMEBUFFER_BINDING),
            vp:    gl.getParameter(gl.VIEWPORT),
            unit:  gl.getParameter(gl.ACTIVE_TEXTURE),
            blend: gl.isEnabled(gl.BLEND),
            depth: gl.isEnabled(gl.DEPTH_TEST),
            scis:  gl.isEnabled(gl.SCISSOR_TEST),
            sf:  gl.getParameter(gl.BLEND_SRC_RGB),
            df:  gl.getParameter(gl.BLEND_DST_RGB),
            sfa: gl.getParameter(gl.BLEND_SRC_ALPHA),
            dfa: gl.getParameter(gl.BLEND_DST_ALPHA),
        };
        // 정점 속성은 우리 VAO 안에서만 건드린다. 지도 것과 섞이지 않는다.
        gl.bindVertexArray(this.vao);
        /* 가위질이 켜져 있으면 우리 FBO 패스가 지도 화면 크기로 잘린다.
           입자 위치 텍스처(1024²)를 그릴 때 특히 치명적이다. */
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        return gl;
    }

    _end() {
        const gl = this.gl, s = this._save;
        gl.bindVertexArray(s.vao);
        gl.useProgram(s.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.fb);
        gl.viewport(s.vp[0], s.vp[1], s.vp[2], s.vp[3]);
        gl.activeTexture(s.unit);
        gl.blendFuncSeparate(s.sf, s.df, s.sfa, s.dfa);
        if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
        if (s.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        if (s.scis) gl.enable(gl.SCISSOR_TEST); else gl.disable(gl.SCISSOR_TEST);
    }

    /* ── 색칠판 ─────────────────────────────────────────────────── */
    /** 그리기 직전에 섞임 비율을 최신으로 맞춘다 (tfFn 참고). */
    _syncTf() { if (this.tfFn) this.tf = this.tfFn(); }

    renderField(gl, matrix) {
        if (!this._hasField || !this._model) return;
        this._syncTf();
        const g = this.geo[this._model], P = this.pField;
        this._begin();
        gl.useProgram(P.p);
        g.bind(gl, P);
        gl.uniformMatrix4fv(P.u.u_matrix, false, matrix);
        gl.uniform2i(P.u.u_size, g.grid.nx, g.grid.ny);
        gl.uniform1i(P.u.u_curv, g.curv ? 1 : 0);
        gl.uniform2f(P.u.u_origin, g.grid.lon0 || 0, g.grid.lat0 || 0);
        gl.uniform2f(P.u.u_delta, g.grid.dlon || 1, g.grid.dlat || 1);
        gl.uniform1f(P.u.u_tf, this.tf);
        gl.uniform1f(P.u.u_opacity, this.opacity);
        bindTex(gl, 0, this.texA, P, "u_fa");
        bindTex(gl, 1, this.texB, P, "u_fb");
        bindTex(gl, 2, this.valTex, P, "u_val");
        bindTex(gl, 3, this.palTex, P, "u_pal");
        bindTex(gl, 4, this.rawTex, P, "u_raw");
        gl.uniform1f(P.u.u_iso, this.iso ? this.iso.step : 0);
        gl.uniform1f(P.u.u_isob, this.iso && this.iso.bold ? this.iso.bold : 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        g.draw(gl);
        /* 두 패스가 VAO 를 함께 쓴다. 켜 둔 채 나가면 다음 패스가 이 VBO 를
           엉뚱한 stride 로 읽는다. 나갈 때 반드시 끈다. */
        gl.disableVertexAttribArray(P.a.a_merc);
        if (P.a.a_ij !== undefined && P.a.a_ij >= 0) gl.disableVertexAttribArray(P.a.a_ij);
        this._end();
    }

    /* ── 입자 ───────────────────────────────────────────────────── */
    renderFlow(gl, matrix) {
        this._syncTf();
        if (!this.flowOn || !this._hasFlow || !this._model) return;

        // 1) 적분. 프레임률과 무관하게 같은 속도로 흐르도록 벽시계로 맞춘다.
        const now = performance.now();
        if (this._need) { this._reseed(); this._lastMs = now; }
        const b = this._P;
        if (!b || b.n === 0) return;

        let dtms = now - this._lastMs;
        // 탭이 뒤로 갔다 오면 몇 초가 밀린다. 그걸 다 따라잡으면 입자가
        // 순간이동한다. 몇 스텝만 갚고 나머지는 버린다.
        if (!(dtms > 0)) dtms = SIM_MS;
        if (dtms > SIM_MS * 4) dtms = SIM_MS * 4;
        this._lastMs = now;
        this._advance(dtms / SIM_MS);
        this._buildVerts();

        // 2) 그리기
        /* 화면 배율은 window.devicePixelRatio 가 아니라 **실제 그리기 버퍼**
           에서 잰다. 폰에서는 지도 배율을 2로 눌러 둔다 (koos.js) — 기기가
           3배율이면 둘이 어긋나 입자가 1.5배 굵어진다. */
        const cvs = gl.canvas;
        const dpr = (cvs && cvs.clientWidth)
            ? gl.drawingBufferWidth / cvs.clientWidth
            : (window.devicePixelRatio || 1);
        const corePx = Math.max(0.72, this._halfCss() * dpr);
        const halfPx = corePx + 0.80;          // 페더 여유
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const R = this.pRib;

        this._begin();
        gl.useProgram(R.p);

        /* 정적 버퍼(면 방향·인덱스)는 칸 수가 바뀔 때만 다시 올린다.
           입자 3천 개면 인덱스만 2MB 다 — 매 프레임 올릴 물건이 아니다. */
        if (b.uploaded !== b.cap) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bStat);
            gl.bufferData(gl.ARRAY_BUFFER, b.stat, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.idx, gl.STATIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.bVert);
            gl.bufferData(gl.ARRAY_BUFFER, b.vert.byteLength, gl.DYNAMIC_DRAW);
            b.uploaded = b.cap;
        }

        const used = b.n * PVERT;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bVert);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.vert, 0, used * PSTRIDE);
        const S = PSTRIDE * 4;
        const at = (name, size, off) => {
            const l = R.a[name];
            if (l === undefined || l < 0) return;
            gl.enableVertexAttribArray(l);
            gl.vertexAttribPointer(l, size, gl.FLOAT, false, S, off);
        };
        at("a_pos", 2, 0);
        at("a_prev", 2, 8);
        at("a_next", 2, 16);
        at("a_spd", 1, 24);
        at("a_t", 1, 28);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.bStat);
        gl.enableVertexAttribArray(R.a.a_side);
        gl.vertexAttribPointer(R.a.a_side, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);

        gl.uniformMatrix4fv(R.u.u_matrix, false, matrix);
        gl.uniform2f(R.u.u_viewport, W, H);
        gl.uniform1f(R.u.u_halfpx, halfPx);
        gl.uniform1f(R.u.u_corepx, corePx);
        gl.uniform1f(R.u.u_alpha, this._alphaScale());
        gl.uniform1f(R.u.u_smax, this.smax);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.drawElements(gl.TRIANGLES, b.n * PSEG * 6, gl.UNSIGNED_INT, 0);

        for (const nm of ["a_pos", "a_prev", "a_next", "a_spd", "a_t", "a_side"]) {
            const l = R.a[nm];
            if (l !== undefined && l >= 0) gl.disableVertexAttribArray(l);
        }
        this._end();
    }
}
