'use strict';
// 3D scene themes: each is a raymarched world (GLSL ES 1.0) drawn full screen behind
// the console. The waveform band is see-through, so each scene puts its skyline, peaks
// or landmark at the horizon, which sits in the band; the panels show the foreground.
//   p    : screen point, y up, -.5..+.5 over the screen height
//   view : a camera ray with the horizon at p.y = HZ
//   t    : time at the master deck's tempo (1 unit = 1 s at 120 BPM)
//   beat : the master deck's beat phase 0..1 (0 = on the beat)

const WORLD_COMMON = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 res; uniform float t; uniform float beat;
const float HZ = .21;
const mat2 M2 = mat2(.8, -.6, .6, .8);
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hash3(vec3 p){ p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), u.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), u.x), u.y); }
float noise3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1., 0., 0.)), f.x), mix(hash3(i + vec3(0., 1., 0.)), hash3(i + vec3(1., 1., 0.)), f.x), f.y),
             mix(mix(hash3(i + vec3(0., 0., 1.)), hash3(i + vec3(1., 0., 1.)), f.x), mix(hash3(i + vec3(0., 1., 1.)), hash3(i + vec3(1., 1., 1.)), f.x), f.y), f.z); }
float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = M2 * p * 2.02; a *= .5; } return v; }
float fbm3(vec3 p){ float v = 0., a = .5; for (int i = 0; i < 6; i++) { v += a * noise3(p); p = p * 2.02 + vec3(1.3, -2.1, .7); a *= .5; } return v; }
float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.); }
float sdCyl(vec2 radial, float axial, float r, float h){ vec2 d = abs(vec2(length(radial), axial)) - vec2(r, h); return min(max(d.x, d.y), 0.) + length(max(d, 0.)); }
float aaFade(float d, float size){ return smoothstep(.25, .6, d / res.y / size); }
vec3 view(vec2 p, float fl){ return normalize(vec3(p.x, p.y - HZ, fl)); }
vec3 tonemap(vec3 c){ c = c * (2.51 * c + .03) / (c * (2.43 * c + .59) + .14); return pow(clamp(c, 0., 1.), vec3(.4545)); }
float stars(vec3 rd, float scale){ vec2 q = vec2(atan(rd.z, rd.x), rd.y) * scale; vec2 id = floor(q), f = fract(q) - .5;
  float h = hash(id); return step(.93, h) * smoothstep(.09, 0., length(f + (vec2(hash(id + 3.), hash(id + 7.)) - .5) * .6)) * (.6 + .4 * sin(t * 2. + h * 40.)); }
`;

const WORLD = (funcs, body) => `${WORLD_COMMON}
${funcs}
void main(){
  vec2 p = (gl_FragCoord.xy - .5 * res) / res.y;
  vec3 col = vec3(0.);
${body}
  col = tonemap(col);
  col += (hash(gl_FragCoord.xy) - .5) / 160.;
  gl_FragColor = vec4(col, 1.);
}`;

// Ridged multifractal noise (sharp crests), as height-field building blocks.
const ridged = (name, oct) => `float ${name}(vec2 q){ float s = 0., a = .5, w = 1.;
  for (int i = 0; i < ${oct}; i++) { float n = 1. - abs(noise(q) * 2. - 1.); n *= n; s += a * n * w; w = clamp(n * 1.6, 0., 1.); q = M2 * q * 2.05; a *= .5; } return s; }`;

// March, normal, soft shadow and occlusion for a distance function `map`.
const sdfKit = (map, steps, shadowSteps = 28, graze = true) => `
float march_${map}(vec3 ro, vec3 rd, float tmax){ float d = .05, h = 1.;
  for (int i = 0; i < ${steps}; i++) { h = ${map}(ro + rd * d); if (abs(h) < .0012 * d) return d; d += h; if (d > tmax) return 1e5; }
  return ${graze ? 'h < .01 * d ? d : 1e5' : '1e5'}; }
vec3 normal_${map}(vec3 q, float e){ vec2 k = vec2(1., -1.);
  return normalize(k.xyy * ${map}(q + k.xyy * e) + k.yyx * ${map}(q + k.yyx * e) + k.yxy * ${map}(q + k.yxy * e) + k.xxx * ${map}(q + k.xxx * e)); }
float shadow_${map}(vec3 ro, vec3 rd, float tmax){ float r = 1., d = .06;
  for (int i = 0; i < ${shadowSteps}; i++) { float h = ${map}(ro + rd * d); r = min(r, 8. * h / d); d += clamp(h, .06, 1.2); if (r < .002 || d > tmax) break; } return clamp(r, 0., 1.); }
float ao_${map}(vec3 q, vec3 n){ float o = 0., s = 1.; for (int i = 1; i <= 4; i++) { float h = .15 * float(i); o += (h - ${map}(q + n * h)) * s; s *= .6; } return clamp(1. - 1.2 * o, 0., 1.); }`;

const WORLDS = {
  // Switzerland: a ridged massif with a Matterhorn-like horn over an alpine lake, snow
  // by slope and height, soft shadows, aerial haze and drifting cloud.
  alps: WORLD(`
