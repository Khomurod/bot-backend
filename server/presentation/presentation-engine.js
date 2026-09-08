'use strict';

/*
 * Wenze Operations Hub product page — the rendering engine.
 *
 * The map projection, the generated world SVG, the Map3 instance and the
 * marker/route primitives the scenes draw with. Extracted from
 * presentation.js when it passed the repository's 500-line limit, along a real
 * seam: nothing in here knows anything about a scene, and the split was
 * verified in Chromium against the live page.
 *
 * The scene choreography is in presentation-scenes.js, which reads what it
 * needs off the namespace exposed at the bottom of this file. Load order
 * matters and the page's script tags encode it.
 */

window.WZL_PRES = (function(){

var NS='http://www.w3.org/2000/svg';
var MQ=window.matchMedia('(prefers-reduced-motion: reduce)');
var reduced=MQ.matches;
try{MQ.addEventListener('change',function(e){reduced=e.matches;});}catch(e){}
var clamp=function(v,a,b){return v<a?a:(v>b?b:v);};
var lerp=function(a,b,t){return a+(b-a)*t;};
var ease=function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;};
var $=function(s,r){return (r||document).querySelector(s);};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
function el(n,a){var e=document.createElementNS(NS,n);for(var k in a)e.setAttribute(k,a[k]);return e;}

/* ─────────── world geography ─────────── */
var W=4400,H=2600;
function rng(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;var t=Math.imul(seed^seed>>>15,1|seed);
  t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}

/* ── real geography ──────────────────────────────────────
   Actual lat/lon, Mercator-projected onto the world canvas.
   Corridor follows I-24 (Chattanooga→Nashville) then I-65 (Nashville→Louisville). */
var GEO_CITIES=[
  {n:'Chattanooga',  la:35.0456,lo:-85.3097,t:1},
  {n:'Manchester',   la:35.4817,lo:-86.0886,t:0},
  {n:'Murfreesboro', la:35.8456,lo:-86.3903,t:0},
  {n:'Nashville',    la:36.1627,lo:-86.7816,t:1},
  {n:'Clarksville',  la:36.5298,lo:-87.3595,t:0},
  {n:'Cookeville',   la:36.1628,lo:-85.5016,t:0},
  {n:'Bowling Green',la:36.9903,lo:-86.4436,t:0},
  {n:'Somerset',     la:37.0920,lo:-84.6041,t:0},
  {n:'Elizabethtown',la:37.6939,lo:-85.8591,t:0},
  {n:'Huntsville',   la:34.7304,lo:-86.5861,t:0},
  {n:'Louisville',   la:38.2527,lo:-85.7585,t:1}
];
var CORRIDOR=[
  [35.0456,-85.3097],[35.0730,-85.6250],[35.2431,-85.8383],[35.4817,-86.0886],
  [35.8456,-86.3903],[36.1627,-86.7816],[36.4695,-86.6519],[36.7226,-86.5772],
  [36.9903,-86.4436],[37.2739,-85.8908],[37.6939,-85.8591],[37.9884,-85.7158],
  [38.2527,-85.7585]
];
/* off-route excursion: leaves I-65 near Munfordville, loops east, rejoins before Elizabethtown */
var DETOUR=[[37.3320,-85.6100],[37.4450,-85.4520],[37.5760,-85.5480],[37.6350,-85.7450]];

var PROJ=(function(){
  function my(la){var p=la*Math.PI/180;return Math.log(Math.tan(Math.PI/4+p/2));}
  var las=[],los=[];
  GEO_CITIES.forEach(function(c){las.push(c.la);los.push(c.lo);});
  CORRIDOR.concat(DETOUR).forEach(function(p){las.push(p[0]);los.push(p[1]);});
  var laMin=Math.min.apply(null,las),laMax=Math.max.apply(null,las);
  var loMin=Math.min.apply(null,los),loMax=Math.max.apply(null,los);
  var padLo=(loMax-loMin)*0.17,padLa=(laMax-laMin)*0.13;
  loMin-=padLo;loMax+=padLo;laMin-=padLa;laMax+=padLa;
  var y0=my(laMin),y1=my(laMax);
  var k=Math.min(W/(loMax-loMin),H/(y1-y0));
  var ox=(W-(loMax-loMin)*k)/2,oy=(H-(y1-y0)*k)/2;
  return function(la,lo){return {x:ox+(lo-loMin)*k,y:H-oy-(my(la)-y0)*k};};
})();

function smoothPath(pts){
  if(pts.length<2)return '';
  var d='M '+pts[0].x.toFixed(1)+' '+pts[0].y.toFixed(1);
  for(var i=0;i<pts.length-1;i++){
    var p0=pts[i-1]||pts[i],p1=pts[i],p2=pts[i+1],p3=pts[i+2]||pts[i+1];
    d+=' C '+(p1.x+(p2.x-p0.x)/6).toFixed(1)+' '+(p1.y+(p2.y-p0.y)/6).toFixed(1)+
       ' '+(p2.x-(p3.x-p1.x)/6).toFixed(1)+' '+(p2.y-(p3.y-p1.y)/6).toFixed(1)+
       ' '+p2.x.toFixed(1)+' '+p2.y.toFixed(1);
  }
  return d;
}
function P2(p){return PROJ(p[0],p[1]);}

var PLANNED=smoothPath(CORRIDOR.map(P2));
var ACTUAL=(function(){
  var pts=CORRIDOR.slice(0,10).map(P2);
  DETOUR.forEach(function(p){pts.push(P2(p));});
  for(var j=10;j<CORRIDOR.length;j++)pts.push(P2(CORRIDOR[j]));
  return smoothPath(pts);
})();

var CITIES=GEO_CITIES.map(function(c){var p=PROJ(c.la,c.lo);return {x:p.x,y:p.y,n:c.n,t:c.t};});
var ORIGIN=P2(CORRIDOR[0]),DEST=P2(CORRIDOR[CORRIDOR.length-1]);
var STATION=PROJ(37.6939,-85.8591);


var WORLD=null;
function world(){ if(!WORLD) WORLD=buildWorld(7); return WORLD.cloneNode(true); }

function buildWorld(seed){
  var r=rng(seed),g=el('g',{}),f=function(n){return n.toFixed(0);};
  var X0=-500,Y0=-500,X1=W+500,Y1=H+500;

  var defs=el('defs',{});
  var cg=el('radialGradient',{id:'city-glow'});
  cg.appendChild(el('stop',{offset:'0','stop-color':'#9CC0F0','stop-opacity':'.20'}));
  cg.appendChild(el('stop',{offset:'.55','stop-color':'#7FA8DE','stop-opacity':'.07'}));
  cg.appendChild(el('stop',{offset:'1','stop-color':'#7FA8DE','stop-opacity':'0'}));
  defs.appendChild(cg);
  g.appendChild(defs);

  /* ── water ── */
  var wat=el('g',{});
  wat.appendChild(el('path',{d:'M -500 1660 C 300 1560 780 1760 1260 1670 C 1740 1580 2020 1380 2520 1430 '+
    'C 3020 1480 3380 1300 3900 1360 C 4300 1406 4600 1360 4900 1340 L 4900 1500 C 4600 1524 4300 1512 3900 1540 '+
    'C 3380 1578 3060 1636 2560 1610 C 2040 1583 1760 1740 1280 1806 C 820 1869 300 1810 -500 1800 Z',
    fill:'#0A1524'}));
  wat.appendChild(el('ellipse',{cx:'760',cy:'520',rx:'340',ry:'156',fill:'#0A1524',transform:'rotate(-14 760 520)'}));
  wat.appendChild(el('ellipse',{cx:'3840',cy:'2060',rx:'290',ry:'128',fill:'#0A1524',transform:'rotate(9 3840 2060)'}));
  g.appendChild(wat);

  /* ── terrain relief ── */
  var ter=el('g',{fill:'none',stroke:'rgba(150,184,228,.05)','stroke-width':'1.8'});
  for(var c=0;c<34;c++){
    var tx=X0+r()*(X1-X0),ty=Y0+r()*(Y1-Y0),rx=200+r()*440,ry=100+r()*210,rot=r()*180;
    ter.appendChild(el('ellipse',{cx:f(tx),cy:f(ty),rx:f(rx),ry:f(ry),
      transform:'rotate('+rot.toFixed(1)+' '+f(tx)+' '+f(ty)+')'}));
  }
  g.appendChild(ter);

  /* ── city glow (under the roads) ── */
  var glow=el('g',{});
  CITIES.forEach(function(ct){
    var rr=ct.t?520:280;
    glow.appendChild(el('circle',{cx:ct.x,cy:ct.y,r:rr,fill:'url(#city-glow)'}));
  });
  g.appendChild(glow);

  /* ── road lattice ── */
  var step=132;
  var cols=Math.ceil((X1-X0)/step),rows=Math.ceil((Y1-Y0)/step);
  var P=[];
  for(var i=0;i<=rows;i++){
    P[i]=[];
    for(var j=0;j<=cols;j++){
      P[i][j]={x:X0+j*step+(r()-.5)*step*.7,y:Y0+i*step+(r()-.5)*step*.7};
    }
  }
  function cityPull(p){
    // bend the lattice gently toward city centres so roads converge on towns
    for(var k=0;k<CITIES.length;k++){
      var ct=CITIES[k],dx=ct.x-p.x,dy=ct.y-p.y,d=Math.sqrt(dx*dx+dy*dy),R=ct.t?620:340;
      if(d<R&&d>1){var f2=(1-d/R)*(ct.t?.30:.20);p.x+=dx*f2;p.y+=dy*f2;}
    }
    return p;
  }
  for(i=0;i<=rows;i++)for(j=0;j<=cols;j++)cityPull(P[i][j]);

  function chain(get,n,gapRate){
    var d='',open=false,prev=null;
    for(var q=0;q<=n;q++){
      if(r()<gapRate){open=false;prev=null;continue;}
      var p=get(q);
      if(!open){d+='M'+f(p.x)+' '+f(p.y);open=true;}
      else{
        var mx=(prev.x+p.x)/2+(r()-.5)*26,my=(prev.y+p.y)/2+(r()-.5)*26;
        d+='Q'+f(mx)+' '+f(my)+' '+f(p.x)+' '+f(p.y);
      }
      prev=p;
    }
    return d;
  }
  var minorD='',artD='';
  for(i=0;i<=rows;i++){
    var dd=chain(function(j){return P[i][j];},cols,.14);
    if(i%5===2)artD+=dd;else minorD+=dd;
  }
  for(j=0;j<=cols;j++){
    (function(jj){
      var dd=chain(function(i2){return P[i2][jj];},rows,.16);
      if(jj%5===3)artD+=dd;else minorD+=dd;
    })(j);
  }
  g.appendChild(el('path',{d:minorD,fill:'none',stroke:'rgba(158,190,232,.10)','stroke-width':'1.5',
    'stroke-linecap':'round','stroke-linejoin':'round'}));
  g.appendChild(el('path',{d:artD,fill:'none',stroke:'rgba(186,212,242,.20)','stroke-width':'2.8',
    'stroke-linecap':'round','stroke-linejoin':'round'}));

  /* ── dense street grids inside towns ── */
  var townD='';
  CITIES.forEach(function(ct){
    var R=ct.t?310:170,n=ct.t?10:6,base=r()*.6-.3;
    var ca=Math.cos(base),sa=Math.sin(base);
    function rot(px,py){var dx=px-ct.x,dy=py-ct.y;return {x:ct.x+dx*ca-dy*sa,y:ct.y+dx*sa+dy*ca};}
    function span(off){var v=R*R-off*off;return v>0?Math.sqrt(v):0;}
    for(var a=1;a<n;a++){
      var off=-R+ (a/n)*2*R;
      var hx=span(off)*(.82+r()*.18);
      if(hx<24)continue;
      var A=rot(ct.x-hx,ct.y+off+(r()-.5)*14),B=rot(ct.x+hx,ct.y+off+(r()-.5)*14);
      townD+='M'+f(A.x)+' '+f(A.y)+'L'+f(B.x)+' '+f(B.y);
      var hy=span(off)*(.72+r()*.2);
      if(hy<24)continue;
      var C=rot(ct.x+off+(r()-.5)*14,ct.y-hy),D=rot(ct.x+off+(r()-.5)*14,ct.y+hy);
      townD+='M'+f(C.x)+' '+f(C.y)+'L'+f(D.x)+' '+f(D.y);
    }
  });
  g.appendChild(el('path',{d:townD,fill:'none',stroke:'rgba(176,204,240,.15)','stroke-width':'1.6',
    'stroke-linecap':'round'}));

  /* ── interstates ── */
  var hw=[
    'M -500 2460 C 500 2340 1100 2080 1720 1900 C 2340 1720 2960 1420 4900 880',
    'M -500 900 C 400 990 1100 1200 1920 1130 C 2740 1060 3440 810 4900 620',
    'M 520 -500 C 640 600 780 1240 920 3100',
    'M 2260 -500 C 2180 700 2360 1520 2540 3100',
    'M 3560 -500 C 3460 820 3640 1620 3820 3100',
    'M -500 1960 C 600 1890 1620 2010 2660 1900 C 3460 1816 4100 1940 4900 1880'
  ];
  var cas=el('g',{fill:'none',stroke:'#05080E','stroke-width':'13','stroke-linecap':'round'});
  var fil=el('g',{fill:'none',stroke:'rgba(206,226,250,.34)','stroke-width':'5.5','stroke-linecap':'round'});
  hw.forEach(function(d){cas.appendChild(el('path',{d:d}));fil.appendChild(el('path',{d:d}));});
  g.appendChild(cas);g.appendChild(fil);

  return g;
}

/* ─────────── map instance ─────────── */
function Map3(svgId,opts){
  var svg=$('#'+svgId);
  var defs=el('defs',{});
  var glow=el('filter',{id:svgId+'-glow',x:'-60%',y:'-60%',width:'220%',height:'220%'});
  glow.appendChild(el('feGaussianBlur',{stdDeviation:'11',result:'b'}));
  var mg=el('feMerge',{});mg.appendChild(el('feMergeNode',{in:'b'}));mg.appendChild(el('feMergeNode',{in:'SourceGraphic'}));
  glow.appendChild(mg);defs.appendChild(glow);
  svg.appendChild(defs);

  var cam=el('g',{});svg.appendChild(cam);
  cam.appendChild(world());

  var layer=el('g',{});cam.appendChild(layer);   // routes, in world space
  var over=el('g',{});cam.appendChild(over);     // counter-scaled overlays
  var pins=[];

  function addPin(x,y,build){var gg=el('g',{});gg.appendChild(build());over.appendChild(gg);
    pins.push({el:gg,x:x,y:y});return gg;}

  var api={svg:svg,cam:cam,layer:layer,over:over,k:1,
    addPin:addPin,
    cityLabels:function(){
      CITIES.forEach(function(ct){
        addPin(ct.x,ct.y,function(){
          var gg=el('g',{});
          gg.appendChild(el('circle',{cx:0,cy:0,r:ct.t?4:2.6,fill:'rgba(214,230,250,.72)'}));
          var t=el('text',{x:ct.t?12:9,y:4.5,'font-family':'Manrope,sans-serif',
            'font-size':ct.t?13:10.5,'font-weight':ct.t?'600':'500',
            'letter-spacing':ct.t?'.09em':'.06em',
            fill:ct.t?'rgba(226,238,252,.82)':'rgba(198,216,240,.5)'});
          t.textContent=ct.t?ct.n.toUpperCase():ct.n;
          gg.appendChild(t);return gg;
        });
      });
    },
    look:function(x,y,k){
      api.k=k;
      cam.setAttribute('transform','translate('+(800-x*k).toFixed(2)+' '+(450-y*k).toFixed(2)+') scale('+k.toFixed(4)+')');
      var inv=1/k;
      for(var i=0;i<pins.length;i++)
        pins[i].el.setAttribute('transform','translate('+pins[i].x+' '+pins[i].y+') scale('+inv.toFixed(4)+')');
    }
  };
  return api;
}

/* truck marker (top-down, points +x) */
function truckMarker(color,scale){
  var s=scale||1,g=el('g',{});
  g.appendChild(el('ellipse',{cx:0,cy:0,rx:34*s,ry:15*s,fill:color,opacity:'.13'}));
  var b=el('g',{});
  b.appendChild(el('rect',{x:-26*s,y:-8.5*s,width:34*s,height:17*s,rx:3*s,
    fill:'#E7EDF6',stroke:'rgba(9,13,20,.85)','stroke-width':1.2*s}));
  b.appendChild(el('rect',{x:-24*s,y:-6*s,width:6*s,height:12*s,rx:1.5*s,fill:'rgba(9,13,20,.16)'}));
  b.appendChild(el('rect',{x:9*s,y:-9.5*s,width:15*s,height:19*s,rx:3.5*s,
    fill:color,stroke:'rgba(9,13,20,.85)','stroke-width':1.2*s}));
  b.appendChild(el('rect',{x:19*s,y:-6.5*s,width:4.5*s,height:13*s,rx:1.6*s,fill:'rgba(255,255,255,.5)'}));
  [-19,-11,11].forEach(function(px){
    b.appendChild(el('rect',{x:px*s,y:-11*s,width:6*s,height:3.4*s,rx:1.4*s,fill:'rgba(9,13,20,.7)'}));
    b.appendChild(el('rect',{x:px*s,y:7.6*s,width:6*s,height:3.4*s,rx:1.4*s,fill:'rgba(9,13,20,.7)'}));
  });
  g.appendChild(b);
  return g;
}
function mapPin(color,glyph){
  var g=el('g',{});
  g.appendChild(el('ellipse',{cx:0,cy:2,rx:9,ry:3.4,fill:'rgba(0,0,0,.5)'}));
  g.appendChild(el('path',{d:'M0 0 C -11 -13 -15 -19 -15 -25 A 15 15 0 0 1 15 -25 C 15 -19 11 -13 0 0 Z',
    fill:color,stroke:'rgba(8,11,18,.6)','stroke-width':'1.4'}));
  if(glyph){
    var t=el('text',{x:0,y:-20,'text-anchor':'middle','font-size':'14','font-family':'Manrope,sans-serif'});
    t.textContent=glyph;g.appendChild(t);
  } else g.appendChild(el('circle',{cx:0,cy:-25,r:5,fill:'rgba(8,11,18,.55)'}));
  return g;
}
function maxGap(aPath,pPath){
  var La=aPath.getTotalLength(),Lp=pPath.getTotalLength(),N=130,best=null,cache=[];
  for(var j=0;j<=N;j++)cache.push(pPath.getPointAtLength(Lp*j/N));
  for(var i=0;i<=N;i++){
    var pa=aPath.getPointAtLength(La*i/N),bd=Infinity,bp=null;
    for(var k=0;k<=N;k++){
      var pp=cache[k],d=(pp.x-pa.x)*(pp.x-pa.x)+(pp.y-pa.y)*(pp.y-pa.y);
      if(d<bd){bd=d;bp=pp;}
    }
    if(!best||bd>best.d)best={d:bd,a:pa,p:bp,t:i/N};
  }
  return best;
}
function rider(p){
  var L=p.getTotalLength();
  return {len:L,at:function(t){
    t=clamp(t,0,1);var d=L*t;
    var a=p.getPointAtLength(Math.max(0,d-1.2)),b=p.getPointAtLength(Math.min(L,d+1.2));
    var pt=p.getPointAtLength(d);
    return {x:pt.x,y:pt.y,a:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};
  }};
}
function dasher(p){var L=p.getTotalLength();p.style.strokeDasharray=L+' '+L;
  return function(t){p.style.strokeDashoffset=(L*(1-clamp(t,0,1))).toFixed(1);};}

function routePair(layer,plannedD,actualD){
  var g=el('g',{});
  var pc=el('path',{d:plannedD,fill:'none',stroke:'#05070C','stroke-width':'15','stroke-linecap':'round'});
  var pl=el('path',{d:plannedD,fill:'none',stroke:'rgba(216,232,254,.58)','stroke-width':'4.5',
    'stroke-linecap':'round','stroke-dasharray':'15 15'});
  var ac=el('path',{d:actualD,fill:'none',stroke:'#05070C','stroke-width':'17','stroke-linecap':'round'});
  var ag=el('path',{d:actualD,fill:'none',stroke:'#F2A24C','stroke-width':'16','stroke-linecap':'round',
    opacity:'.20',filter:'blur(9px)'});
  var al=el('path',{d:actualD,fill:'none',stroke:'#F2A24C','stroke-width':'7','stroke-linecap':'round'});
  g.appendChild(pc);g.appendChild(pl);g.appendChild(ac);g.appendChild(ag);g.appendChild(al);
  layer.appendChild(g);
  return {plannedCase:pc,planned:pl,actualCase:ac,actual:al,glow:ag};
}


return {
  '$': $,
  '$$': $$,
  el: el,
  clamp: clamp,
  lerp: lerp,
  ease: ease,
  reduced: reduced,
  rng: rng,
  PROJ: PROJ,
  PLANNED: PLANNED,
  ACTUAL: ACTUAL,
  ORIGIN: ORIGIN,
  DEST: DEST,
  STATION: STATION,
  Map3: Map3,
  truckMarker: truckMarker,
  mapPin: mapPin,
  maxGap: maxGap,
  rider: rider,
  dasher: dasher,
  routePair: routePair
};

})();
