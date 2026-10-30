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
  float drift = fbm(vec2(x * 1.6, t * .15)) * 1.6;
  float s1 = fbm(vec2(x * 7., fy * 1.4 - t * 1.4 + drift));
  float s2 = fbm(vec2(x * 18., fy * 3. - t * 2.6));
  vec3 w = mix(vec3(.03, .3, .34), vec3(.1, .58, .62), smoothstep(.3, .72, s1));
  w = mix(w, vec3(.5, .88, .88), smoothstep(.55, .9, s2) * .7);
  w = mix(w, vec3(.95, .99, .99), smoothstep(.0, .55, fy) * smoothstep(.42, .78, s1) * .85);
  w += vec3(.4, .45, .45) * exp(-pow((y - lip) * 30., 2.));
  col = mix(col, w, smoothstep(lip - .008, lip + .008, y));
  float b1 = fbm(vec2(x * 3.2 + t * .12, y * 2.6 + t * .8));
  float b2 = fbm(vec2(x * 8. - t * .25, y * 5. + t * 1.4));
  col = mix(col, mix(vec3(.72, .88, .88), vec3(1.), b2), smoothstep(.5, .95, y + (b1 - .5) * .55) * .95);
  float mist = .12 + .22 * fbm(vec2(x * 1.2 - t * .08, y * 1.8 - t * .15));
  col = mix(col, vec3(.96, 1., 1.), mist * smoothstep(.1, 1., y) * .6);
`),

  // The ISS drifting over Earth's limb.
  space: SCENE_MAIN(`
  col = vec3(.008, .012, .035);
  col += vec3(.9, .95, 1.) * stars(vec2(x, y) * 26., .06, t);
  col += vec3(.8, .85, 1.) * stars(vec2(x, y) * 55. + 9., .05, t * 1.3) * .6;
  // Earth: a huge circle whose limb arcs across the lower band
  vec2 c = vec2(A * .5, 7.6); float r = 6.95, d = length(vec2(x, y) - c) - r;
  if (d < 0.) {
    vec2 q = vec2(x * .9 + t * .015, y * 3.);
    vec3 ocean = mix(vec3(.02, .1, .3), vec3(.05, .28, .55), fbm(q * .8));
    float land = smoothstep(.56, .6, fbm(q * .45 + 4.));
    vec3 e = mix(ocean, mix(vec3(.18, .3, .12), vec3(.45, .38, .22), fbm(q * 3.)), land);
    e = mix(e, vec3(.97), smoothstep(.48, .78, fbm(q * 1.6 + vec2(t * .01, 0.))) * .9);
    float day = smoothstep(.05, .55, uv.x);                     // terminator: night on the left
    vec3 lights = vec3(1., .75, .4) * step(.83, hash(floor(vec2(x, y) * 90.))) * land * (1. - day) * .7;
    col = e * (.08 + .92 * day) + lights;
  }
  col += vec3(.3, .6, 1.) * exp(-abs(d) * 22.) * (.25 + .75 * smoothstep(0., .5, uv.x));  // atmosphere
  // The station, drifting left to right
  vec2 p = vec2(x - (fract(t * .006) * (A + 6.) - 3.), y - .36);
  float a = .06 * sin(t * .07); p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p;
  float s = 1.6; p *= s;
  float truss = fill(box(p, vec2(.95, .012)));
  float mods = max(fill(box(p - vec2(0., .035), vec2(.2, .028))), fill(box(p - vec2(.05, -.03), vec2(.035, .07))));
  float arrays = 0.; float grid = 0.;
  for (int i = 0; i < 4; i++) {
    float sx = (i < 2 ? -1. : 1.) * (i == 0 || i == 3 ? .8 : .52);
    for (int j = 0; j < 2; j++) {
      vec2 pp = p - vec2(sx, j == 0 ? .1 : -.1);
      float m = fill(box(pp, vec2(.11, .085)));
      arrays = max(arrays, m);
      grid = max(grid, m * max(step(.88, fract(pp.x * 36.)), step(.8, fract(pp.y * 9.))));
    }
  }
  float rad = fill(box(p - vec2(.3, -.06), vec2(.05, .03)));
  vec3 gold = mix(vec3(.55, .38, .12), vec3(.95, .75, .35), .5 + .5 * sin(p.x * 3. + t * .3));
  col = mix(col, gold, arrays); col = mix(col, vec3(.25, .18, .08), grid * .7);
  col = mix(col, vec3(.82, .84, .88), max(max(truss, mods), rad));
  col += vec3(1., .95, .8) * exp(-length(p - vec2(.52, .1)) * 14.) * (.4 + .4 * sin(t * .5));   // sun glint
