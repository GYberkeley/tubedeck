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

  // Hakone: Lake Ashi on a summer day. A cedar headland whose crowns sway in the wind,
  // forested ridges in blue haze, the vermilion torii and its railing standing in calm
  // water that mirrors it all, with cat's-paw ripples drifting across the lake.
  hakone: WORLD(`
const vec3 SUN = vec3(-.42, .6, -.68);
const float HZK = .27;
vec3 crownId;
float shore(vec2 x){ return x.x - (2.3 + .1 * (x.y - 18.) + .7 * sin(x.y * .27)); }
float crowns(vec2 x){
  vec2 i = floor(x), f = fract(x); float h = 0.;
  for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
    vec2 g = vec2(float(k), float(j)), c = i + g, o = vec2(hash(c), hash(c + 7.)) * .7;
    o.x += .05 * sin(t * 1.1 + hash(c + 5.) * 6.) + .03 * sin(t * 2.3 + c.y);      // wind
    vec2 d = g + o - f; float r = .55 + .3 * hash(c + 3.);
    float dome = sqrt(max(r * r - dot(d, d), 0.)) * (1.5 + 1.1 * hash(c + 11.)) * (.8 + .35 * noise(x * 3.3 + c));
    if (dome > h) { h = dome; crownId = vec3(hash(c + 17.), hash(c + 23.), r); }
  }
  return h;
}
float hills(vec2 x){
  float far = smoothstep(30., 44., x.y);
  return far * (2.2 + 4.2 * fbm(x * .04 + 7.)) - .6 + .12 * noise(x * 1.5);
}
float land(vec2 x){
  float e = shore(x);
  float head = smoothstep(-.2, 3.5, e) * smoothstep(9., 13., x.y) * (1.6 + 1.6 * fbm(x * .12)) - .4;
  if (e > -1.) head += .75 * crowns(x / .62) * smoothstep(-.5, .8, e) * smoothstep(9., 13.5, x.y);
  return max(head, hills(x));
}
float torii(vec3 p, out float black){
  p -= vec3(1.05, 0., 19.); p.xz = rot(-.18) * p.xz;
  vec3 q = p; q.x = abs(q.x) - .62;
  float pil = sdCyl(q.xz, q.y - 1., .085 - .01 * q.y, 1.25);
  float nuki = sdBox(p - vec3(0., 1.65, 0.), vec3(.9, .05, .035));
  vec3 k = p - vec3(0., 2.15, 0.); k.y -= .05 * k.x * k.x;
  float kasa = sdBox(k, vec3(1.18, .06, .1)) - .01;
  float shim = sdBox(k + vec3(0., .12, 0.), vec3(1.05, .05, .07));
  float gaku = sdBox(p - vec3(0., 1.88, 0.), vec3(.06, .17, .03));
  vec3 f = p - vec3(0., 0., -.55); vec3 fp = f; fp.x = abs(abs(fp.x) - .85) - .38;   // railing in front
  float posts = sdCyl(fp.xz, fp.y - .45, .04, .55);
  float rails = min(sdBox(f - vec3(0., .48, 0.), vec3(1.32, .035, .035)), sdBox(f - vec3(0., .92, 0.), vec3(1.32, .035, .035)));
  float red = min(min(min(pil, nuki), min(shim, gaku)), min(posts, rails));
  black = kasa < red ? 1. : 0.;
  return min(red, kasa);
}
float mapH(vec3 q){ float b; return min(torii(q, b), (q.y - land(q.xz)) * .26); }
${sdfKit('mapH', 220)}
vec3 sky(vec3 rd){
  vec3 c = mix(vec3(.84, .9, .94), vec3(.38, .58, .84), smoothstep(0., .5, rd.y));
  if (rd.y > 0.) {
    vec2 q = rd.xz / (rd.y + .04);
    float cl = fbm(q * .6 + vec2(t * .008, 0.));
    c = mix(c, vec3(1.), smoothstep(.55, .85, cl) * smoothstep(.02, .15, rd.y) * .55);
  }
  return c + vec3(1., .95, .85) * pow(max(dot(rd, SUN), 0.), 12.) * .2;
}
vec3 shade(vec3 q, vec3 rd, float d){
  float black; float dt = torii(q, black);
  vec3 n = normal_mapH(q, .002 + .0012 * d);
  vec3 m; float leafy = 0.;
  if (dt < .02) m = black > .5 ? vec3(.03) : vec3(.62, .07, .01);
  else if (q.y < .03) m = vec3(.1, .09, .07);
  else {
    leafy = 1.;
    bool near = shore(q.xz) > -1. && q.z < 32.;
    if (near) { land(q.xz); m = mix(vec3(.035, .12, .02), vec3(.13, .3, .04), crownId.x); m = mix(m, vec3(.025, .08, .035), step(.8, crownId.y)); }
    else m = mix(vec3(.05, .13, .06), vec3(.1, .22, .08), noise(q.xz * .6));
    // leaves flutter: fine normal detail that moves with the wind
    n = normalize(n + (vec3(noise3(q * 9. + vec3(t * .8, 0., 0.)), noise3(q * 9. + 3.), noise3(q * 9. - vec3(0., 0., t * .6))) - .5) * (near ? .7 : .35));
    m *= .7 + .6 * noise3(q * 5.);
  }
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapH(q + n * .03, SUN, 15.) : 0.;
  vec3 lin = dif * sh * vec3(2.2, 2., 1.7) + (.5 + .5 * n.y) * vec3(.3, .4, .55) + leafy * pow(max(dot(rd, SUN), 0.), 2.) * vec3(.25, .35, .05);
  vec3 c = m * lin * ao_mapH(q, n);
  c += (dt < .02 && black < .5) ? vec3(.1, .015, 0.) : vec3(0.);
  return mix(c, vec3(.6, .74, .9), 1. - exp(-max(d - 8., 0.) * .009));
}`, `
  vec3 ro = vec3(.3 * sin(t * .01), .5, 0.);
  vec3 rd = normalize(vec3(p.x, p.y - HZK, 1.5));
  float dT = march_mapH(ro, rd, 95.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  if (dW < dT && dW < 95.) {
    vec3 q = ro + rd * dW;
    float paws = .25 + .75 * smoothstep(.42, .72, fbm(q.xz * vec2(.18, .45) + vec2(t * .04, -t * .01)));
    vec2 w = vec2(noise(q.xz * vec2(3., 9.) + vec2(t * .5, 0.)), noise(q.xz * vec2(5., 14.) - vec2(0., t * .7))) - .5;
    vec3 n = normalize(vec3(w.x * .015 * paws, 1., w.y * .04 * paws));
    vec3 rr = reflect(rd, n);
    float dR = march_mapH(q + vec3(0., .01, 0.), rr, 95.);
    vec3 rc = dR < 95. ? shade(q + rr * dR, rr, dR + dW) : sky(rr);
    float fr = .1 + .9 * pow(1. - max(dot(n, -rd), 0.), 5.);
    col = mix(vec3(.03, .1, .16), rc * vec3(.85, .92, 1.), .62 + .3 * fr);
    col += vec3(1., .95, .85) * pow(max(dot(rr, SUN), 0.), 300.) * 3. * paws;
    col = mix(col, vec3(.6, .74, .9), 1. - exp(-max(dW - 8., 0.) * .009));
  } else if (dT < 95.) col = shade(ro + rd * dT, rd, dT);
  else col = sky(rd);
`),

  // Wulong: looking up a sunlit gorge at one of the Three Natural Bridges. Layered
  // limestone cliffs with ochre and grey streaks, foliage masses on every ledge that
  // move in the wind, and the great arch opening onto light beyond.
  wulong: WORLD(`
const vec3 SUN = vec3(.3, .87, -.39);
float cx(float z){ return 1.2 * sin(z * .07); }
float veg(vec3 p){ return smoothstep(.48, .66, fbm(vec2(p.z * .14 + p.x * .1, p.y * .2)) + .25 * smoothstep(12., 16., p.y)); }
float rock(vec3 p){
  float x = p.x - cx(p.z);
  float strata = .45 * noise(vec2(p.z * .2, p.y * 1.1)) + .25 * sin(p.y * 1.7 + 2. * noise(vec2(p.z * .15, 1.))) * noise(vec2(p.z * .3, p.y * .4));
  float air = 4.3 + 1. * sin(p.z * .045 + 1.) - abs(x) + strata - .8 * noise(vec2(p.z * .1, p.y * .15));
  float walls = max(air, p.y - (16. + 3. * fbm(p.xz * .1)));
  float slab = max(44. - p.z + .5 * noise(p.xy * .4), p.z - 52.);
  float arch = length(vec2(x / 3.4, (p.y + 1.) / 9.5)) - 1.;
  float bridge = max(max(slab, -arch * 3.), p.y - 15.5 - fbm(p.xz * .2) * 2.);
  float d = min(walls, bridge);
  float v = veg(p);
  d -= v * (.45 + .3 * noise3(p * 2.5 + vec3(.15 * sin(t * .9 + p.y), 0., 0.)));      // foliage, swaying
  return d;
}
float clumps(vec2 x){
  vec2 i = floor(x), f = fract(x); float h = 0.;
  for (int j = -1; j <= 1; j++) for (int k = -1; k <= 1; k++) {
    vec2 g = vec2(float(k), float(j)), c = i + g, o = vec2(hash(c), hash(c + 7.)) * .7;
    o.x += .04 * sin(t * 1.2 + hash(c + 5.) * 6.);
    vec2 d = g + o - f; float r = .5 + .3 * hash(c + 3.);
    h = max(h, sqrt(max(r * r - dot(d, d), 0.)) * (.8 + .5 * hash(c + 11.)) * (.85 + .3 * noise(x * 3.1 + c)));
  }
  return h;
}
float ground(vec3 p){
  float x = abs(p.x - cx(p.z));
  float bank = smoothstep(.7, 1.6, x);
  return p.y - (.12 * fbm(p.xz * .5) + bank * (.25 + .75 * clumps(p.xz / .7)));
}
float mapW(vec3 p){ return min(rock(p), ground(p)) * .5; }
${sdfKit('mapW', 200)}
vec3 sky(vec3 rd){ return mix(vec3(.85, .9, .92), vec3(.5, .68, .86), smoothstep(0., .6, rd.y)) + vec3(1., .95, .8) * pow(max(dot(rd, SUN), 0.), 6.) * .3; }
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapW(q, .004 + .001 * d);
  float g = ground(q), v = veg(q);
  vec3 m;
  if (g < rock(q) && q.y < 3.) {
    v = smoothstep(.12, .35, q.y);
    vec2 st = fract(vec2(q.x * 1.6, q.z * 2.4)) - .5;
    float slab = smoothstep(.5, .42, max(abs(st.x), abs(st.y)));
    m = mix(vec3(.42, .4, .36) * (.75 + .25 * slab), vec3(.07, .22, .03) + vec3(.12, .14, .02) * noise(q.xz * 3.), v);
  } else {
    float x = q.x - cx(q.z);
    m = mix(vec3(.46, .45, .42), vec3(.66, .63, .57), noise(vec2((q.z + x) * 1.3, q.y * .12)));
    m = mix(m, vec3(.68, .5, .3), smoothstep(.55, .8, noise(vec2((q.z + x) * 1.6, q.y * .12))) * .8);   // ochre runs
    m *= .7 + .3 * smoothstep(.15, .5, noise(vec2((q.z - x) * 3., q.y * .2)));                        // grey water streaks
  }
  float leafy = max(v, step(.5, v));
  if (v > .01) {
    vec3 lc = mix(vec3(.1, .26, .03), vec3(.32, .5, .08), noise3(q * 1.3));
    m = mix(m, lc * (.75 + .5 * noise3(q * 6.)), v);
    n = normalize(n + (vec3(noise3(q * 7. + vec3(t * .7, 0., 0.)), noise3(q * 7. + 4.), noise3(q * 7. - vec3(0., t * .5, 0.))) - .5) * .8 * v);
  }
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapW(q + n * .05, SUN, 25.) : 0.;
  vec3 lin = dif * sh * vec3(2.1, 1.95, 1.65) + (.45 + .55 * n.y) * vec3(.35, .42, .5) + v * pow(max(dot(rd, SUN), 0.), 2.) * vec3(.2, .3, .04);
  vec3 c = m * lin * ao_mapW(q, n);
  return mix(c, vec3(.74, .82, .88), 1. - exp(-max(d - 10., 0.) * .009));
}`, `
  vec3 ro = vec3(cx(0.) + .4 * sin(t * .01), 1.7, 0.);
  vec3 rd = view(p, 1.35);
  rd.xz = rot(-.06) * rd.xz;
  float d = march_mapW(ro, rd, 90.);
  col = d < 90. ? shade(ro + rd * d, rd, d) : sky(rd);
  // soft sunbeams falling into the gorge
  float beams = 0.;
  for (int i = 1; i <= 5; i++) {
    float s = float(i) * min(d, 60.) / 6.;
    vec3 q = ro + rd * s;
    beams += smoothstep(.55, .8, noise(vec2(q.x * .4 - q.y * .25, q.z * .1))) * smoothstep(3., 12., q.y + 4.);
  }
  col += vec3(1., .95, .8) * beams * .025;
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
  col = mix(col, vec3(.74, .82, .84), 1. - exp(-max(dd - 6., 0.) * .008));
  float mist = 0.;
  for (int i = 0; i < 5; i++) {
    float h = .5 + float(i) * .45, s = (h - ro.y) / rd.y;
    if (s > 0. && s < dd) { vec2 m = (ro + rd * s).xz; mist += smoothstep(.5, .9, fbm(m * .15 + vec2(t * .02 - float(i), 0.))) * (1. - valley(m)) * .16; }
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

  // Chongqing: Hongyadong at blue hour. Stilted tiers climb the cliff above the river,
  // their sweeping roofs outlined in gold, warm windows and red lanterns, quiet towers
  // behind, and soft gold reflections in the Jialing below.
  chongqing: WORLD(`
float tier(vec3 p, float k){
  float zf = 13. + k * 1.25, yb = k * 1.1 - .2;
  float x0 = -12. + k * .9 + 2.5 * hash(vec2(k, 2.)), x1 = 8. - k * .6 - 2.5 * hash(vec2(k, 5.));
  float body = sdBox(p - vec3((x0 + x1) * .5, yb + .45, zf + 3.), vec3((x1 - x0) * .5, .45, 3.));
  vec3 r = p - vec3(0., yb + .98, zf + .25);
  r.x = clamp(r.x, x0 - (x0 + x1) * .5 * 0. , x1);
  vec3 rr = vec3(p.x, r.y, r.z); float cell = floor((p.x + k * .7) / 1.7); rr.x = mod(p.x + k * .7, 1.7) - .85;
  float inX = max(x0 - p.x, p.x - x1);
  rr.y -= .25 * hash(vec2(cell, k));                                    // pavilions at varied heights
  rr.y += .12 * rr.x * rr.x;                                            // eaves sweep up at the corners
  rr.yz = rot(.7854) * rr.yz;
  float roof = max(sdBox(rr, vec3(.72, .28, .28)), -(p.y - (yb + .9)));
  roof = max(roof, inX);
  return min(body, roof);
}
float hong(vec3 p){ float d = 1e3; for (int k = 0; k < 6; k++) d = min(d, tier(p, float(k))); return d; }
float towers(vec3 p){
  if (p.z < 21.) return max(21. - p.z, .1);
  float id = floor(p.x / 3.); vec3 q = p; q.x = mod(p.x, 3.) - 1.5;
  float H = 8. + 9. * hash(vec2(id, 1.)), z0 = 26. + 6. * hash(vec2(id, 4.));
  float b = sdBox(q - vec3(0., H * .5, z0), vec3(.9 + .4 * hash(vec2(id, 3.)), H * .5, 1.5));
  return min(b, max(1.5 - abs(q.x), p.y - 17.) + .3);
}
float mapC(vec3 p){ return min(min(hong(p), towers(p)), p.y + .5 + 20. * step(p.z, 12.) * step(-14., p.z)); }
${sdfKit('mapC', 160, 0, false)}
vec3 sky(vec3 rd){ return mix(vec3(.14, .16, .34), vec3(.03, .06, .17), smoothstep(0., .45, rd.y)); }
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapC(q, .003 + .001 * d);
  if (towers(q) < .03) {
    vec2 g = vec2((abs(n.x) > .5 ? q.z : q.x) / .6, q.y / .5);
    float w = step(.35, fract(g.x)) * step(.4, fract(g.y)) * step(.8, hash(floor(g) + floor(q.x / 3.)));
    float sign = step(.75, hash(vec2(floor(q.x / 3.), 9.))) * smoothstep(.1, 0., abs(fract(q.x / 3.) - .5) - .08) * step(9., q.y) * step(q.y, 12.);
    return vec3(.03, .04, .09) + vec3(.55, .65, .85) * mix(w, .08, aaFade(d, .5)) * .35 + vec3(1.4, .12, .1) * sign * .8;
  }
  if (q.z < 12.5 && q.y < -.3) return vec3(.01);
  // Hongyadong: which tier, and where within its storey
  float k = clamp(floor((q.y + .2) / 1.1), 0., 5.), yb = k * 1.1 - .2, v = q.y - yb;
  vec3 c = vec3(.05, .025, .015);
  if (n.y > .3 || (v > .88 && abs(n.z) < .95)) {                       // roofs: dark tiles lit gold at the eaves
    float eave = smoothstep(.12, 0., abs(v - .9));
    c = vec3(.3, .17, .05) * (.6 + .4 * n.y) + vec3(1.5, .95, .38) * (eave * 1.8 + .18 * (.5 + .5 * sin(q.x * 18.)) * (1. - aaFade(d, .06)));
  } else if (n.z < -.5) {                                              // facades: warm windows and lanterns
    vec2 g = vec2((q.x + k * .7) / .42, v / .3);
    float win = step(.18, fract(g.x)) * step(.25, fract(g.y)) * step(v, .82);
    float lit = .55 + .45 * step(.3, hash(floor(g) + k * 13.));
    c += vec3(1.25, .7, .28) * mix(win * lit, .55, aaFade(d, .3)) * 1.1;
    vec2 l = vec2(fract((q.x + k * .7) / .85) - .5, (v - .72) * 3.);
    c += vec3(1.6, .18, .08) * smoothstep(.12, .05, length(l)) * (.8 + .2 * sin(t * 2. + q.x));
    float sign = step(.86, hash(vec2(floor((q.x + k * .7) / 1.7), k))) * step(.15, v) * step(v, .75) * step(abs(fract((q.x + k * .7) / 1.7) - .5), .06);
    c = mix(c, vec3(1.5, .25, .1) * (.8 + .4 * pow(1. - beat, 3.)), sign);
  }
  return c;
}`, `
  vec3 ro = vec3(-1. + .6 * sin(t * .01), 2.6, -24.);
  vec3 rd = view(p, 1.6);
  rd.yz = rot(.04) * rd.yz;
  float d = march_mapC(ro, rd, 90.);
  float dW = rd.y < 0. ? (-.2 - ro.y) / rd.y : 1e5;
  vec3 fogc = vec3(.08, .09, .2);
  if (dW < d && dW < 90.) {
    vec3 q = ro + rd * dW;
    vec3 n = normalize(vec3((noise(q.xz * vec2(1.5, 4.) + vec2(0., t * .3)) - .5) * .015, 1., (noise(q.xz * vec2(.8, 4.) - vec2(t * .25, 0.)) - .5) * .06));
    vec3 rr = reflect(rd, n);
    float dR = march_mapC(q + vec3(0., .01, 0.), rr, 90.);
    vec3 rc = dR < 90. ? shade(q + rr * dR, rr, (dR + dW) * 4.) : sky(rr);
    col = mix(vec3(.01, .015, .04), rc, .22);
    d = dW;
  } else col = d < 90. ? shade(ro + rd * d, rd, d) : sky(rd);
  col = mix(col, fogc, 1. - exp(-min(d, 90.) * .012));
  col *= .45 + .55 * smoothstep(-.15, .18, p.y);           // quieter behind the decks
