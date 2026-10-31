'use strict';
// Shader scenes for the waveform band. Each is a GLSL ES 1.0 fragment shader body
// that renders a wide panorama; COMMON supplies uniforms and helpers.
//   uv   : 0..1 across the band, y pointing down
//   x    : uv.x in band heights (features keep their size on any width)
//   t    : time, advancing at the master deck's tempo (1 unit = 1 s at 120 BPM)
//   beat : beat phase 0..1 (0 = on the beat), for pulses

const SCENE_COMMON = `precision mediump float;
uniform vec2 res; uniform float t; uniform float beat;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash1(float p){ return fract(sin(p * 91.3458) * 47453.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return v; }
float box(vec2 p, vec2 b){ vec2 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, d.y), 0.); }
float fill(float d){ return smoothstep(1.5 / res.y, -1.5 / res.y, d); }
float stars(vec2 p, float density, float tw){
  vec2 id = floor(p), f = fract(p) - .5; float h = hash(id);
  return step(1. - density, h) * smoothstep(.12, 0., length(f + (vec2(hash(id + 3.), hash(id + 7.)) - .5) * .6)) * (.55 + .45 * sin(tw * 3. + h * 60.));
}
`;

const SCENE_MAIN = (body) => `${SCENE_COMMON}
void main(){
  vec2 uv = gl_FragCoord.xy / res; uv.y = 1. - uv.y;
  float A = res.x / res.y, x = uv.x * A, y = uv.y;
  vec3 col = vec3(0.);
${body}
  gl_FragColor = vec4(col, 1.);
}`;

const SCENES = {
  // Tiered falls: misty tree line, a lit lip, streaming water, churning foam and mist.
  waterfall: SCENE_MAIN(`
  float lip = .2 + .05 * sin(x * .9 + 1.) + .025 * sin(x * 2.7);
  col = mix(vec3(.86, .93, .94), vec3(.7, .82, .84), y / lip);
  float trees = lip - .03 - .07 * fbm(vec2(x * 3., 2.));
  col = mix(col, vec3(.32, .45, .43), smoothstep(trees, trees + .015, y) * .65);
  float fy = max(y - lip, 0.);
  float drift = fbm(vec2(x * 1.6, t * .07)) * 1.6;
  float s1 = fbm(vec2(x * 7., fy * 1.4 - t * .65 + drift));
  float s2 = fbm(vec2(x * 18., fy * 3. - t * 1.2));
  vec3 w = mix(vec3(.03, .3, .34), vec3(.1, .58, .62), smoothstep(.3, .72, s1));
  w = mix(w, vec3(.5, .88, .88), smoothstep(.55, .9, s2) * .7);
  w = mix(w, vec3(.95, .99, .99), smoothstep(.0, .55, fy) * smoothstep(.42, .78, s1) * .85);
  w += vec3(.4, .45, .45) * exp(-pow((y - lip) * 30., 2.));
  col = mix(col, w, smoothstep(lip - .008, lip + .008, y));
  float b1 = fbm(vec2(x * 3.2 + t * .06, y * 2.6 + t * .4));
  float b2 = fbm(vec2(x * 8. - t * .12, y * 5. + t * .7));
  col = mix(col, mix(vec3(.72, .88, .88), vec3(1.), b2), smoothstep(.5, .95, y + (b1 - .5) * .55) * .95);
  float mist = .12 + .22 * fbm(vec2(x * 1.2 - t * .04, y * 1.8 - t * .08));
  col = mix(col, vec3(.96, 1., 1.), mist * smoothstep(.1, 1., y) * .6);
`),








  // Aurora over dark mountains and a still lake.
  aurora: SCENE_MAIN(`
  float lake = .74;
  float yy = y > lake ? 2. * lake - y + .004 * sin(x * 30. + t) : y;
  vec3 s = mix(vec3(.01, .02, .06), vec3(.03, .06, .12), yy);
  s += vec3(.85, .9, 1.) * stars(vec2(x, yy) * 30., .05, t);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float base = .3 + .12 * sin(x * .35 + fi * 2. + t * .05) + .08 * fbm(vec2(x * .6 + t * .04, fi));
    float curtain = smoothstep(base - .28, base, yy) * smoothstep(base + .02, base - .01, yy);
    float rays = .5 + .5 * pow(noise(vec2(x * 9. + fi * 5., t * .25)), 2.);
    vec3 c = mix(vec3(.15, 1., .55), vec3(.6, .3, 1.), smoothstep(base - .05, base - .3, yy) + fi * .15);
    s += c * curtain * rays * (.55 - fi * .12);
  }
  float mtn = .55 + .12 * abs(sin(x * .55)) - .1 * fbm(vec2(x * 1.4, 3.));
  s = mix(s, vec3(.02, .03, .05) + vec3(.1, .35, .25) * .25 * smoothstep(mtn + .04, mtn, yy), smoothstep(mtn, mtn + .006, yy));   // mountains, rim-lit
  col = y > lake ? s * .55 : s;
`),
};