`),

  // Layered canopy, mist, light shafts and rain.
  rainforest: SCENE_MAIN(`
  col = mix(vec3(.78, .86, .74), vec3(.55, .68, .52), y);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float top = .18 + fi * .17 - .16 * fbm(vec2(x * (1.2 + fi * .7) + fi * 7., fi)) - .05 * abs(sin(x * (2.2 + fi)));
    vec3 g = mix(vec3(.28, .45, .3), vec3(.04, .16, .07), fi / 3.);
    g *= .8 + .4 * fbm(vec2(x * 8., y * 6.) + fi);
    col = mix(col, g, smoothstep(top, top + .01, y));
    col = mix(col, vec3(.78, .86, .76), (.25 - fi * .05) * smoothstep(top + .15, top, y) * smoothstep(top - .2, top, y));   // mist between layers
  }
  col += vec3(.9, 1., .75) * pow(max(0., sin((x * .35 + y * .9) * 7. + fbm(vec2(x, t * .05)) * 3.)), 14.) * (1. - y) * .22;
  vec2 rp = vec2(x * 70., y * 3. + t * 6.);
  float id = floor(rp.x), drop = step(.82, hash1(id)) * smoothstep(.0, .06, fract(rp.y + hash1(id) * 9.)) * smoothstep(.22, .06, fract(rp.y + hash1(id) * 9.));
  col = mix(col, vec3(.92, .97, .95), drop * .35);
`),

  // Alps: a Matterhorn-like peak range, meadows, chalets and a lake.
  alps: SCENE_MAIN(`
  col = mix(vec3(.3, .55, .88), vec3(.8, .89, .97), y * 1.5);
  col = mix(col, vec3(1.), smoothstep(.55, .82, fbm(vec2(x * .5 - t * .03, y * 3.))) * (1. - y) * .85);
  float lake = .8;
  float yy = y > lake ? 2. * lake - y + .005 * sin(x * 40. + t * 2.) : y;
  vec3 m = mix(vec3(.3, .55, .88), vec3(.8, .89, .97), yy * 1.5);
  // a far range, hazy
  float far = .36 + .1 * abs(sin(x * 1.3)) + .08 * fbm(vec2(x * 1.5, 3.));
  m = mix(m, mix(vec3(.7, .76, .86), vec3(.93, .96, 1.), smoothstep(far + .08, far, yy)), smoothstep(far, far + .006, yy) * .8);
  // sharp peaks: a tall Matterhorn-like horn every 7 units, lower ridges between
  float px = mod(x, 7.) - 3.5;
  float horn = .1 + .62 * pow(abs(px) / 3.5, .75) + .04 * fbm(vec2(x * 3., 1.));
  float ridge = .32 + .12 * abs(sin(x * 2.1 + 1.)) + .06 * fbm(vec2(x * 4., 5.));
  float top = min(horn, ridge);
  float rock = smoothstep(top, top + .006, yy);
  vec3 face = mix(vec3(.42, .44, .5), vec3(.24, .26, .31), smoothstep(0., 1., fbm(vec2(x * 5., yy * 10.))) * step(0., px) + .2);   // shaded east faces
  float snow = smoothstep(top + .16, top + .05, yy) * smoothstep(.3, .6, fbm(vec2(x * 7., yy * 5.)) + .3 * (1. - (yy - top) * 6.));
  face = mix(face, vec3(.97, .98, 1.), clamp(snow, 0., 1.));
  m = mix(m, face, rock);
  float hill = .62 + .04 * sin(x * .9) + .04 * fbm(vec2(x * 1.4, 7.));
  m = mix(m, mix(vec3(.4, .66, .26), vec3(.24, .48, .17), fbm(vec2(x * 4., yy * 7.))), smoothstep(hill, hill + .006, yy));
  vec2 ch = vec2(mod(x, 9.) - 4.5, yy - hill - .06);
  float body = fill(box(ch, vec2(.1, .045)));
  float roof = fill(max(abs(ch.x) * .5 + ch.y + .045 - .055, -(ch.y + .045)));
  float win = fill(box(vec2(abs(ch.x) - .045, ch.y + .005), vec2(.018, .014)));
  m = mix(m, vec3(.5, .3, .16), body); m = mix(m, vec3(.28, .13, .08), roof); m = mix(m, vec3(1., .84, .5), win * body);
  col = y > lake ? mix(m * vec3(.72, .84, .95), vec3(.2, .42, .62), .3) : m;
  col = mix(col, vec3(.92, .96, 1.), smoothstep(.005, 0., abs(y - lake)) * .7);