`),

  // Times Square: looking up the bowtie at One Times Square. Big screens stacked on
  // every facade and up the tower, each with its own beat-synced content, LED trim, and
  // a wet street that mirrors the light.
  timessquare: WORLD(`
float cellH(float id){ return 18. + 14. * hash(vec2(id, 2.)); }
float facades(vec3 p){
  float side = sign(p.x), fx = 7. - .07 * p.z, air = fx - abs(p.x);
  float id = floor(p.z / 8.) + side * 31.;
  return max(air * .99, p.y - cellH(id));
}
float tower(vec3 p){ return min(sdBox(p - vec3(0., 12., 50.), vec3(2.6, 12., 2.4)), sdBox(p - vec3(0., 15., 64.), vec3(9., 15., 3.))); }
float mapT(vec3 p){ return min(min(facades(p), tower(p)), p.y); }
${sdfKit('mapT', 140, 0, false)}
vec3 pal(float h){ return pow(.5 + .5 * cos(6.28 * (h + vec3(0., .33, .67))), vec3(1.6)); }
vec3 screen(vec2 uv, float k, float s, float d){
  vec3 a = pal(s), b = pal(s + .3);
  float pulse = .75 + .5 * pow(1. - beat, 3.);
  if (k < .3) return mix(a, b, smoothstep(.3, .7, uv.y + .25 * sin(uv.x * 3. + t * .5))) * pulse;
  if (k < .55) { float r = length((uv - .5) * vec2(1.7, 1.)); return mix(a * .2, b * 1.2, smoothstep(.27, .25, r * (1. - .1 * pow(1. - beat, 3.)))) + a * .6 * smoothstep(.015, 0., abs(r - .36)); }
  if (k < .8) { float bar = smoothstep(.02, 0., abs(uv.y - .5) - .12); float word = step(.35, hash(vec2(floor(uv.x * 9. + t * 1.5), 1.)));
    return mix(a * .5, vec3(1.15), bar * mix(word, .6, aaFade(d, .04))) * pulse; }
  return mix(a, b, smoothstep(.25, .75, fbm(uv * 2. + vec2(t * .06, 0.)))) * pulse;
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapT(q, .003 + .001 * d);
  if (q.y < .01) return vec3(.02);
  vec2 uv; float id, rows, cols, H;
  if (tower(q) < .03) {
    if (q.z > 55.) return vec3(.03, .025, .04) + vec3(1., .85, .6) * .08;
    uv = vec2(abs(n.z) > .5 ? q.x + 2.6 : q.z - 47.6, q.y - 1.) / vec2(5.2, 3.6);
    id = 900. + floor(uv.y); rows = 1.; cols = 1.; H = 23.;
    if (q.y > 22.) return vec3(.04) + vec3(.9, .8, .6) * .3;
  } else {
    float side = sign(q.x); id = floor(q.z / 8.) + side * 31.; H = cellH(id);
    if (q.y < 2.4) { float shop = step(.12, fract(q.z * .5)) * step(.4, q.y) * step(q.y, 2.); return vec3(.02) + pal(hash(vec2(floor(q.z * .5), id))) * shop * .14; }
    if (q.y > H - 2.) return vec3(.03, .03, .05);
    uv = vec2(mod(q.z, 8.) / 8., (q.y - 2.4) / (H - 4.4));
    rows = 4. + floor(hash(vec2(id, 5.)) * 3.); cols = 2. + step(.5, hash(vec2(id, 6.)));
  }
  vec2 g = uv * vec2(cols, rows), f = fract(g), cell = floor(g);
  float s = hash(cell + id * 1.7);
  float inside = step(.07, f.x) * step(f.x, .93) * step(.1, f.y) * step(f.y, .9) * step(.12, hash(cell + id * 5.3));
  float trim = smoothstep(.012, 0., abs(f.y - .025)) * step(.5, hash(cell + id));
  vec3 led = pal(id * .13 + t * .05) * (.6 + .6 * pow(1. - beat, 2.));
  return vec3(.02, .02, .03) + screen(f, hash(cell + id * 3.1), s * 5., d) * inside + led * trim * .8;
}`, `
  vec3 ro = vec3(.3 * sin(t * .01), 2.2, -4.);
  vec3 rd = view(p, 1.3);
  rd.yz = rot(.09) * rd.yz;
  float d = march_mapT(ro, rd, 100.);
  vec3 fogc = vec3(.12, .07, .16);
  if (d < 100. && ro.y + rd.y * d < .01) {
    vec3 q = ro + rd * d;
    vec3 n = vec3(0., 1., 0.);
    vec3 rr = reflect(rd, n);
    float dR = march_mapT(q + vec3(0., .01, 0.), rr, 90.);
    vec3 rc = dR < 90. ? shade(q + rr * dR, rr, dR + d) : fogc;
    float mark = smoothstep(.08, .04, abs(abs(q.x) - 2.)) * step(.5, fract(q.z * .2));
    col = mix(vec3(.015) + vec3(.7, .65, .5) * mark * .15, rc, .18 + .3 * smoothstep(.35, .65, fbm(q.xz * .4)));
  } else col = d < 100. ? shade(ro + rd * d, rd, d) : fogc * 1.2;
  col = mix(col, fogc, 1. - exp(-min(d, 100.) * .012));
  col *= .4 + .6 * smoothstep(-.15, .18, p.y);            // quieter behind the decks