// Full-screen scenes behind the console (below the waveform band).
const UNDER_SCENES = {
  // Beneath the falls: caustics, light shafts, a coral reef, kelp, fish and bubbles.
  waterfall: SCENE_MAIN(`
  col = mix(vec3(.05, .34, .38), vec3(.01, .07, .11), pow(y, .8));
  // Caustics: the classic tileable water pattern, strongest near the surface.
  vec2 cp = vec2(x, y) * 3.2;
  vec2 ci = cp; float cs = 1.;
  for (int n = 0; n < 4; n++) {
    float tt = t * .12 * (1. - 3.5 / float(n + 1));
    ci = cp + vec2(cos(tt - ci.x) + sin(tt + ci.y), sin(tt - ci.y) + cos(tt + ci.x));
    cs += 1. / length(vec2(cp.x / (sin(ci.x + tt) / .005), cp.y / (cos(ci.y + tt) / .005)));
  }
  cs /= 4.; cs = 1.17 - pow(cs, 1.4);
  col += vec3(.5, 1., .92) * clamp(pow(abs(cs), 8.), 0., 1.) * .3 * (1. - smoothstep(.0, .6, y));
  col += vec3(.6, 1., .95) * pow(max(0., sin(x * 2.4 + y * 1.3 + fbm(vec2(x, t * .03)) * 2.)), 18.) * (1. - y) * .16;   // light shafts
  float reef = .74 + .05 * fbm(vec2(x * 1.6, 2.)) - .02 * sin(x * 1.1);
  for (int i = 0; i < 12; i++) {                              // kelp
    float fi = float(i), kx = fract(fi * .618 + .1) * A;
    float kh = .2 + .22 * hash1(fi * 3.1);
    float sway = .03 * sin(y * 6. - t * .7 + fi) * clamp((reef - y) / kh, 0., 1.);
    float strand = smoothstep(.011, .005, abs(x - kx - sway)) * step(reef - kh, y) * step(y, reef + .02);
    col = mix(col, mix(vec3(.12, .42, .2), vec3(.32, .6, .24), hash1(fi)), strand * .9);
  }
  // Corals, one per cell: brain coral, staghorn or sea fan.
  float cell = floor(x * 2.2 + .3), cx = (fract(x * 2.2 + .3) - .5) / 2.2;
  float kind = hash1(cell * 1.7), base = reef + .01;
  vec3 cc = .55 + .45 * cos(6.28 * (hash1(cell) * .55 + vec3(.95, .2, .45)));
  float cm = 0.; vec3 tex = cc;
  if (kind < .4) {
    vec2 q = vec2(cx, y - base); float ang = atan(q.y, q.x);
    float r = .055 + .035 * hash1(cell * 5.) + .006 * sin(ang * 11.) + .01 * fbm(vec2(x * 15., y * 15.));
    cm = smoothstep(.003, -.003, length(q * vec2(1., 1.25)) - r) * step(y, base + .01);
    tex = cc * (.65 + .45 * smoothstep(.3, .7, sin(fbm(vec2(x, y) * 30.) * 22.)));
  } else if (kind < .75) {
    for (int k = 0; k < 5; k++) {
      float fk = float(k), ax = (fk - 2.) * .022 + .01 * sin(fk * 3. + cell);
      float ah = .06 + .07 * hash1(cell * 3. + fk), lean = (fk - 2.) * .25;
      float px2 = cx - ax - lean * (base - y);
      float arm = smoothstep(.009, .004, abs(px2)) * step(base - ah, y) * step(y, base);
      float tip = smoothstep(.011, .005, length(vec2(px2, y - (base - ah))));
      cm = max(cm, max(arm, tip));
    }
    tex = mix(cc, cc * 1.25 + .1, smoothstep(.0, .1, base - y));
  } else {
    vec2 q = vec2(cx, y - (base - .07));
    float fan = smoothstep(.003, -.003, length(q * vec2(1., 1.1)) - .075) * step(q.y, .02);
    float lace = max(smoothstep(.5, .9, fract(atan(q.x, -q.y) * 9. + 2.)), smoothstep(.4, .9, fract(length(q) * 70.)));
    cm = max(fan * (.35 + .5 * lace), smoothstep(.004, .0, abs(cx)) * step(base - .07, y) * step(y, base));
    tex = mix(cc, vec3(.85, .25, .55), .4);
  }
  col = mix(col, tex, clamp(cm, 0., 1.));
  col = mix(col, mix(vec3(.55, .44, .32), vec3(.28, .22, .18), fbm(vec2(x * 8., y * 8.))), smoothstep(reef + .02, reef + .05, y));   // sand
  for (int i = 0; i < 10; i++) {                              // fish
    float fi = float(i), dir = hash1(fi * 7.) > .5 ? 1. : -1., sp = .025 + .03 * hash1(fi * 2.);
    float fx = mod(hash1(fi) * (A + .4) + dir * t * sp, A + .4) - .2;
    float fy = .3 + .4 * hash1(fi * 5.) + .02 * sin(t * .5 + fi * 3.);
    vec2 q = vec2((x - fx) * dir, y - fy);
    float sz = .028 + .016 * hash1(fi * 9.);
    float body = smoothstep(1., .85, length(q / vec2(sz, sz * .45)));
    vec2 tq = q + vec2(sz * 1.05, 0.); float wig = .3 * sin(t * 5. + fi);
    float tail = step(-sz * .55, tq.x) * step(tq.x, 0.) * step(abs(tq.y + wig * tq.x), -tq.x * .9);
    float fin = step(abs(q.x), sz * .3) * step(q.y, -sz * .3) * step(-sz * .7 + abs(q.x) * .8, q.y);
    vec3 fc = .5 + .5 * cos(6.28 * (hash1(fi * 11.) + vec3(.0, .33, .67)));
    fc = mix(fc, vec3(1.), step(.5, fract(q.x / sz * 2.)) * .35 * step(.5, hash1(fi * 13.)));
    col = mix(col, fc, max(max(body, tail), fin * .8) * .95);
    col = mix(col, vec3(0.), smoothstep(sz * .1, sz * .05, length(q - vec2(sz * .55, sz * .08))));
  }
  for (int i = 0; i < 8; i++) {                               // bubbles
    float fi = float(i), bx = hash1(fi * 3.3) * A + .03 * sin(t + fi);
    float by = 1. - fract(t * (.04 + .03 * hash1(fi)) + hash1(fi * 8.));
    float r = .006 + .006 * hash1(fi * 4.);
    col += vec3(.7, 1., 1.) * smoothstep(r, r * .7, abs(length(vec2(x - bx, y - by)) - r * .6)) * .35;
  }
  col *= .8 + .2 * (1. - smoothstep(.85, 1., y));
`),
};