`),

  // Hakone: a vermilion torii in the lake, forested hills and Mt Fuji.
  hakone: SCENE_MAIN(`
  float lake = .66;
  float yy = y > lake ? 2. * lake - y + .005 * sin(x * 30. + t * 1.6) : y;
  vec3 s = mix(vec3(.98, .82, .7), vec3(.6, .75, .9), pow(1. - yy, 1.5));
  float fx = mod(x, 14.) - 9.;
  float fuji = .3 + abs(fx) * .085; fuji = max(fuji, .3);
  s = mix(s, mix(vec3(.55, .6, .75), vec3(.97, .97, 1.), smoothstep(.42, .38, yy)), smoothstep(fuji, fuji + .006, yy) * step(abs(fx), 4.2));
  float hill = .46 + .08 * sin(x * .7 + 2.) - .1 * fbm(vec2(x * 1.6, 2.));
  s = mix(s, mix(vec3(.12, .28, .2), vec3(.06, .16, .12), fbm(vec2(x * 7., yy * 6.))), smoothstep(hill, hill + .01, yy));
  vec2 g = vec2(mod(x, 10.) - 5., yy);
  float pillars = fill(box(vec2(abs(g.x) - .26, g.y - .55), vec2(.022, .23)));
  float kasagi = fill(box(vec2(g.x, g.y - .27 + .03 * pow(abs(g.x) / .45, 2.)), vec2(.46, .022)));
  float cap = fill(box(vec2(g.x, g.y - .25 + .03 * pow(abs(g.x) / .45, 2.)), vec2(.47, .01)));
  float nuki = fill(box(vec2(g.x, g.y - .37), vec2(.36, .014)));
  float post = fill(box(vec2(g.x, g.y - .32), vec2(.02, .04)));
  vec3 red = vec3(.82, .17, .1);
  s = mix(s, red, max(max(pillars, kasagi), max(nuki, post))); s = mix(s, vec3(.08), cap);
  col = y > lake ? mix(s * .82, vec3(.25, .42, .5), .3) : s;
  col = mix(col, vec3(.97, .95, .93), (.15 + .25 * fbm(vec2(x * .8 - t * .05, y * 2.))) * smoothstep(.45, .75, y) * (1. - smoothstep(.75, .95, y)));