`),

  // Aurora: a still lake under the northern lights. Tall curtains ripple across the sky
  // and in the mirror-calm water, over soft snow-capped ridges and shoreline spruce.
  aurora: WORLD(`
float sm(float x){ return .5 * noise(vec2(x, 0.)) + .25 * noise(vec2(x * 2.1, 3.)) + .125 * noise(vec2(x * 4.3, 7.)); }
vec3 lights(vec3 rd){
  vec3 c = vec3(0.);
  if (rd.y <= 0.) return c;
  float jit = hash(gl_FragCoord.xy) * .5;
  for (int i = 0; i < 32; i++) {
    float fi = float(i), h = 3.5 + (fi + jit) * .28;
    vec2 q = rd.xz * (h - 1.) / rd.y;
    // the curtain drifts and folds; ripples run along it like a flag in the wind
    float curve = q.x - 7. * sin(q.y * .07 + t * .09) - 3. * sin(q.y * .19 - t * .14 + 1.) - 1.6 * sin(q.y * .45 - t * .7) - 9.;
    float second = q.x + 4. + 6. * sin(q.y * .05 - t * .06) + 1.2 * sin(q.y * .5 + t * .8);
    float band = exp(-curve * curve * .35) + .6 * exp(-second * second * .4);
    // rays shimmer and slide along the curtain; bright pulses travel through it
    float rays = .2 + .8 * pow(noise(vec2(q.y * 2.2 + q.x * .3 - t * .9, t * .5)), 1.5);
    float pulse = .55 + .45 * sin(q.y * .12 - t * 1.1) * sin(q.y * .05 + t * .3);
    float fade = smoothstep(170., 40., length(q));
    float top = smoothstep(10., 26., fi + 4. * sin(q.y * .1 + t * .2));
    vec3 ac = mix(vec3(.15, 1., .45), vec3(.75, .25, .9), top);
    c += ac * band * rays * pulse * fade * (1. - fi / 36.) * .085;
  }
  return c * (.85 + .15 * sin(t * .6));
}
vec3 above(vec2 q){
  vec3 rd = view(q, 1.5);
  vec3 c = mix(vec3(.02, .05, .08), vec3(.003, .008, .022), smoothstep(0., .5, rd.y));
  c += vec3(.85, .9, 1.) * stars(rd, 150.) * smoothstep(0., .08, rd.y);
  c += lights(rd);
  float y = q.y - HZ;
  float far = .035 + .085 * pow(sm(q.x * 2.2 + 4.), 1.6);
  if (y < far) {
    float snow = smoothstep(far - .03, far - .005, y) * smoothstep(.05, .09, far);
    c = mix(vec3(.02, .035, .05), vec3(.22, .4, .38), snow) + lights(normalize(vec3(q.x, .3, 1.))) * .08;
  }
  float near = .012 + .03 * sm(q.x * 4. + 20.);
  if (y < near) c = vec3(.008, .015, .02);
  float side = smoothstep(.35, .8, abs(q.x));
  float cx = floor(q.x / .022), fx = fract(q.x / .022) - .5;
  float th = (.04 + .08 * hash(vec2(cx, 1.))) * side;
  float w = (.5 - fract((y / max(th, .001)) * 5.) * .35) * (1. - y / max(th, .001));
  if (th > .01 && y < th && abs(fx) < w * .9) c = vec3(.004, .01, .012);
  return c;
}`, `
  if (p.y >= HZ) col = above(p);
  else {
    float depth = HZ - p.y;
    float rip = (noise(vec2(p.x * 6., depth * 140. / (depth * 6. + .2) - t * .5)) - .5) * .012 * depth * 4.;
    col = above(vec2(p.x + rip * .5, 2. * HZ - p.y + rip)) * vec3(.55, .65, .72);
    col += vec3(.02, .05, .06) * smoothstep(.0, .3, depth);
  }
`),
};

// The 3D themes replace the band scene: the band is see-through and the world is drawn once.
const WORLD_THEMES = new Set(Object.keys(WORLDS));
for (const name of WORLD_THEMES) { delete SCENES[name]; UNDER_SCENES[name] = WORLDS[name]; }