const vec3 SUN = vec3(.737, .521, -.430);
${ridged('rLo', 5)}
${ridged('rHi', 9)}
float alpsH(vec2 x, float r){
  float far = smoothstep(7., 26., x.y);
  float horn = exp(-pow(length((x - vec2(6., 40.)) * vec2(1., .8)) * .13, 1.6));
  float h = r * (.4 + 3.3 * far) + horn * (3.6 + 1.4 * r);
  float lake = smoothstep(7., 1.5, length((x - vec2(-.6, 8.5)) * vec2(.3, .75)));
  return h + .12 - 1.1 * lake;
}
float mapA(vec3 q){ return (q.y - alpsH(q.xz, rLo(q.xz * .14))) * .55; }
${sdfKit('mapA', 130)}
vec3 sky(vec3 rd, vec3 ro){
  float y = max(rd.y, 0.);
  vec3 c = mix(vec3(.74, .83, .93), vec3(.2, .4, .78), pow(y, .55));
  c += vec3(1., .9, .75) * pow(max(dot(rd, SUN), 0.), 6.) * .25;
  if (rd.y > 0.) {
    vec2 q = ro.xz + rd.xz * (16. - ro.y) / rd.y;
    float cl = fbm(q * .045 + vec2(t * .012, 0.)) + .4 * fbm(q * .16 - vec2(t * .02, 0.));
    c = mix(c, vec3(1.02, 1.02, 1.04), smoothstep(.72, 1.05, cl) * smoothstep(0., .12, rd.y) * .85);
  }
  return c;
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec2 e = vec2(.004 + .0015 * d, 0.);
  float h0 = alpsH(q.xz, rHi(q.xz * .14));
  vec3 n = normalize(vec3(alpsH(q.xz - e.xy, rHi((q.xz - e.xy) * .14)) - alpsH(q.xz + e.xy, rHi((q.xz + e.xy) * .14)), 2. * e.x,
                          alpsH(q.xz - e.yx, rHi((q.xz - e.yx) * .14)) - alpsH(q.xz + e.yx, rHi((q.xz + e.yx) * .14))));
  float dirt = fbm(q.xz * 1.7 + q.y);
  vec3 m = mix(vec3(.22, .2, .19), vec3(.42, .39, .36), dirt);
  m = mix(m, mix(vec3(.13, .26, .06), vec3(.3, .4, .12), fbm(q.xz * .7)), smoothstep(.72, .88, n.y) * smoothstep(1.8, .9, h0));
  float snow = smoothstep(.42, .7, n.y + (h0 - 1.9) * .3 + (dirt - .5) * .5) * smoothstep(1., 1.8, h0);
  m = mix(m, vec3(.95, .97, 1.), snow);
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapA(q + n * .03, SUN, 25.) : 0.;
  vec3 lin = dif * sh * vec3(1.9, 1.75, 1.5) + (.55 + .45 * n.y) * vec3(.26, .34, .5) + max(dot(n, normalize(-SUN * vec3(1., 0., 1.))), 0.) * vec3(.07, .06, .05);
  vec3 c = m * lin;
  return mix(c, vec3(.6, .72, .9), 1. - exp(-d * .014));
}`, `
  vec3 ro = vec3(1.4 * sin(t * .01), 1.45, 0.);
  vec3 rd = view(p, 1.5);
  float dT = march_mapA(ro, rd, 80.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  if (dW < dT && dW < 80.) {
    vec3 q = ro + rd * dW;
    vec2 w = vec2(noise(q.xz * vec2(5., 1.6) + vec2(0., t * .2)), noise(q.xz * vec2(3., 1.2) - vec2(t * .12, 0.))) - .5;
    vec3 n = normalize(vec3(w.x * .05, 1., w.y * .1));
    vec3 rr = reflect(rd, n);
    float dR = march_mapA(q + vec3(0., .02, 0.), rr, 80.);
    vec3 rc = dR < 80. ? shade(q + rr * dR, rr, dR + dW) : sky(rr, q);
    float fr = .03 + .97 * pow(1. - max(dot(n, -rd), 0.), 5.);
    col = mix(vec3(.02, .09, .1), rc, .55 + .45 * fr);
    col = mix(col, vec3(.6, .72, .9), 1. - exp(-dW * .014));
  } else if (dT < 80.) col = shade(ro + rd * dT, rd, dT);
  else col = sky(rd, ro);
`),

  // Hakone: a vermilion torii standing in Lake Ashi at dusk, forested shores, Fuji with
  // its snow cap in alpenglow, the Belt of Venus over the lake, mirror reflections.
  hakone: WORLD(`
const vec3 SUN = vec3(-.48, .16, -.86);
float land(vec2 x){
  float r = length(x - vec2(-5., 56.));
  float fuji = min(5.6 * pow(clamp(1. - r / 19., 0., 1.), 2.1), 4.9);
  fuji *= 1. + .05 * (noise(vec2(atan(x.y - 56., x.x + 5.) * 9., r * .4)) - .5);
  float ridge = fbm(x * .085);
  float side = smoothstep(4.5, 12., abs(x.x - 1. + 2.5 * sin(x.y * .07)));
  float hills = (ridge * 3.8 - 1.) * side;
  float far = smoothstep(24., 32., x.y) * smoothstep(48., 36., x.y) * (ridge * 2.6 - .4);
  float l = max(hills, far);
  l += .14 * noise(x * 2.6) * smoothstep(-.1, .3, l);
  return max(l, fuji);
}
float torii(vec3 p, out float black){
  p -= vec3(3.6, 0., 14.); p.xz = rot(-.35) * p.xz;
  vec3 q = p; q.x = abs(q.x) - .82;
  float pil = sdCyl(q.xz, q.y - 1.1, .1 - .012 * q.y, 1.25);
  float nuki = sdBox(p - vec3(0., 1.86, 0.), vec3(1.16, .055, .04));
  vec3 k = p - vec3(0., 2.4, 0.); k.y -= .045 * k.x * k.x;
  float kasa = sdBox(k, vec3(1.5, .07, .11)) - .01;
  float shim = sdBox(k + vec3(0., .14, 0.), vec3(1.34, .06, .085));
  float gaku = sdBox(p - vec3(0., 2.1, 0.), vec3(.07, .2, .035));
  float red = min(min(pil, nuki), min(shim, gaku));
  black = kasa < red ? 1. : 0.;
  return min(red, kasa);
}
float mapH(vec3 q){ float b; return min(torii(q, b), (q.y - land(q.xz)) * .5); }
${sdfKit('mapH', 150)}
vec3 sky(vec3 rd){
  float y = rd.y;
  vec3 c = mix(vec3(.5, .52, .74), vec3(.17, .22, .46), smoothstep(.0, .45, y));
  c = mix(c, vec3(1.05, .66, .66), exp(-pow((y - .07) * 13., 2.)) * .8);
  c = mix(c, vec3(.42, .45, .66), smoothstep(.03, .0, y) * .6);
  if (y > 0.) {
    vec2 q = rd.xz / (y + .05);
    float cl = fbm(q * .7 + vec2(t * .01, 0.));
    c = mix(c, vec3(1.15, .72, .6), smoothstep(.6, .85, cl) * smoothstep(.02, .1, y) * .6);
  }
  return c;
}
vec3 shade(vec3 q, vec3 rd, float d){
  float black; float dt = torii(q, black);
  vec3 n = normal_mapH(q, .002 + .001 * d);
  vec3 m;
  if (dt < .02) m = black > .5 ? vec3(.025) : vec3(.75, .1, .04);
  else {
    m = mix(vec3(.035, .07, .035), vec3(.08, .13, .05), noise(q.xz * 3.));
    float r = length(q.xz - vec2(-5., 56.));
    float snow = smoothstep(2.9, 3.4, q.y + (noise(vec2(atan(q.z - 56., q.x + 5.) * 14., r)) - .5) * 1.6);
    m = mix(m, vec3(.3, .3, .34), smoothstep(2.2, 2.8, q.y));
    m = mix(m, vec3(.95, .93, 1.), snow);
  }
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapH(q + n * .02, SUN, 20.) : 0.;
  vec3 lin = dif * sh * vec3(2.1, 1.25, .95) + (.5 + .5 * n.y) * vec3(.24, .25, .42);
  vec3 c = m * lin * ao_mapH(q, n);
  c += (dt < .02 && black < .5) ? vec3(.12, .02, 0.) : vec3(0.);
  return mix(c, vec3(.62, .52, .62), 1. - exp(-d * .011));
}`, `
  vec3 ro = vec3(.4 * sin(t * .01), .85, 0.);
  vec3 rd = view(p, 1.5);
  float dT = march_mapH(ro, rd, 95.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  if (dW < dT && dW < 95.) {
    vec3 q = ro + rd * dW;
    vec2 w = vec2(noise(q.xz * vec2(7., 2.) + vec2(0., t * .25)), noise(q.xz * vec2(4., 1.5) - vec2(t * .15, 0.))) - .5;
    vec3 n = normalize(vec3(w.x * .03, 1., w.y * .06));
    vec3 rr = reflect(rd, n);
    float dR = march_mapH(q + vec3(0., .01, 0.), rr, 95.);
    vec3 rc = dR < 95. ? shade(q + rr * dR, rr, dR + dW) : sky(rr);
    col = mix(vec3(.03, .04, .08), rc, .78);
    col = mix(col, vec3(.62, .52, .62), 1. - exp(-dW * .011));
  } else if (dT < 95.) col = shade(ro + rd * dT, rd, dT);
  else col = sky(rd);
`),

  // Wulong: limestone karst towers rising out of a misty gorge with green ledges and
  // water streaks, a natural stone bridge, and morning mist drifting through.
  wulong: WORLD(`
const vec3 SUN = vec3(-.62, .5, -.6);
float pillar(vec3 p){
  vec2 id = floor(p.xz / 4.); vec3 q = p; q.xz = mod(p.xz, 4.) - 2.;
  float edge = 2. - max(abs(q.x), abs(q.z));
  float h = hash(id);
  bool open = h < .2 || (abs(id.x + .5) < 1. && id.y < 2.) || (abs(id.x * 4. + 2. - 1.) < 7. && abs(id.y * 4. + 2. - 30.) < 4.);
  if (open || id.y < 2.) return max(edge + .4, p.y - 9.);
  q.xz -= (vec2(hash(id + 3.), hash(id + 5.)) - .5) * .8;
  float R = .7 + .4 * hash(id + 9.);
  float H = 2. + 6.5 * hash(id + 13.) * smoothstep(1., 5., id.y);
  float a = atan(q.z, q.x);
  float r = R * (1. + .16 * (noise(vec2(a * 2.5 + h * 10., q.y * .6)) - .5) + .07 * (noise(vec2(a * 8., q.y * 2.5)) - .5));
  r *= 1. - .3 * smoothstep(H - 1.2, H + .3, q.y);
  float d = max(length(q.xz) - r, q.y - H - .2 * noise(q.xz * 3.)) * .7;
  return min(d, max(edge + .4, p.y - 9.));
}
float arch(vec3 p){
  vec3 a = p - vec3(1., 0., 30.);
  float b = sdBox(a - vec3(0., 5., 0.), vec3(6.5, 2.4, 1.8)) - .3 * noise(a.xy * 1.5);
  return max(b, -(length(a.xy - vec2(0., 1.)) - 4.6));
}
float ground(vec3 p){ return p.y - (.5 * fbm(p.xz * .2) - .25); }
float mapW(vec3 p){ return min(min(pillar(p), arch(p)), ground(p)); }
${sdfKit('mapW', 130)}
vec3 sky(vec3 rd){
  vec3 c = mix(vec3(.82, .84, .82), vec3(.45, .6, .74), smoothstep(0., .5, rd.y));
  return c + vec3(1., .85, .6) * pow(max(dot(rd, SUN), 0.), 8.) * .3;
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapW(q, .003 + .001 * d);
  vec3 m;
  if (ground(q) < .02) m = q.y < .02 ? vec3(.06, .1, .09) : mix(vec3(.05, .1, .04), vec3(.12, .18, .06), fbm(q.xz));
  else {
    float a = atan(q.z, q.x);
    m = mix(vec3(.55, .52, .45), vec3(.68, .64, .55), fbm(q.xz * 2. + q.y));
    m *= .65 + .35 * smoothstep(.2, .6, noise(vec2((q.x + q.z) * 5., q.y * .25)));
    float veg = smoothstep(.45, .75, n.y + (fbm(q.xz * 2. + q.y * .7) - .5) * .9);
    veg = max(veg, smoothstep(.62, .72, fbm(vec2(q.x * 1.3 + q.z * 1.7, q.y * 1.3))));
    m = mix(m, mix(vec3(.08, .17, .05), vec3(.2, .3, .08), noise(q.xz * 4. + q.y)), veg);
  }
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapW(q + n * .03, SUN, 20.) : 0.;
  vec3 lin = dif * sh * vec3(1.8, 1.6, 1.3) + (.55 + .45 * n.y) * vec3(.32, .38, .44);
  return m * lin * ao_mapW(q, n);
}`, `
  vec3 ro = vec3(.8 * sin(t * .012), 2.6, 0.);
  vec3 rd = view(p, 1.45);
  float d = march_mapW(ro, rd, 70.);
  col = d < 70. ? shade(ro + rd * d, rd, d) : sky(rd);
  float dd = min(d, 70.);
  vec3 q = ro + rd * dd;
  // Haze with distance, and a mist layer pooled in the gorge that drifts.
  col = mix(col, vec3(.78, .82, .82), 1. - exp(-dd * .016));
  float mist = 0.;
  for (int i = 0; i < 6; i++) {
    float h = .6 + float(i) * .55;
    float s = (h - ro.y) / rd.y;
    if (s > 0. && s < dd) { vec2 m = (ro + rd * s).xz; mist += smoothstep(.5, .9, fbm(m * .12 + vec2(t * .015 + float(i), 0.))) * .16; }
  }
  col = mix(col, vec3(.9, .92, .92), clamp(mist, 0., .85));
`),

  // Rainforest: a river winding through a valley of tree crowns, each crown its own
  // green (a few in bloom), mist banks, haze, and macaws crossing the sky.
  rainforest: WORLD(`
const vec3 SUN = vec3(-.55, .55, .63);
vec3 crownCol;
float valley(vec2 x){ float rv = x.x - 2.8 * sin(x.y * .1) - 1.; return smoothstep(1.1, 6., abs(rv)); }
float crowns(vec2 x){
  vec2 i = floor(x), f = fract(x); float h = 0.;
  for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
    vec2 g = vec2(float(k), float(j)), c = i + g;
    vec2 d = g + vec2(hash(c), hash(c + 7.)) * .8 - f;
    float r = .5 + .3 * hash(c + 3.);
    float dome = sqrt(max(r * r - dot(d, d), 0.)) * (.8 + .7 * hash(c + 11.));
    if (dome > h) { h = dome; crownCol = vec3(hash(c + 17.), hash(c + 23.), hash(c + 29.)); }
  }
  return h;
}
float rfH(vec2 x){
  float v = valley(x);
  float g = v * (1.2 + 3.4 * fbm(x * .06)) - .25 + smoothstep(30., 55., x.y) * 7. * fbm(x * .04 + 3.);
  return g + crowns(x * 1.1) * .6 * smoothstep(-.15, .3, g);
}
float mapR(vec3 q){ return (q.y - rfH(q.xz)) * .5; }
${sdfKit('mapR', 120, 0)}
vec3 sky(vec3 rd){
  vec3 c = mix(vec3(.86, .9, .88), vec3(.42, .6, .74), smoothstep(0., .45, rd.y));
  return c + vec3(1., .92, .7) * (pow(max(dot(rd, SUN), 0.), 5.) * .35 + pow(max(dot(rd, SUN), 0.), 200.) * 2.);
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapR(q, .004 + .0015 * d);
  crowns(q.xz * 1.1);
  vec3 cc = crownCol;
  vec3 m = mix(vec3(.04, .15, .04), vec3(.1, .26, .05), cc.x);
  m = mix(m, vec3(.25, .36, .07), step(.8, cc.y));
  m = mix(m, cc.z > .5 ? vec3(.85, .62, .1) : vec3(.75, .3, .45), step(.965, cc.y));
  m *= .75 + .5 * noise(q.xz * 9.);
  float dif = max(dot(n, SUN), 0.);
  vec3 lin = dif * vec3(1.8, 1.65, 1.35) + (.45 + .55 * n.y) * vec3(.3, .38, .38) + pow(1. - max(dot(n, -rd), 0.), 3.) * vec3(.2, .25, .1);
  return m * lin * ao_mapR(q, n);
}`, `
  vec3 ro = vec3(1. + 1.2 * sin(t * .01), 6.5, -4.);
  vec3 rd = view(p, 1.5);
  rd.yz = rot(-.1) * rd.yz;
  float d = march_mapR(ro, rd, 70.);
  float dW = rd.y < 0. ? (.05 - ro.y) / rd.y : 1e5;
  if (dW < d && dW < 70.) {
    vec3 q = ro + rd * dW;
    vec3 n = normalize(vec3((noise(q.xz * 4. + t * .3) - .5) * .08, 1., 0.));
    col = mix(vec3(.08, .12, .08), sky(reflect(rd, n)) * vec3(.85, .9, .8), .6);
    d = dW;
  } else col = d < 70. ? shade(ro + rd * d, rd, d) : sky(rd);
  float dd = min(d, 70.);
  col = mix(col, vec3(.78, .84, .82), 1. - exp(-dd * .018));
  float mist = 0.;
  for (int i = 0; i < 5; i++) {
    float h = .5 + float(i) * .45, s = (h - ro.y) / rd.y;
    if (s > 0. && s < dd) { vec2 m = (ro + rd * s).xz; mist += smoothstep(.5, .9, fbm(m * .15 + vec2(t * .02 - float(i), 0.))) * (1. - valley(m)) * .35; }
  }
  col = mix(col, vec3(.92, .95, .93), clamp(mist, 0., .8));
  for (int i = 0; i < 4; i++) {                     // macaws
    float fi = float(i), sp = .02 + .01 * fract(fi * .37);
    vec2 c = vec2(mod(t * sp + fi * .53, 2.6) - 1.3, .36 + .07 * sin(fi * 3.1 + t * .05));
    vec2 b = (p - c) * 150.; float flap = sin(t * 9. + fi * 2.) * .6;
    float wing = abs(b.y - abs(b.x) * flap) - .25 + .1 * abs(b.x);
    float bird = smoothstep(.15, 0., max(wing, abs(b.x) - 2.2));
    col = mix(col, fi < 2. ? vec3(.65, .08, .05) : vec3(.08, .2, .5), bird);
  }
`),

  // ISS: the station's truss, modules and solar wings in orbit above Earth, whose day
  // side turns slowly under clouds with sun glint, the night side lit by cities, a thin
  // blue atmosphere at the limb and the sun rising over it.
  space: WORLD(`
const vec3 SUN = vec3(.82, .36, .44);
const vec3 EC = vec3(0., -7.6, 11.);
const float ER = 8.4;
const vec3 IP = vec3(1.5, .5, 6.);
vec3 issCol;
float iss(vec3 p){
  p -= IP; p.xz = rot(.5 + t * .008) * p.xz; p.xy = rot(.12) * p.xy;
  float truss = sdBox(p, vec3(1.15, .035, .035));
  vec3 q = p; q.x = abs(q.x);
  vec3 w = q - vec3(.86, 0., 0.); w.x = abs(w.x) - .14; w.y = abs(w.y) - .42;
  float wings = sdBox(w, vec3(.055, .33, .004));
  float mods = min(sdCyl(p.xy, p.z - .1, .065, .38), sdCyl(p.zy - vec2(.18, 0.), p.x, .055, .2));
  vec3 r = q - vec3(.36, -.15, 0.); float rad = sdBox(r, vec3(.1, .13, .004));
  float d = min(min(truss, mods), rad);
  issCol = wings < d ? vec3(1., 0., 0.) : vec3(0., 1., 0.);
  return min(d, wings);
}
${sdfKit('iss', 60, 0)}
vec3 earth(vec3 ro, vec3 rd, float s){
  vec3 pos = ro + rd * s, n = normalize(pos - EC);
  vec3 nn = n; nn.xz = rot(t * .004) * nn.xz;
  float land = smoothstep(.52, .55, fbm3(nn * 2.4));
  float dif = dot(n, SUN), day = smoothstep(-.12, .25, dif);
  vec3 g = mix(vec3(.1, .2, .06), vec3(.42, .34, .2), smoothstep(.4, .7, fbm3(nn * 7.)));
  g = mix(g, vec3(.9, .93, .95), smoothstep(.78, .86, abs(nn.y)));
  vec3 surf = mix(vec3(.01, .05, .15), g, land);
  vec3 cn = n; cn.xz = rot(t * .006) * cn.xz;
  float cl = smoothstep(.5, .78, fbm3(cn * 3.5 + vec3(fbm3(cn * 2.) * 1.5)));
  vec3 c = surf * max(dif, 0.) * 1.6;
  c += (1. - land) * pow(max(dot(reflect(rd, n), SUN), 0.), 40.) * vec3(1., .9, .7) * 1.4 * day;
  c = mix(c, vec3(1.) * (max(dif, 0.) * 1.5 + .02), cl);
  c += (1. - day) * land * (1. - cl) * pow(noise3(nn * 90.) * noise3(nn * 30.), 3.) * vec3(1., .65, .3) * 6.;
  float fres = pow(1. - max(dot(n, -rd), 0.), 3.);
  c += vec3(.25, .5, 1.) * fres * (smoothstep(-.3, .4, dif)) * 1.2;
  return c;
}`, `
  vec3 ro = vec3(0.);
  vec3 rd = view(p, 1.4);
  col = vec3(.004, .006, .015) + vec3(.9, .95, 1.) * stars(rd, 140.);
  vec3 oc = ro - EC; float b = dot(oc, rd), c = dot(oc, oc) - ER * ER, h = b * b - c;
  float dmin = sqrt(max(dot(oc, oc) - b * b, 0.));
  vec3 cp = normalize(ro + rd * max(-b, 0.) - EC);
  float lit = smoothstep(-.4, .5, dot(cp, SUN));
  if (h > 0. && -b - sqrt(h) > 0.) col = earth(ro, rd, -b - sqrt(h));
  else col += vec3(.3, .6, 1.) * exp(-(dmin - ER) * 14.) * lit * 1.4 + vec3(.15, .3, .8) * exp(-(dmin - ER) * 3.) * lit * .3;
  float sd = max(dot(rd, SUN), 0.);
  col += vec3(1., .9, .75) * (pow(sd, 3000.) * 30. + pow(sd, 60.) * .5 + pow(sd, 8.) * .08);
  // the station, lit by the sun and blue earthshine
  vec3 oi = ro - IP; float bi = dot(oi, rd), hi = bi * bi - dot(oi, oi) + 1.7;
  if (hi > 0.) {
    float d = march_iss(ro, rd, 9.);
    if (d < 9.) {
      vec3 q = ro + rd * d, n = normal_iss(q, .001);
      iss(q);
      float dif = max(dot(n, SUN), 0.);
      vec3 m = issCol.x > .5 ? mix(vec3(.25, .14, .04), vec3(.03, .04, .12), step(.5, fract((q.y + q.x) * 40.))) : vec3(.7, .7, .68);
      vec3 hl = normalize(SUN - rd);
      col = m * (dif * 2.2 + max(-n.y, 0.) * vec3(.15, .25, .5) + .03) + pow(max(dot(n, hl), 0.), 60.) * (issCol.x > .5 ? 1.5 : .6);
    }
  }
`),

  // Chongqing: a hillside of towers across the river at night, window grids and LED
  // facades pulsing with the beat, Hongyadong's golden terraces on the bank, a lit
  // bridge, and the river streaking every light.
  chongqing: WORLD(`
float terr(vec2 x){ return x.y < 11.5 ? -1. : smoothstep(11.5, 26., x.y) * 2.3 + 1.1 * fbm(x * .12) * smoothstep(11.5, 15., x.y) - .3; }
float towers(vec3 p){
  vec2 id = floor(p.xz / 1.4); vec3 q = p; q.xz = mod(p.xz, 1.4) - .7;
  float edge = .7 - max(abs(q.x), abs(q.z)) + .12;
  vec2 c = (id + .5) * 1.4;
  float skip = max(max(edge, 12.4 - p.z), p.y - 6.5);
  if (c.y < 13. || hash(id) < .12) return max(skip, .05);
  float base = terr(c);
  float cl = exp(-pow((c.x - 1.5) / 7., 2.)) * smoothstep(13., 18., c.y);
  float H = .5 + pow(hash(id + 2.), 2.) * (1. + 4.2 * cl);
  vec3 hs = vec3(.3 + .25 * hash(id + 4.), H * .5, .3 + .25 * hash(id + 6.));
  if (c.y < 15. && c.x > -6. && c.x < -2.) hs = vec3(.55, .3 + .25 * hash(id + 2.), .5);
  return min(sdBox(q - vec3(0., base + hs.y, 0.), hs), max(skip, .05));
}
float bridge(vec3 p){
  vec3 b = p - vec3(6., .7, 8.); b.xz = rot(.95) * b.xz;
  float deck = sdBox(b, vec3(9., .04, .12));
  vec3 py = b; py.x = abs(py.x) - 3.;
  return min(deck, sdBox(py - vec3(0., .7, 0.), vec3(.05, .7, .05)));
}
float mapC(vec3 p){ return min(min(towers(p), bridge(p)), p.y - terr(p.xz)); }
${sdfKit('mapC', 200, 0, false)}
vec3 sky(vec3 rd){ return mix(vec3(.16, .07, .2), vec3(.01, .015, .045), smoothstep(0., .3, rd.y)); }
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapC(q, .002 + .001 * d);
  vec3 c = vec3(.012, .012, .02) * (.6 + .4 * n.y);
  if (bridge(q) < .02) {
    vec3 b = q - vec3(6., .7, 8.); b.xz = rot(.95) * b.xz;
    float dots = smoothstep(.3, .0, abs(fract(b.x * 3.) - .5)) * step(.02, abs(b.y));
    float cars = smoothstep(.06, 0., abs(fract(b.x * .15 - t * .12) - .5)) + smoothstep(.06, 0., abs(fract(b.x * .2 + t * .1 + .3) - .5));
    return c + vec3(1., .75, .35) * dots * 1.2 + vec3(1., .3, .2) * cars * 2.;
  }
  if (q.y - terr(q.xz) < .03) return c + vec3(.03, .02, .03);
  vec3 qi = q - n * .02;
  vec2 id = floor(qi.xz / 1.4), cc = (id + .5) * 1.4;
  float hb = hash(id + 8.);
  float u = abs(n.x) > .5 ? q.z : q.x;
  vec2 g = vec2(u / .07, q.y / .085);
  float win = step(.25, fract(g.x)) * step(.3, fract(g.y)) * step(.5, abs(n.x) + abs(n.z));
  float lit = step(.5, hash(floor(g) + id * 7.31));
  vec3 wc = hb < .5 ? vec3(1., .78, .45) : vec3(.75, .85, 1.);
  c += wc * mix(win * lit, .3, aaFade(d, .07)) * 1.1;
  if (cc.y < 15. && cc.x > -6. && cc.x < -2.) {        // Hongyadong
    float eave = smoothstep(.04, 0., abs(fract(q.y / .22) - .5) - .42);
    float lan = smoothstep(.35, .0, length(vec2(fract(u * 4.) - .5, (fract(q.y / .22) - .5) * 1.5)));
    c = vec3(.025, .012, .01) + vec3(1.3, .55, .15) * (eave * 1.2 + mix(lan, .25, aaFade(d, .2)) * 1.4);
  } else if (hb > .8) {                                  // LED facades on the beat
    vec3 led = .5 + .5 * cos(6.28 * (q.y * .25 - t * .08 + hb * 3. + vec3(0., .33, .67)));
    float stripe = step(.6, fract(q.y * 6. - t * .5));
    c += led * (.4 + 1.6 * stripe) * (.55 + .9 * pow(1. - beat, 4.)) * step(.5, abs(n.x) + abs(n.z));
  }
  return c;
}`, `
  vec3 ro = vec3(.5 * sin(t * .01), 1.1, 0.);
  vec3 rd = view(p, 1.6);
  float d = march_mapC(ro, rd, 60.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  vec3 fogc = vec3(.1, .05, .12);
  if (dW < d && dW < 60.) {
    vec3 q = ro + rd * dW;
    vec3 n = normalize(vec3((noise(q.xz * vec2(2., 6.) + vec2(0., t * .4)) - .5) * .03, 1., (noise(q.xz * vec2(1.5, 9.) - vec2(t * .3, 0.)) - .5) * .25));
    vec3 rr = reflect(rd, n);
    float dR = march_mapC(q + vec3(0., .01, 0.), rr, 60.);
    vec3 rc = dR < 60. ? shade(q + rr * dR, rr, dR + dW) : sky(rr);
    col = mix(vec3(.01, .012, .02), rc, .5);
    d = dW;
  } else col = d < 60. ? shade(ro + rd * d, rd, d) : sky(rd);
  col = mix(col, fogc, 1. - exp(-min(d, 60.) * .045));
  col += vec3(.25, .1, .2) * exp(-abs(rd.y - .02) * 18.) * .25;
`),

  // Times Square: a canyon of towers covered in screens, each running its own beat-
  // synced content, storefronts, yellow cabs, and a wet street that mirrors it all.
  timessquare: WORLD(`
float cell(float z, float side){ return floor(z / 6.) + side * 37.; }
float bld(vec3 p){
  float side = sign(p.x); vec3 q = p; q.x = abs(q.x);
  float id = cell(q.z, side), lz = mod(q.z, 6.) - 3.;
  float fx = 4.6 + 1.1 * hash(vec2(id, 1.));
  float H = 16. + 26. * hash(vec2(id, 2.));
  float b = sdBox(vec3(q.x - fx - 6., p.y - H * .5, lz), vec3(6., H * .5, 2.95));
  float nid = id + sign(lz), nfx = 4.6 + 1.1 * hash(vec2(nid, 1.)), nH = 16. + 26. * hash(vec2(nid, 2.));
  b = min(b, sdBox(vec3(q.x - nfx - 6., p.y - nH * .5, lz - sign(lz) * 6.), vec3(6., nH * .5, 2.95)));
  return min(b, max(4.6 - q.x, 0.) + 1.);
}
float cabs(vec3 p){
  float lane = p.x > 0. ? 2.3 : -2.3, dir = p.x > 0. ? 1. : -1.;
  float z = mod(p.z - t * 1.6 * dir + (p.x > 0. ? 0. : 7.), 17.) - 8.5;
  vec3 q = vec3(p.x - lane, p.y, z);
  return min(sdBox(q - vec3(0., .38, 0.), vec3(.42, .2, .95)) - .05, sdBox(q - vec3(0., .68, -.1), vec3(.36, .14, .5)) - .04);
}
float mapT(vec3 p){ return min(min(bld(p), cabs(p)), p.y); }
${sdfKit('mapT', 160, 0, false)}
vec3 pal(float h){ return .5 + .5 * cos(6.28 * (h + vec3(0., .33, .67))); }
vec3 screen(vec2 uv, float k, float s, float d){
  vec3 a = pal(s), b = pal(s + .4);
  float pulse = .65 + .7 * pow(1. - beat, 3.);
  if (k < .25) return mix(a, b, step(.5, fract((uv.x + uv.y) * 2.5 - t * .4))) * pulse;
  if (k < .5) { float r = length((uv - .5) * vec2(1.6, 1.)); return mix(a * .15, b * 1.3, smoothstep(.31, .29, r * (1. - .12 * pow(1. - beat, 3.)))) + a * smoothstep(.02, 0., abs(r - .4)); }
  if (k < .75) {                                   // a headline crawling across a solid panel
    vec2 g = vec2(uv.x * 40. + t * 6., (uv.y - .38) * 26.);
    float txt = step(0., g.y) * step(g.y, 6.) * step(.5, hash(floor(g) + floor(g.x / 6.))) * step(1., mod(floor(g.x), 6.));
    return mix(a * .55, vec3(1.1), txt * (1. - aaFade(d, .02))) * pulse + vec3(.2) * aaFade(d, .02); }
  return mix(a, b, smoothstep(.2, .8, fbm(uv * 2.5 + vec2(t * .08, beat * .2)))) * pulse;
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapT(q, .002 + .001 * d);
  if (cabs(q) < .02) {
    float z = q.x > 0. ? 1. : -1.;
    vec3 c = vec3(.9, .65, .05) * (.15 + .25 * n.y);
    float front = step(.9, -n.z * z * -1.);
    return c + (q.x > 0. ? vec3(1.6, .1, .05) * step(.9, -n.z) : vec3(2., 1.9, 1.6) * step(.9, -n.z)) * step(q.y, .5);
  }
  if (q.y < .01) return vec3(.02);
  float side = sign(q.x), id = cell(q.z, side), lz = mod(q.z, 6.) - 3.;
  if (abs(n.x) < .5) return vec3(.02);
  if (q.y < 2.2) return vec3(.04) + vec3(1., .8, .55) * step(.4, q.y) * step(.35, fract(lz * .7)) * .9;
  float band = floor((q.y - 2.2) / 3.4), v = fract((q.y - 2.2) / 3.4);
  float s = hash(vec2(id, band + 7.));
  if (s < .12 || q.y > 26.) {
    float w = step(.3, fract(lz * 3.)) * step(.35, fract(q.y * 2.5)) * step(.6, hash(floor(vec2(lz * 3., q.y * 2.5))));
    return vec3(.025) + vec3(1., .85, .6) * mix(w, .4, aaFade(d, .33)) * .35;
  }
  vec2 uv = vec2((lz + 2.85) / 5.7, (v - .05) / .9);
  float inside = step(0., uv.y) * step(uv.y, 1.) * step(0., uv.x) * step(uv.x, 1.);
  float bezel = inside * (1. - step(.02, uv.x) * step(uv.x, .98) * step(.03, uv.y) * step(uv.y, .97));
  return mix(vec3(.02), screen(uv, hash(vec2(id, band)), s * 7., d) * 2.2, inside) * (1. - bezel * .85);
}`, `
  vec3 ro = vec3(0., 2.4, t * .35);
  vec3 rd = view(p, 1.25);
  rd.yz = rot(-.08) * rd.yz;
  float d = march_mapT(ro, rd, 90.);
  vec3 fogc = vec3(.2, .1, .22);
  if (d < 90. && ro.y + rd.y * d < .01) {
    vec3 q = ro + rd * d;
    float wet = smoothstep(.35, .65, fbm(q.xz * .6));
    vec3 n = normalize(vec3((noise(q.xz * 3.) - .5) * .05 * (1. - wet), 1., (noise(q.xz * 3. + 5.) - .5) * .05 * (1. - wet)));
    vec3 rr = reflect(rd, n);
    float dR = march_mapT(q + vec3(0., .01, 0.), rr, 70.);
    vec3 rc = dR < 70. ? shade(q + rr * dR, rr, dR + d) : fogc;
    rc = mix(rc, fogc, 1. - exp(-(dR + d) * .02));
    float mark = smoothstep(.06, .03, abs(abs(q.x) - .1)) * step(.5, fract(q.z * .25)) + smoothstep(.06, .03, abs(abs(q.x) - 3.2));
    col = mix(vec3(.015) + vec3(.6, .5, .2) * mark * .3, rc, .15 + .4 * wet);
  } else col = d < 90. ? shade(ro + rd * d, rd, d) : fogc * 1.3;
  col = mix(col, fogc, 1. - exp(-min(d, 90.) * .02));
`),

  // Aurora: snowy peaks over a still lake at night, green and violet curtains moving
  // across a starry sky and mirrored in the water, pines along the shore.
  aurora: WORLD(`
${ridged('rN', 6)}
float mtH(vec2 x){
  float far = smoothstep(8., 26., x.y);
  float h = rN(x * .13) * (.3 + 3.4 * far);
  float lake = smoothstep(8., 2., length((x - vec2(0., 9.)) * vec2(.22, .55)));
  return h + .15 - 1.2 * lake;
}
float pine(vec2 x, float g){
  vec2 id = floor(x / .8), q = mod(x, .8) - .4 - (vec2(hash(id + 4.), hash(id + 6.)) - .5) * .3;
  if (g < .05 || g > 1.6 || hash(id) < .3) return 0.;
  float H = .45 + .55 * hash(id + 2.), r = length(q);
  float tiers = 1. - .25 * fract(r * 14.);
  return max(0., H * (1. - r / .26) * tiers);
}
float landN(vec2 x){ float g = mtH(x); return g + pine(x, g); }
float mapN(vec3 p){ return (p.y - landN(p.xz)) * .3; }
${sdfKit('mapN', 170, 0)}
vec3 aurora(vec3 ro, vec3 rd){
  vec3 c = vec3(0.);
  if (rd.y <= 0.) return c;
  for (int i = 0; i < 18; i++) {
    float h = 5. + float(i) * .45;
    vec2 q = ro.xz + rd.xz * (h - ro.y) / rd.y;
    float w = q.x * .14 + sin(q.y * .09 + t * .05) * 1.6 + fbm(q * .05 + t * .02) * 2.;
    float band = exp(-pow(sin(w) * 2.2, 2.)) * smoothstep(60., 20., length(q));
    float fold = .5 + .5 * sin(q.x * 1.2 + t * .3 + fbm(q * .3) * 4.);
    vec3 ac = mix(vec3(.1, 1., .45), vec3(.6, .25, 1.), float(i) / 18.);
    c += ac * band * (.4 + .6 * fold) * .09 * (1. - float(i) / 20.);
  }
  return c * smoothstep(0., .08, rd.y);
}
vec3 sky(vec3 ro, vec3 rd){
  vec3 c = mix(vec3(.03, .06, .1), vec3(.004, .01, .03), smoothstep(0., .5, rd.y));
  c += vec3(.9, .95, 1.) * stars(rd, 160.) * smoothstep(0., .1, rd.y);
  return c + aurora(ro, rd);
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapN(q, .003 + .001 * d);
  bool tree = pine(q.xz, mtH(q.xz)) > .02;
  float snow = tree ? smoothstep(.6, .9, n.y) * .5 : smoothstep(.35, .7, n.y + (fbm(q.xz * 2.) - .5) * .5);
  vec3 m = mix(tree ? vec3(.01, .03, .02) : vec3(.04, .04, .05), vec3(.75, .82, .95), snow);
  vec3 lin = (.4 + .6 * n.y) * vec3(.1, .2, .2) + max(dot(n, normalize(vec3(.2, .6, 1.))), 0.) * vec3(.05, .25, .15);
  return mix(m * lin * 1.6, vec3(.03, .06, .09), 1. - exp(-d * .03));
}`, `
  vec3 ro = vec3(.8 * sin(t * .01), 1.2, 0.);
  vec3 rd = view(p, 1.5);
  float d = march_mapN(ro, rd, 70.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  if (dW < d && dW < 70.) {
    vec3 q = ro + rd * dW;
    vec3 n = normalize(vec3((noise(q.xz * vec2(6., 2.) + vec2(0., t * .15)) - .5) * .02, 1., (noise(q.xz * vec2(3., 1.) - vec2(t * .1, 0.)) - .5) * .04));
    vec3 rr = reflect(rd, n);
    float dR = march_mapN(q + vec3(0., .01, 0.), rr, 70.);
    vec3 rc = dR < 70. ? shade(q + rr * dR, rr, dR + dW) : sky(q, rr);
    col = mix(vec3(.005, .01, .02), rc, .82);
    col += vec3(.6, .7, .8) * smoothstep(.02, 0., abs(q.z - 3. - 4. * fbm(q.xz)) - .01) * .03;
  } else col = d < 70. ? shade(ro + rd * d, rd, d) : sky(ro, rd);
`),
};

// The 3D themes replace the band scene: the band is see-through and the world is drawn once.
const WORLD_THEMES = new Set(Object.keys(WORLDS));
for (const name of WORLD_THEMES) { delete SCENES[name]; UNDER_SCENES[name] = WORLDS[name]; }