`),

  // Wulong: a deep gorge spanned by natural stone bridges, mist and a jade river.
  wulong: SCENE_MAIN(`
  // Looking along a deep gorge: sheer walls, and thin natural stone arches spanning it.
  col = mix(vec3(.95, .96, .92), vec3(.78, .84, .8), y);
  for (int i = 0; i < 2; i++) {
    float fi = float(i), haze = .5 - fi * .45;
    float seg = 4.2 + fi * 1.9, hs = seg * .5;
    float sx = x + fi * 5.3, bx = mod(sx, seg) - hs;
    float gap = hs * .58 + .12 * sin(y * 9. + fi * 2.) + .18 * fbm(vec2(y * 6., fi * 3. + floor(sx / seg)));
    float wallTop = .02 + .05 * fbm(vec2(sx * 2., fi));
    float wall = step(gap, abs(bx)) * step(wallTop, y);
    float bTop = .1 + fi * .05 + .02 * fbm(vec2(sx * 3., 5.));
    float bUnder = bTop + .07 + .3 * pow(clamp(abs(bx) / gap, 0., 1.), 2.4);
    float hasBridge = step(.35, hash1(floor(sx / seg) + fi * 11.));
    float bridge = hasBridge * step(bTop, y) * step(y, bUnder) * step(abs(bx), gap);
    float rock = max(wall, bridge);
    vec3 rc = mix(vec3(.68, .6, .49), vec3(.42, .37, .3), fbm(vec2(sx * 16., y * 1.4) + fi));          // vertical striations
    rc *= .85 + .3 * smoothstep(.0, 1.5, abs(bx) - gap);                                                  // walls darken going in
    float veg = smoothstep(.56, .7, fbm(vec2(sx * 5., y * 4.) + fi * 2.)) * wall
              + smoothstep(bTop + .035, bTop, y) * max(bridge, wall);
    rc = mix(rc, mix(vec3(.22, .4, .18), vec3(.38, .56, .26), fbm(vec2(sx * 12., y * 12.))), clamp(veg, 0., 1.) * .85);
    col = mix(col, mix(rc, vec3(.9, .93, .9), haze), rock);
  }
  float river = .88;
  col = mix(col, mix(vec3(.18, .46, .4), vec3(.4, .66, .56), fbm(vec2(x * 3. - t * .3, y * 25.))), smoothstep(river, river + .008, y));
  col = mix(col, vec3(.96), (.06 + .28 * fbm(vec2(x * .6 + t * .04, y * 2.5))) * smoothstep(.3, .9, y) * .8);
`),

  // Chongqing at night: layered skyline on the hills, LED facades, a cable car, river lights.
  chongqing: SCENE_MAIN(`
  // Night megacity climbing the hills, with the river reflecting it.
  float river = .8;
  bool water = y > river;
  float yy = water ? 2. * river - y : y;
  float wob = water ? .012 * sin(y * 90. + t * 3.) + .006 * sin(x * 7. + t) : 0.;
  float xx = x + wob;
  vec3 s = mix(vec3(.22, .07, .3), vec3(.03, .02, .09), pow(1. - yy, 1.4));
  s += vec3(.8, .35, .55) * .22 * smoothstep(.25, .8, yy);
  float hills = .42 + .1 * sin(xx * .35) + .06 * fbm(vec2(xx * .8, 2.));
  s = mix(s, vec3(.07, .04, .12), smoothstep(hills, hills + .01, yy));
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float w = .22 + .1 * hash1(floor(xx / .3 + fi * 31.)) - fi * .03;
    float id = floor(xx / w + fi * 17.), lx = fract(xx / w + fi * 17.);
    float hgt = hills - .05 - .32 * pow(hash1(id + fi * 7.), 1.6) + fi * .07;
    float tower = step(.12, lx) * step(lx, .88) * step(hgt, yy);
    float spire = step(abs(lx - .5), .03) * step(hgt - .06, yy) * step(.75, hash1(id * 2.3));
    vec2 wc = vec2(lx * 7., yy * 70.);
    float on = step(.55, hash(floor(wc) + id + fi)) * step(.3, fract(wc.x)) * step(.35, fract(wc.y));
    float flick = .75 + .25 * sin(t * .5 + hash(floor(wc)) * 20.);
    vec3 wcol = mix(vec3(1., .8, .5), vec3(.6, .85, 1.), step(.65, hash(vec2(id, fi))));
    vec3 bc = vec3(.05, .04, .1) * (1. + fi * .4) + wcol * on * flick * (.45 + fi * .2);
    float led = step(.88, hash1(id * 3.7 + fi));                                          // a few LED facades
    vec3 ledc = mix(vec3(1., .2, .65), vec3(.2, .85, 1.), .5 + .5 * sin(yy * 30. - t * 2. + id));
    bc = mix(bc, ledc * (.6 + .4 * beat), led * .75);
    bc += vec3(1., .3, .75) * smoothstep(.004, 0., abs(yy - hgt)) * step(.7, hash1(id + 9.));   // neon roof lines
    s = mix(s, bc, max(tower, spire));
  }
  float cx = fract(t * .015) * (A + 2.) - 1.;
  float cable = .27 + .03 * sin(xx * .3);
  s += vec3(.7, .7, .8) * smoothstep(.003, 0., abs(yy - cable)) * .5;
  s = mix(s, vec3(.9, .15, .15), fill(box(vec2(xx - cx, yy - cable - .03), vec2(.07, .03))));
  col = water ? s * vec3(.55, .6, .8) * (.75 + .25 * noise(vec2(x * 3., y * 60. - t))) : s;
  col = mix(col, vec3(.02, .02, .06), water ? .25 : 0.);
