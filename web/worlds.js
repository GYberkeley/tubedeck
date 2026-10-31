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

const WORLD = (funcs, body, { raw = false } = {}) => `${WORLD_COMMON}
${funcs}
void main(){
  vec2 p = (gl_FragCoord.xy - .5 * res) / res.y;
  vec3 col = vec3(0.);
${body}
  col = ${raw ? 'clamp(col, 0., 1.)' : 'tonemap(col)'};
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
  // Switzerland: a green alpine valley in summer. Bright rolling meadows and a milky
  // turquoise river up front, conifer stands on the slopes, chalets and a white church
  // with its steeple, rock walls rising to snowfields and a horn, cumulus in a blue sky.
  alps: WORLD(`
const vec3 SUN = vec3(.6, .62, -.5);
${ridged('rLo', 5)}
${ridged('rHi', 8)}
float b0, b1, b2, b3, b4, b5;                            // building ground heights, set in main
float river(vec2 x){ return abs(x.x - 1.4 - 2.2 * sin(x.y * .13 + .5)); }
float baseH(vec2 x, float r){
  float far = smoothstep(18., 36., x.y);
  float horn = exp(-pow(length((x - vec2(5., 48.)) * vec2(1., .8)) * .12, 1.6));
  float side = smoothstep(7., 17., abs(x.x - 1.)) * smoothstep(3., 14., x.y);
  float meadow = .35 * fbm(x * .16) + .2 * sin(x.x * .45 + 1.) * sin(x.y * .32);
  float h = meadow + side * (1. + 2.8 * r) + far * (r * 4.4 + .8) + horn * (4.2 + 1.6 * r);
  return h - .6 * smoothstep(1.2, .45, river(x)) * (1. - far);
}
float trees(vec2 x, float g){
  vec2 id = floor(x / .6), q = mod(x, .6) - .3 - (vec2(hash(id + 4.), hash(id + 6.)) - .5) * .2;
  float forest = step(.55, fbm(x * .11 + 3.)) * step(.35, g) * step(g, 3.2) + step(.985, hash(id + 1.)) * step(.15, g) * step(g, 2.5);
  if (forest < .5 || river(x) < 1.5 || x.y < 9.) return 0.;
  float H = .5 + .45 * hash(id + 2.), r = length(q);
  return max(0., H * (1. - r / .27)) * (1. - .18 * fract(r * 13.));
}
float hill(vec2 x){ return baseH(x, rLo(x * .14)); }
float roofPrism(vec3 q, float w, float h){                 // gable roof, ridge along z
  return max(max(dot(vec2(abs(q.x), q.y), normalize(vec2(h, w))) - w * h / length(vec2(w, h)), -q.y), abs(q.z) - .52);
}
float chalet(vec3 p, vec3 c, float a){
  vec3 q = p - c; q.xz = rot(a) * q.xz;
  if (length(q) > 2.) return length(q) - 1.5;
  return min(sdBox(q - vec3(0., .32, 0.), vec3(.42, .32, .36)), roofPrism(q - vec3(0., .64, 0.), .6, .32));
}
float church(vec3 p, vec3 c){
  vec3 q = p - c;
  if (length(q) > 3.5) return length(q) - 3.;
  float nave = min(sdBox(q - vec3(0., .4, .4), vec3(.38, .4, .7)), roofPrism(q - vec3(0., .8, .4), .45, .35));
  float tower = sdBox(q - vec3(0., .9, -.45), vec3(.2, .9, .2));
  vec3 s = q - vec3(0., 1.8, -.45);
  float spire = max(max(dot(vec2(abs(s.x), s.y), normalize(vec2(1., .25))), dot(vec2(abs(s.z), s.y), normalize(vec2(1., .25)))) - .2 * .97, -s.y);
  return min(min(nave, tower), spire);
}
float village(vec3 p){
  if (p.z < 5. || p.z > 22.) return max(5. - p.z, p.z - 22.) + .5;
  return min(min(min(chalet(p, vec3(-2.6, b0, 9.), .3), chalet(p, vec3(3.9, b1, 12.), -.4)),
             min(chalet(p, vec3(-5.2, b2, 14.5), .1), chalet(p, vec3(5.8, b3, 8.5), .6))),
             min(church(p, vec3(-3.6, b4, 19.)), chalet(p, vec3(1.2, b5, 17.), -.2)));
}
float land(vec2 x){ float g = hill(x); return g + trees(x, g); }
float mapA(vec3 q){ return min((q.y - land(q.xz)) * .3, village(q)); }
${sdfKit('mapA', 230)}
vec3 sky(vec3 rd, vec3 ro){
  float y = max(rd.y, 0.);
  vec3 c = mix(vec3(.55, .76, .98), vec3(.12, .38, .86), pow(y, .45));
  c += vec3(1., .92, .75) * pow(max(dot(rd, SUN), 0.), 8.) * .25;
  if (rd.y > 0.) {
    vec2 q = ro.xz + rd.xz * (22. - ro.y) / rd.y;
    float cl = fbm(q * .035 + vec2(t * .01, 0.)) + .5 * fbm(q * .11 - vec2(t * .015, 0.));
    float dens = smoothstep(.78, 1.05, cl), lit = smoothstep(.7, 1.15, cl + .25 * fbm(q * .2 + 3.));
    c = mix(c, mix(vec3(.72, .76, .84), vec3(1.05), lit), dens * smoothstep(0., .1, rd.y));
  }
  return c;
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapA(q, .003 + .0012 * d);
  float tol = .02 + .0015 * d, v = village(q);
  vec3 m;
  if (v < tol) {                                          // chalets: white plaster, dark timber, red roofs, windows
    bool roof = n.y > .3;
    m = roof ? vec3(.5, .16, .08) : (fract(q.y * 3.) < .5 && q.y - floor(q.y) > .0 ? vec3(.92, .9, .86) : vec3(.92, .9, .86));
    float upper = step(.5, fract((q.y + 10.) * 1.)) ;
    if (!roof) {
      m = mix(vec3(.93, .91, .87), vec3(.35, .2, .1), step(.35, fract(q.y + 10. - b0 * 0.)) * 0.);
      vec2 w = fract(vec2((abs(n.x) > .5 ? q.z : q.x) * 4., q.y * 4.));
      m = mix(m, vec3(.12, .1, .1), step(.3, w.x) * step(w.x, .7) * step(.35, w.y) * step(w.y, .7));
      m = mix(m, vec3(.85, .15, .2), step(.3, w.x) * step(w.x, .7) * step(.2, w.y) * step(w.y, .3));     // flower boxes
    }
  } else if (trees(q.xz, hill(q.xz)) > .02) {
    m = mix(vec3(.03, .12, .04), vec3(.07, .2, .06), noise(q.xz * 3.));
    n = normalize(n + (vec3(noise3(q * 10. + vec3(t * .5, 0., 0.)), .5, noise3(q * 10. + 3.)) - .5) * .5);
  } else {
    float hgt = q.y, dirt = fbm(q.xz * 1.6 + q.y);
    vec3 rock = mix(vec3(.42, .4, .38), vec3(.68, .64, .58), dirt);
    vec3 grass = mix(vec3(.12, .42, .05), vec3(.4, .7, .1), smoothstep(.3, .7, fbm(q.xz * .35)));
    grass *= .85 + .3 * noise(q.xz * 2.5);
    grass = mix(grass, vec3(1., .9, .3), step(.93, noise(q.xz * 30.)) * .6 * (1. - aaFade(d, .03)));   // buttercups
    m = mix(rock, grass, smoothstep(.62, .8, n.y) * smoothstep(4.2, 2.6, hgt));
    m = mix(m, vec3(.96, .98, 1.), smoothstep(.45, .7, n.y + (hgt - 4.2) * .35 + (dirt - .5) * .5) * smoothstep(3.6, 4.6, hgt));
    n = normalize(n + (vec3(noise3(q * 14. + vec3(t * .9, 0., 0.)), .5, noise3(q * 14. - 2.)) - .5) * .25 * smoothstep(.62, .8, n.y));
  }
  float dif = max(dot(n, SUN), 0.);
  float sh = dif > 0. ? shadow_mapA(q + n * .03, SUN, 20.) : 0.;
  vec3 lin = dif * sh * vec3(2.3, 2.15, 1.8) + (.55 + .45 * n.y) * vec3(.24, .34, .52);
  return mix(m * lin * ao_mapA(q, n), vec3(.6, .74, .94), 1. - exp(-max(d - 6., 0.) * .007));
}`, `
  b0 = hill(vec2(-2.6, 9.)); b1 = hill(vec2(3.9, 12.)); b2 = hill(vec2(-5.2, 14.5));
  b3 = hill(vec2(5.8, 8.5)); b4 = hill(vec2(-3.6, 19.)); b5 = hill(vec2(1.2, 17.));
  vec3 ro = vec3(.6 + .5 * sin(t * .01), 1.7, -1.);
  vec3 rd = view(p, 1.5);
  float dT = march_mapA(ro, rd, 90.);
  float dW = rd.y < 0. ? -ro.y / rd.y : 1e5;
  if (dW < dT && dW < 90.) {                              // glacial river: milky turquoise, foam running downstream
    vec3 q = ro + rd * dW;
    float flow = noise(vec2(q.x * 3., q.z * .8 + t * 1.6)) * noise(vec2(q.x * 7., q.z * 2. + t * 2.4));
    col = mix(vec3(.35, .72, .7), vec3(.9, .97, .96), smoothstep(.25, .5, flow));
    col = mix(col, sky(reflect(rd, vec3(0., 1., 0.)), q), .15);
    col = mix(col, vec3(.6, .74, .94), 1. - exp(-max(dW - 6., 0.) * .007));
  } else if (dT < 90.) col = shade(ro + rd * dT, rd, dT);
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
  float red = min(min(pil, nuki), min(shim, gaku));
  black = kasa < red ? 1. : 0.;
  return min(red, kasa);
}
// A pirate ship (Lake Ashi really has them) sailing slowly back and forth far out.
float shipPart;
float shipLocal(vec3 p){
  float sx = -7. + 5. * sin(t * .012), dir = cos(t * .012) >= 0. ? 1. : -1.;
  vec3 q = (p - vec3(sx, .04 * sin(t * .8), 27.)) / .7; q.x *= dir;
  float bnd = length(q - vec3(0., 1.2, 0.)) - 3.2;
  if (bnd > .5) { shipPart = 0.; return bnd; }
  q.y -= .03 * sin(t * .6 + q.x);
  float taper = 1. - .55 * smoothstep(.6, 1.6, q.x);
  float hull = sdBox(vec3(q.x, q.y - .28 - .07 * q.x * q.x, q.z / taper), vec3(1.6, .3, .42)) * .7;
  hull = min(hull, sdBox(q - vec3(-1.15, .7, 0.), vec3(.42, .18, .38)));
  vec3 m = q; m.x = q.x < -.2 ? q.x + .65 : q.x < .55 ? q.x - .15 : q.x - .9;
  float mast = sdCyl(m.xz, m.y - 1.45, .035, .95);
  vec3 sq = m - vec3(0., 1.45, 0.); sq.xz = rot(.9) * sq.xz; sq.y = abs(sq.y - .02) - .35; sq.x -= .06 * (1. - sq.z * sq.z * 4.);
  float sail = sdBox(sq, vec3(.02, .3, .38));
  float flag = sdBox(q - vec3(-.65, 2.5, .12), vec3(.01, .1, .16));
  float d = min(min(hull, mast), min(sail, flag));
  shipPart = d == sail ? 2. : d == flag ? 3. : d == mast ? 4. : 1.;
  return d;
}
float ship(vec3 p){ return shipLocal(p) * .7; }
float mapH(vec3 q){ float b; return min(min(torii(q, b), ship(q)), (q.y - land(q.xz)) * .26); }
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
  float ds = ship(q), tol = .02 + .0015 * d;
  if (ds < tol && ds < dt) { float k = shipPart; m = k > 3.5 ? vec3(.2, .12, .06) : k > 2.5 ? vec3(.02) : k > 1.5 ? vec3(.9, .86, .75) : (q.y > .5 ? vec3(.6, .45, .1) : vec3(.35, .08, .04)); }
  else if (dt < tol) m = black > .5 ? vec3(.03) : vec3(.62, .07, .01);
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
  {                                                       // a few bright stars that shimmer
    vec2 sq = vec2(atan(rd.z, rd.x), rd.y) * 45.; vec2 sid = floor(sq), sf = fract(sq) - .5;
    float sh = hash(sid + 31.);
    float tw = pow(.5 + .5 * sin(t * (3. + 4. * sh) + sh * 50.), 3.) * (.6 + .4 * noise(vec2(t * 4., sh * 9.)));
    float core = smoothstep(.06, 0., length(sf)) + .5 * smoothstep(.012, 0., abs(sf.x)) * smoothstep(.3, 0., abs(sf.y)) + .5 * smoothstep(.012, 0., abs(sf.y)) * smoothstep(.3, 0., abs(sf.x));
    col += mix(vec3(.7, .8, 1.), vec3(1., .9, .75), sh) * step(.965, sh) * core * tw * 1.6;
  }
  for (int i = 0; i < 1; i++) {                           // a rare shooting star, about once every half minute
    float fi = float(i), clk = t * .033, slot = floor(clk), ph = fract(clk) * 18.;
    if (ph < 1. && hash(vec2(slot, 7.)) > .25) {
      vec2 a = vec2(hash(vec2(slot, fi)) * 1.6 - .8, .3 + .18 * hash(vec2(slot, fi + 9.)));
      vec2 dir = normalize(vec2(hash(vec2(slot, fi + 4.)) > .5 ? 1. : -1., -.35 - .3 * hash(vec2(slot, fi + 2.))));
      vec2 head = a + dir * ph * .7;
      vec2 rel = p - head; float along = dot(rel, -dir), across = abs(dot(rel, vec2(-dir.y, dir.x)));
      float tail = step(0., along) * smoothstep(.22, 0., along) * smoothstep(.003, 0., across);
      col += vec3(.9, .95, 1.) * (tail * 1.4 + smoothstep(.006, 0., length(rel)) * 2.) * sin(ph * 3.1416);
    }
  }
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

  // Times Square, as a cartoon: standing at the north end of the bowtie looking down at
  // One Times Square and its ball, giant ads wrapping the flanking blocks (they swap and
  // bounce on the beat), towers behind, people milling about the plaza, cabs crossing.
  // Ink outlines and flat, saturated colour (no film tone curve).
  timessquare: WORLD(`
const vec3 KEY = vec3(-.45, .65, -.62);
vec3 poster(float h){
  h = fract(h) * 6.;
  return h < 1. ? vec3(.93, .1, .16) : h < 2. ? vec3(1., .8, .05) : h < 3. ? vec3(.05, .7, .95) :
         h < 4. ? vec3(.95, .2, .65) : h < 5. ? vec3(.2, .82, .3) : vec3(.3, .32, .98);
}
float graze;
float fx(float z){ return z < 33. ? 6. + .2 * max(24. - z, 0.) : 10.; }
float flankH(float id){ return 11. + 9. * hash(vec2(id, 2.)); }
float flank(vec3 p){
  float side = sign(p.x), id = floor(p.z / 9.) + side * 31.;
  return max(max((fx(p.z) - abs(p.x)) * .95, p.y - flankH(id)), -20. - p.z);
}
float tower(vec3 p){ return min(sdBox(p - vec3(0., 5.5, 44.), vec3(2.2, 5.5, 2.6)), sdCyl(p.xz - vec2(0., 44.), p.y - 11.9, .08, 1.)); }
float ball(vec3 p){ return length(p - vec3(0., 13.4, 44.)) - .75; }
float backdrop(vec3 p){
  float id = floor(p.x / 6.); vec3 q = p; q.x = mod(p.x, 6.) - 3.;
  float H = 16. + 18. * hash(vec2(id, 7.));
  return min(sdBox(q - vec3(0., H * .5, 62. + 6. * hash(vec2(id, 3.))), vec3(2.4, H * .5, 3.)), max(3. - abs(q.x), p.y - 34.) + .5);
}
float people(vec3 p){
  if (p.z < 3. || p.z > 31.) return max(max(3. - p.z, p.z - 31.), p.y - .9) + .2;
  vec2 id = floor(p.xz / 1.3); vec3 q = p; q.xz = mod(p.xz, 1.3) - .65;
  float bound = max(.65 - max(abs(q.x), abs(q.z)) + .1, p.y - 1.);
  if (hash(id) < .55 || abs(p.x) > fx(p.z) - 1.2) return max(bound, .05);
  q.xz -= (vec2(hash(id + 3.), hash(id + 5.)) - .5) * .5 + vec2(.15 * sin(t * .4 + hash(id) * 20.), 0.);
  float body = sdCyl(q.xz, q.y - .38, .13, .3) - .03;
  float head = length(q - vec3(0., .82, 0.)) - .12;
  return min(min(body, head), max(bound, .05));
}
vec3 cabQ(vec3 p){ return vec3(mod(p.x - t * 1.8, 14.) - 7., p.y, p.z - 33.2); }
float cab(vec3 p){ vec3 q = cabQ(p); return min(sdBox(q - vec3(0., .45, 0.), vec3(1., .25, .5)) - .08, sdBox(q - vec3(-.1, .82, 0.), vec3(.55, .16, .4)) - .06); }
float mapT(vec3 p){ return min(min(min(flank(p), tower(p)), min(ball(p), backdrop(p))), min(min(people(p), cab(p)), p.y)); }
${sdfKit('mapT', 160, 0, false)}
float marchInk(vec3 ro, vec3 rd, float tmax){
  float d = .05; graze = 1.;
  for (int i = 0; i < 160; i++) {
    float h = mapT(ro + rd * d);
    if (h < .0012 * d) return d;
    graze = min(graze, h / d);
    d += h; if (d > tmax) break;
  }
  return 1e5;
}
float boxEdge(vec3 q, vec3 b, float w){ vec3 e = step(b - abs(q), vec3(w)); return step(1.5, e.x + e.y + e.z); }
vec3 ad(vec2 uv, float k, float s){
  vec3 a = poster(s), b = poster(s + .5);
  float pop = pow(1. - beat, 3.);
  vec2 c = uv - .5;
  k *= 6.;
  if (k < 1.) {                                           // soda: red with a white wave ribbon
    float rib = smoothstep(.05, .03, abs(c.y - .14 * sin(c.x * 7. + t * 1.5)));
    return mix(vec3(.9, .06, .12), vec3(1.), rib);
  }
  if (k < 2.) {                                           // smiley that bounces on the beat
    vec2 f = c * vec2(1.6, 1.) - vec2(0., .06 * pop);
    float face = step(length(f), .34);
    float eyes = step(length(vec2(abs(f.x) - .11, f.y - .08)), .045);
    float smile = step(abs(length(f + vec2(0., .02)) - .2), .03) * step(f.y, -.04);
    return mix(a * .35, mix(vec3(1., .85, .1), vec3(.08), max(eyes, smile)), face);
  }
  if (k < 3.) {                                           // three candies hopping in turn
    vec3 col = b * .4;
    for (int i = 0; i < 3; i++) {
      float fi = float(i), hop = max(0., sin(t * 6.2832 * .5 + fi * 2.1)) * .12;
      vec2 o = c * vec2(1.6, 1.) - vec2((fi - 1.) * .42, -.05 + hop);
      col = mix(col, poster(fi * .17 + .1), step(length(o), .17));
      col = mix(col, vec3(1.), step(length(o - vec2(-.05, .05)), .04));
    }
    return col;
  }
  if (k < 4.) {                                           // starburst
    float ang = atan(c.y, c.x), r = length(c * vec2(1.6, 1.));
    return mix(a, b, step(r, .22 + .08 * sign(sin(ang * 9. + t)) + .05 * pop));
  }
  if (k < 5.) {                                           // headline crawl
    vec2 g = vec2(uv.x * 14. + t * 2.5, (uv.y - .35) * 8.);
    float txt = step(0., g.y) * step(g.y, 2.4) * step(.4, hash(floor(g * vec2(1., 2.)) + floor(g.x / 5.))) * step(1., mod(floor(g.x), 5.));
    return mix(a, vec3(1.), txt);
  }
  return mix(a, b, step(.5, fract((uv.x - uv.y * .5) * 4. - t * .5)));            // stripes
}
vec3 adCycle(vec2 uv, float k, float s){
  float clk = t * .1 + k * 7.31, ph = fract(clk), gen = floor(clk);
  vec3 c = ad(uv, fract(k + gen * .618), fract(s + gen * .382));
  return mix(c, vec3(1.), step(uv.x, ph * 25.) * step(ph * 25. - .25, uv.x) * step(ph, .04));
}
vec3 shade(vec3 q, vec3 rd, float d){
  vec3 n = normal_mapT(q, .002 + .001 * d);
  float w = .03 + d * .0022;
  float lam = dot(n, KEY), cel = lam > .3 ? 1. : lam > -.2 ? .82 : .66;
  vec3 INK = vec3(.04, .03, .08);
  float pop = pow(1. - beat, 3.);
  if (ball(q) < .03) return mix(vec3(.75, .85, 1.), vec3(1.), pop) * (.8 + .2 * step(.5, fract(atan(q.z - 44., q.x) * 3. + q.y * 4.)));
  if (q.y < .015 + .0015 * d) {                           // plaza pavers, avenue, crosswalk
    vec3 m = q.z < 32. ? vec3(.62, .58, .66) : vec3(.3, .29, .36);
    vec2 g = fract(q.xz * .8);
    m *= q.z < 32. ? .92 + .08 * step(.08, min(g.x, g.y)) : 1.;
    m = mix(m, vec3(.95), step(.5, fract(q.x * 1.1)) * step(31.6, q.z) * step(q.z, 32.6));
    m = mix(m, vec3(1., .8, .1), step(abs(q.z - 34.8), .06) * step(.5, fract(q.x * .3)));
    return m * cel;
  }
  if (people(q) < .03) {
    vec2 id = floor(q.xz / 1.3);
    vec3 m = q.y > .7 ? vec3(.95, .75, .6) * (.6 + .4 * hash(id + 9.)) : poster(hash(id + 4.));
    return mix(m * cel, INK, step(abs(dot(n, rd)), .35));
  }
  if (cab(q) < .03) {
    vec3 cq = cabQ(q), m = cq.y > .7 && abs(n.y) < .5 ? vec3(.15, .25, .45) : vec3(1., .78, .05);
    m = mix(m, INK, step(abs(cq.y - .5), .04) * step(.5, fract(cq.x * 4.)));
    float e = max(boxEdge(cq - vec3(0., .45, 0.), vec3(1.08, .33, .58), w), boxEdge(cq - vec3(-.1, .82, 0.), vec3(.61, .22, .46), w));
    return mix(m * cel, INK, e);
  }
  if (tower(q) < .03) {                                   // One Times Square: stacked screens
    if (q.y > 11.) return vec3(.85) * cel;
    if (boxEdge(q - vec3(0., 5.5, 44.), vec3(2.2, 5.5, 2.6), w) > .5) return INK;
    float u = abs(n.z) > .5 ? (q.x + 2.2) / 4.4 : (q.z - 41.4) / 5.2;
    float row = floor(q.y / 2.2), v = fract(q.y / 2.2);
    if (v < .08 || u < .05 || u > .95) return mix(vec3(.25, .22, .35) * cel, INK, step(v, .04));
    return adCycle(vec2(u, (v - .08) / .92), hash(vec2(row, 3.)), hash(vec2(row, 5.)));
  }
  if (backdrop(q) < .03) {                                // towers behind, windows lit
    float id = floor(q.x / 6.);
    vec3 m = mix(vec3(.18, .2, .42), vec3(.32, .22, .48), hash(vec2(id, 1.)));
    vec2 g = vec2((abs(n.x) > .5 ? q.z : q.x) * 1.4, q.y * 1.1), f = fract(g);
    float win = step(.3, f.x) * step(f.x, .7) * step(.25, f.y) * step(f.y, .75) * step(.4, hash(floor(g) + id));
    return mix(m * cel, vec3(1., .85, .4), win * (1. - aaFade(d, .7)) + .25 * aaFade(d, .7));
  }
  // flanking blocks: shop level, then one or two giant ads, windows above
  float side = sign(q.x), id = floor(q.z / 9.) + side * 31., H = flankH(id), lz = mod(q.z, 9.);
  vec3 base = mix(vec3(.28, .2, .42), vec3(.45, .2, .3), hash(vec2(id, 8.)));
  if (min(lz, 9. - lz) < w * 1.4 || H - q.y < w * 1.4 || abs(n.y) > .5) return abs(n.y) > .5 ? base * .7 : INK;
  if (q.y < 2.6) {
    if (q.y > 2.1) return mix(poster(hash(vec2(id, 3.))), vec3(1.), step(.5, fract(lz * 1.5))) * cel;
    return mix(base * .5, vec3(1., .88, .55), step(.15, fract(lz * .5)) * step(.3, q.y) * step(q.y, 1.9) * .85);
  }
  float top = H - 2.5, rows = 1. + step(.5, hash(vec2(id, 5.)));
  if (q.y > top) {
    vec2 g = vec2(lz * 1.2, q.y * .9), f = fract(g);
    float win = step(.25, f.x) * step(f.x, .75) * step(.2, f.y) * step(f.y, .8) * step(.4, hash(floor(g) + id));
    return mix(base * cel, vec3(1., .88, .45), win);
  }
  vec2 uv = vec2(lz / 9., (q.y - 2.6) / (top - 2.6)) * vec2(1., rows);
  vec2 f = fract(uv), cell = floor(uv);
  float frame = min(min(f.x, 1. - f.x) * 9., min(f.y, 1. - f.y) * (top - 2.6) / rows);
  if (frame < .35) return mix(vec3(.85, .85, .9) * cel, INK, step(frame, .12));
  vec2 bu = (f - vec2(.04, .04 * rows)) / (1. - vec2(.08, .08 * rows));
  return adCycle(bu, hash(cell + id * 2.7), hash(cell + id * 1.3));
}`, `
  vec3 ro = vec3(.4 * sin(t * .01), 3., -2.);
  vec3 rd = view(p, 1.05);
  rd.yz = rot(.1) * rd.yz;
  float d = marchInk(ro, rd, 120.);
  vec3 sky = mix(vec3(.32, .16, .42), vec3(.06, .05, .2), smoothstep(0., .5, rd.y));
  if (d < 120.) col = shade(ro + rd * d, rd, d);
  else col = sky + vec3(.9) * stars(rd, 110.) * smoothstep(.2, .5, rd.y) * .6;
  col = mix(col, vec3(.04, .03, .08), step(graze, .0035) * step(120., d));           // silhouette ink
  col = mix(col, sky, (1. - exp(-min(d, 120.) * .004)) * step(d, 120.));
  col *= .55 + .45 * smoothstep(-.15, .18, p.y);          // quieter behind the decks
`, { raw: true }),

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