`),

  // Times Square: billboards cycling on the beat, an LED ticker and taxis.
  timessquare: SCENE_MAIN(`
  // Dense towers wrapped in billboards, an LED ticker, taxis streaming below.
  col = mix(vec3(.18, .08, .26), vec3(.06, .04, .12), 1. - y);
  float street = .86;
  for (int i = 0; i < 2; i++) {
    float fi = float(i);
    float w = .6 + .5 * hash1(floor(x / .8 + fi * 9.)) - fi * .15;
    float id = floor(x / w + fi * 23.), lx = fract(x / w + fi * 23.);
    float top = .02 + .18 * hash1(id + fi) - fi * .01;
    float inb = step(top, y) * step(.02, lx) * step(lx, .98);
    vec3 bc = mix(vec3(.07, .06, .1), vec3(.12, .1, .16), fi);
    bc += vec3(.9, .8, .6) * .25 * step(.6, hash(floor(vec2(lx * 10., y * 50.)) + id)) * step(.4, fract(lx * 10.)) * step(.5, fract(y * 50.));
    col = mix(col, bc, inb);
    for (int k = 0; k < 3; k++) {
      float fk = float(k), h = hash1(id * 3.3 + fk * 1.7 + fi);
      if (h < .25) continue;
      vec2 c = vec2(.5 + (hash1(id + fk * 4.) - .5) * .3, top + .1 + fk * .22 + .05 * h);
      vec2 bs = vec2(.18 + .28 * hash1(id * 1.9 + fk), .04 + .07 * hash1(id + fk * 2.2));
      vec2 q = vec2(lx - c.x, y - c.y);
      float bb = fill(box(q * vec2(w, 1.), bs * vec2(w, 1.))) * inb;
      float hue = hash1(id * 7. + fk) + floor(t * .5 + h * 4.) * .23;
      vec3 cc = .55 + .45 * cos(6.28 * (hue + vec3(0., .33, .67)));
      float pat = floor(h * 4.);
      vec3 content = pat < 1. ? mix(cc, cc.zxy, smoothstep(-bs.x, bs.x, q.x + .1 * sin(t * 2.)))
                   : pat < 2. ? cc * (.55 + .45 * step(.5, fract(q.x * 14. / w - t * 1.5)))
                   : pat < 3. ? mix(cc * .4, vec3(1.), smoothstep(.5, .0, length(q / bs) - .3 * beat))
                   : cc * (.7 + .3 * sin(q.y * 80. + t * 4.));
      col = mix(col, content * 1.15, bb);
      col += cc * .3 * exp(-max(box(q, bs), 0.) * 25.) * inb;
    }
  }
  float tick = smoothstep(.014, .0, abs(y - .78)) * step(.45, fract(x * 5. - t * 1.2)) * step(.25, hash1(floor(x * 5. - t * 1.2)));
  col = mix(col, vec3(1., .35, .2), tick * .9);
  col = mix(col, vec3(.07, .06, .08), step(street, y));
  for (int j = 0; j < 2; j++) {
    float fj = float(j), dir = fj < .5 ? 1. : -1.;
    vec2 tp = vec2(fract((x + dir * t * (.7 + fj * .3) + fj * .9) / 1.9) * 1.9 - .95, y - (.9 + fj * .05));
    float taxi = fill(box(tp, vec2(.12, .022))) * step(street, y);
    col = mix(col, vec3(.98, .78, .1), taxi);
    col += vec3(1., .92, .7) * exp(-length(tp - vec2(.13 * dir, 0.)) * 28.) * step(street, y);
  }
  col += vec3(.5, .3, .6) * .18 * smoothstep(.95, .75, y);
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
