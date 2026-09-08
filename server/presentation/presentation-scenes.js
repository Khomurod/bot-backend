'use strict';

/*
 * Wenze Operations Hub product page — the scenes.
 *
 * The hero, the two acts (route deviation, fuel proximity), the command
 * centre, the convergence and closing maps, and presentation mode. Extracted
 * from presentation.js when the page passed the repository's 500-line limit.
 *
 * Draws with presentation-engine.js (WZL_PRES) and registers with
 * presentation-scroll.js (WZL_SCROLL). BOTH MUST LOAD FIRST; the page's script
 * tags encode that order. The bindings are pulled into locals below so the
 * scene bodies read exactly as they did when everything shared one closure.
 */

(function(){

var _P = window.WZL_PRES;
var $ = _P['$'], $$ = _P['$$'], el = _P.el, clamp = _P.clamp, lerp = _P.lerp, ease = _P.ease;
var reduced = _P.reduced, rng = _P.rng, PROJ = _P.PROJ;
var PLANNED = _P.PLANNED, ACTUAL = _P.ACTUAL, ORIGIN = _P.ORIGIN, DEST = _P.DEST, STATION = _P.STATION;
var Map3 = _P.Map3, truckMarker = _P.truckMarker, mapPin = _P.mapPin, maxGap = _P.maxGap;
var rider = _P.rider, dasher = _P.dasher, routePair = _P.routePair;

var _S = window.WZL_SCROLL;
var reg = _S.reg, scenes = _S.scenes, measure = _S.measure, caps = _S.caps;
var onLayout = _S.onLayout, onLangChange = _S.onLangChange;
var runLayoutHooks = _S.runLayoutHooks;
// `_S.lang` is read through the namespace at each use: it is mutable state the
// framework owns, and a copy taken here would freeze at 'en'.

/* ─────────── hero ─────────── */
(function(){
  var m=Map3('mapHero',{seed:7});m.cityLabels();
  var rp=routePair(m.layer,PLANNED,PLANNED);
  rp.actual.setAttribute('opacity','.95');
  var path=rp.actual,ride=rider(path);
  var tk=m.addPin(0,0,function(){return truckMarker('#F2A24C',1);});
  m.addPin(DEST.x,DEST.y,function(){return mapPin('#5BD0BC');});
  function frame(t){
    var p=ride.at(t);
    tk.setAttribute('transform','translate('+p.x.toFixed(1)+' '+p.y.toFixed(1)+') scale('+(1/1.0).toFixed(3)+') rotate('+p.a.toFixed(1)+')');
    m.look(p.x-120,p.y-60,.96);
    // counter-rotate handled by writing transform after look()
    tk.setAttribute('transform','translate('+p.x.toFixed(1)+' '+p.y.toFixed(1)+') scale('+(1/m.k).toFixed(3)+') rotate('+p.a.toFixed(1)+')');
  }
  if(reduced){frame(.34);return;}
  var t0=performance.now(),live=true;
  if('IntersectionObserver' in window)
    new IntersectionObserver(function(e){live=e[0].isIntersecting;if(live)loop();},{threshold:0}).observe($('#s-hero'));
  function loop(now){
    if(!live)return;
    frame(.06+((((now||performance.now())-t0)/64000)%.88));
    requestAnimationFrame(loop);
  }
  frame(.06);loop();
})();

var CARD_BIAS=470;
/* ─────────── ACT I — route ─────────── */
(function(){
  var m=Map3('mapRoute',{seed:7});m.cityLabels();
  var rp=routePair(m.layer,PLANNED,ACTUAL);
  var drawP=dasher(rp.planned),drawPC=dasher(rp.plannedCase);
  var drawA=dasher(rp.actual),drawAC=dasher(rp.actualCase);
  var ride=rider(rp.actual);
  var tk=m.addPin(0,0,function(){return truckMarker('#F2A24C',1);});
  m.addPin(ORIGIN.x,ORIGIN.y,function(){return mapPin('#9FB4D0');});
  var dest=m.addPin(DEST.x,DEST.y,function(){return mapPin('#5BD0BC');});
  dest.style.opacity=0;dest.style.transition='opacity .6s';

  // deviation measure, taken from the actual geometry
  var GAP=maxGap(rp.actual,rp.planned);
  var dev=el('g',{opacity:'0'});
  dev.appendChild(el('path',{d:'M '+GAP.p.x.toFixed(0)+' '+GAP.p.y.toFixed(0)+' L '+GAP.a.x.toFixed(0)+' '+GAP.a.y.toFixed(0),
    stroke:'#F0705C','stroke-width':'3','stroke-dasharray':'9 9'}));
  dev.appendChild(el('circle',{cx:GAP.p.x.toFixed(0),cy:GAP.p.y.toFixed(0),r:'7',fill:'#F0705C'}));
  dev.appendChild(el('circle',{cx:GAP.a.x.toFixed(0),cy:GAP.a.y.toFixed(0),r:'7',fill:'#F0705C'}));
  m.layer.appendChild(dev);
  dev.style.transition='opacity .5s';
  var devLbl=m.addPin((GAP.p.x+GAP.a.x)/2,(GAP.p.y+GAP.a.y)/2,function(){
    var g=el('g',{});
    g.appendChild(el('rect',{x:'8',y:'-15',width:'72',height:'30',rx:'8',fill:'rgba(240,112,92,.16)',
      stroke:'rgba(240,112,92,.55)','stroke-width':'1.2'}));
    var t=el('text',{x:'44',y:'5','text-anchor':'middle','font-family':'Manrope,sans-serif','font-size':'14',
      'font-weight':'600',fill:'#F0705C'});t.textContent='1.4 mi';g.appendChild(t);return g;
  });
  devLbl.style.opacity=0;devLbl.style.transition='opacity .5s';

  var ring=el('circle',{cx:DEST.x.toFixed(0),cy:DEST.y.toFixed(0),r:'330',fill:'none',stroke:'#5BD0BC','stroke-width':'3',
    'stroke-dasharray':'12 14',opacity:'0'});
  m.layer.appendChild(ring);ring.style.transition='opacity .6s';

  var setCap=caps('#rCaps');
  var tg=$('#rTg'),reply=$('#rReply');

  reg('#s-route',function(p){
    var e=clamp((p-.03)/.94,0,1);

    // route draw
    var dr=clamp(e/.10,0,1);drawPC(dr);drawP(dr);
    // truck travel
    var tv=clamp((e-.10)/.84,0,1);
    drawAC(tv);drawA(tv);
    var pt=ride.at(tv);

    // camera: tight follow → wide on the deviation → pull out over the destination
    var lead=lerp(170,50,clamp((e-.40)/.26,0,1));
    var cx=pt.x+lead*Math.cos(pt.a*Math.PI/180),cy=pt.y+lead*Math.sin(pt.a*Math.PI/180)-40;
    cx+=CARD_BIAS;   // the message card owns the right side; ride the truck clear of it
    var k=1.02;
    var dv=clamp(1-Math.abs(tv-GAP.t)/.19,0,1);                  // deviation framing window
    if(dv>0){
      var gx=(GAP.a.x+GAP.p.x)/2,gy=(GAP.a.y+GAP.p.y)/2;
      cx=lerp(cx,gx,dv);cy=lerp(cy,gy,dv);k=lerp(k,.70,dv);
    }
    var out=clamp((tv-.90)/.10,0,1);                             // arrival framing
    if(out>0){cx=lerp(cx,DEST.x-140,out);cy=lerp(cy,DEST.y+90,out);k=lerp(k,.52,out);}
    m.look(cx,cy,k);
    tk.setAttribute('transform','translate('+pt.x.toFixed(1)+' '+pt.y.toFixed(1)+') scale('+(1/m.k).toFixed(3)+') rotate('+pt.a.toFixed(1)+')');

    // stage — pinned to where the truck actually is on the deviation lobe
    var gt=GAP.t;
    var st = tv<.05?0 : tv<.17?1 : tv<(gt-.13)?2 : tv<(gt+.04)?3 : tv<(gt+.16)?4 : tv<.90?5 : 6;
    setCap(st);
    $('#rNum').classList.toggle('on',e>.01&&e<.16);
    $('#rTitle').classList.toggle('on',e>.02&&e<.16);
    $('#rFine').classList.toggle('on',st>=3&&st<=5);
    tg.classList.toggle('on',st>=1&&st<=5);
    reply.classList.toggle('on',st>=4);
    dev.style.opacity=(st===3||st===4)?1:0;
    devLbl.style.opacity=(st===3||st===4)?1:0;
    ring.style.opacity=st>=6?1:0;
    dest.style.opacity=st>=5?1:0;
  });
})();

/* ─────────── ACT II — fuel ─────────── */
(function(){
  var m=Map3('mapFuel',{seed:7});m.cityLabels();
  var rp=routePair(m.layer,PLANNED,PLANNED);
  var ride=rider(rp.actual);
  // start this act where act I ended
  var T0=.64,T1=1.0;
  var tk=m.addPin(0,0,function(){return truckMarker('#F2A24C',1);});

  var radius=el('circle',{cx:STATION.x,cy:STATION.y,r:'560',fill:'rgba(242,162,76,.05)',
    stroke:'rgba(242,162,76,.5)','stroke-width':'3','stroke-dasharray':'14 16'});
  m.layer.appendChild(radius);
  var radLbl=m.addPin(STATION.x,STATION.y-560,function(){
    var g=el('g',{});
    var t=el('text',{x:'0',y:'-14','text-anchor':'middle','font-family':'Manrope,sans-serif','font-size':'13',
      'font-weight':'700','letter-spacing':'.16em',fill:'rgba(242,162,76,.85)'});
    t.textContent='50 MI';g.appendChild(t);return g;});

  var stn=m.addPin(STATION.x,STATION.y,function(){return mapPin('#F2A24C','⛽');});
  var stnLbl=m.addPin(STATION.x,STATION.y,function(){
    var g=el('g',{});
    var t=el('text',{x:'22',y:'-22','font-family':'Manrope,sans-serif','font-size':'13','font-weight':'600',
      fill:'rgba(246,222,190,.9)'});t.textContent='Midway Travel Center';g.appendChild(t);return g;});
  var dest=m.addPin(DEST.x,DEST.y,function(){return mapPin('#5BD0BC');});

  [radius,radLbl,stn,stnLbl].forEach(function(n){n.style.opacity=0;n.style.transition='opacity .7s';});

  var setCap=caps('#fCaps');
  var tg=$('#fTg'),reply=$('#fReply'),dist=$('#fDist'),num=$('#fNum2');

  reg('#s-fuel',function(p){
    var e=clamp((p-.03)/.94,0,1);
    var tv=lerp(T0,T1,clamp((e-.06)/.88,0,1));
    var pt=ride.at(tv);

    // tighter, more intimate framing than Act I; slow zoom-in toward the station
    var k=lerp(1.18,1.5,clamp((e-.3)/.5,0,1));
    k=lerp(k,1.05,clamp((e-.88)/.12,0,1));
    var bias=lerp(0,(STATION.x-pt.x)*.34,clamp((e-.2)/.5,0,1));
    m.look(pt.x+bias+60,pt.y-70,k);
    tk.setAttribute('transform','translate('+pt.x.toFixed(1)+' '+pt.y.toFixed(1)+') scale('+(1/m.k).toFixed(3)+') rotate('+pt.a.toFixed(1)+')');

    var st = e<.12?0 : e<.30?1 : e<.56?2 : e<.80?3 : 4;
    setCap(st);
    $('#fNum').classList.toggle('on',e>.01&&e<.18);
    $('#fTitle').classList.toggle('on',e>.02&&e<.18);
    $('#fFine').classList.toggle('on',st>=2&&st<=3);
    tg.classList.toggle('on',(e>.04&&st<=1)||st>=3);
    reply.classList.toggle('on',st>=3);
    [stn,stnLbl].forEach(function(n){n.style.opacity=st>=1?1:0;});
    radius.style.opacity=st>=2?1:0;radLbl.style.opacity=st>=2?1:0;

    // distance numeral — hero of the approach beat, then it hands over to the card
    var show=st===2;
    dist.classList.toggle('on',show);
    var d=Math.max(0,Math.round(lerp(187,18,clamp((e-.14)/.72,0,1))));
    num.textContent=d;
    num.classList.toggle('hot',d<=50);
    // radius pulse as it arms
    var ra=clamp((e-.42)/.14,0,1);
    radius.setAttribute('r',(560*(0.6+0.4*ease(ra))).toFixed(0));
  });
})();

/* ─────────── command center ─────────── */
var FLEET_GEO=[
  {u:'4417',d:'M. Reyes',      la:36.9903,lo:-86.4436, s:'route',to:'Louisville, KY',   eta:'14:20',
   en:'On the assigned route — 0.1 mi off the line.',ru:'На маршруте — 0.1 мили от линии.'},
  {u:'2208',d:'A. Novak',      la:37.6939,lo:-85.8591, s:'fuel', to:'Columbus, OH',     eta:'17:05',
   en:'42 mi from the assigned fuel stop — reminder sent.',ru:'42 мили до заправки — напоминание отправлено.'},
  {u:'3610',d:'D. Whitfield',  la:36.1627,lo:-86.7816,s:'dev',  to:'Indianapolis, IN', eta:'12:48',
   en:'Off route 3 of 3 — driver warned in the group.',ru:'Вне маршрута 3 из 3 — водитель предупреждён.'},
  {u:'1155',d:'J. Okafor',     la:38.2527,lo:-85.7585, s:'deliv',to:'Cleveland, OH',    eta:'10:30',
   en:'Within 50 mi of destination — the route will close itself.',ru:'В пределах 50 миль — маршрут закроется сам.'},
  {u:'5072',d:'S. Lindqvist',  la:35.4817,lo:-86.0886,s:'route',to:'Nashville, TN',    eta:'19:12',
   en:'Tracking active since the route message was delivered.',ru:'Отслеживание активно с момента доставки.'},
  {u:'6394',d:'R. Castellanos',la:37.092,lo:-84.6041,s:'fuel', to:'Charlotte, NC',    eta:'21:40',
   en:'Approaching the assigned station — 61 mi out.',ru:'Подъезжает к станции — 61 миля.'},
  {u:'8820',d:'T. Bauer',      la:36.1628,lo:-85.5016,s:'route',to:'Memphis, TN',      eta:'16:02',
   en:'On the assigned route — no events today.',ru:'На маршруте — событий сегодня нет.'},
  {u:'7431',d:'K. Adeyemi',    la:34.7304,lo:-86.5861,s:'deliv',to:'Atlanta, GA',      eta:'09:15',
   en:'Approaching the delivery — ETA updates going out.',ru:'Подъезжает к выгрузке — обновления ETA идут.'}
];
var FLEET=FLEET_GEO.map(function(t){var p=PROJ(t.la,t.lo);t.x=p.x;t.y=p.y;return t;});
var SC={route:'#5BD0BC',dev:'#F0705C',fuel:'#F2A24C',deliv:'#9FB4D0'};
var SL={route:{en:'On route',ru:'На маршруте'},dev:{en:'Route deviation',ru:'Отклонение'},
        fuel:{en:'Fuel stop approaching',ru:'Подъезд к заправке'},deliv:{en:'Delivery approaching',ru:'Подъезд к выгрузке'}};
var LB={dest:{en:'Destination',ru:'Назначение'},eta:{en:'ETA',ru:'ETA'},unit:{en:'Unit',ru:'Юнит'}};
var ccMap=null,ccMarks=[],ccPath=null;
function ccHeading(x,y){
  if(!ccPath)return 0;
  var L=ccPath.getTotalLength(),bd=Infinity,bt=0;
  for(var i=0;i<=120;i++){
    var p=ccPath.getPointAtLength(L*i/120),d=(p.x-x)*(p.x-x)+(p.y-y)*(p.y-y);
    if(d<bd){bd=d;bt=i/120;}
  }
  var a=ccPath.getPointAtLength(Math.max(0,L*bt-14)),b=ccPath.getPointAtLength(Math.min(L,L*bt+14));
  return Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI;
}
function buildCC(){
  if(!ccMap){
    ccMap=Map3('mapCC',{seed:7});ccMap.cityLabels();
    var rp=routePair(ccMap.layer,PLANNED,PLANNED);
    rp.actual.setAttribute('opacity','.4');rp.actualCase.setAttribute('opacity','.5');
    rp.glow.setAttribute('opacity','.1');ccPath=rp.actual;
  }
  ccMarks.forEach(function(m){m.el.remove();});ccMarks=[];
  var panel=$('#ccPanel'),list=$('#ccList');
  if(list)list.innerHTML='';
  FLEET.forEach(function(t,i){
    var c=SC[t.s];
    var g=ccMap.addPin(t.x,t.y,function(){
      var gg=el('g',{class:'mk',tabindex:'0',role:'button'});
      gg.setAttribute('aria-label','Unit '+t.u+' — '+SL[t.s][_S.lang]);
      gg.appendChild(el('circle',{class:'halo',cx:0,cy:0,r:30,fill:c,opacity:'.11'}));
      var tm=truckMarker(c,1.05);
      tm.setAttribute('transform','rotate('+ccHeading(t.x,t.y).toFixed(1)+')');
      gg.appendChild(tm);
      var pl=el('g',{class:'plate'});
      pl.appendChild(el('rect',{x:-24,y:-40,width:48,height:19,rx:9,fill:'rgba(10,14,22,.9)',
        stroke:'rgba(255,255,255,.18)','stroke-width':1}));
      var tx=el('text',{x:0,y:-26.5,'text-anchor':'middle','font-family':'Manrope,sans-serif',
        'font-size':11.5,'font-weight':'700',fill:'#fff'});tx.textContent=t.u;
      pl.appendChild(tx);gg.appendChild(pl);
      return gg;
    });
    var node=g.firstChild;
    function open(){
      ccMarks.forEach(function(m){m.node.classList.remove('sel');});
      node.classList.add('sel');
      panel.innerHTML='<span class="pill" style="color:'+c+';background:'+c+'1f"><i></i>'+SL[t.s][_S.lang]+'</span>'+
        '<h4>'+t.d+'</h4><div class="unit">'+LB.unit[_S.lang]+' # '+t.u+'</div>'+
        '<div class="row"><span>'+LB.dest[_S.lang]+'</span><span>'+t.to+'</span></div>'+
        '<div class="row" style="border:0;padding-top:8px;margin-top:6px"><span>'+LB.eta[_S.lang]+'</span><span>'+t.eta+' CST</span></div>'+
        '<div class="note">'+t[_S.lang]+'</div>';
      var host=$('#s-cc .pin'),r=host.getBoundingClientRect();
      var pr=node.getBoundingClientRect();
      var px=pr.left-r.left+pr.width/2,py=pr.top-r.top;
      panel.style.left=clamp(px+26,16,Math.max(16,r.width-284))+'px';
      panel.style.top=clamp(py-40,74,Math.max(74,r.height-250))+'px';
      panel.classList.add('on');
    }
    node.addEventListener('mouseenter',open);
    node.addEventListener('focus',open);
    node.addEventListener('click',function(e){e.stopPropagation();open();});
    node.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
    ccMarks.push({el:g,node:node,open:open});
    if(list){
      var row=document.createElement('div');
      row.innerHTML='<i style="background:'+c+'"></i><b>'+t.u+'</b> '+t.d+'<span>'+t.to+'</span>';
      list.appendChild(row);
    }
  });
  var host=$('#s-cc .pin');
  if(host&&!host._wired){host._wired=true;
    host.addEventListener('click',function(){$('#ccPanel').classList.remove('on');});}
}
buildCC();
reg('#s-cc',function(p){
  var e=clamp((p-.05)/.9,0,1);
  var k=lerp(.30,.44,ease(e));
  ccMap.look(lerp(2300,2500,ease(e)),lerp(1500,1260,ease(e)),k);
  if(e>.4&&!ccMap._shown){ccMap._shown=true;setTimeout(function(){if(ccMarks[1])ccMarks[1].open();},260);}
});

/* ─────────── convergence ─────────── */
var FRAGS=[
  {en:'Telegram',ru:'Telegram'},{en:'Datatruck TMS',ru:'Datatruck TMS'},
  {en:'Samsara / ELD',ru:'Samsara / ELD'},{en:'Fuel chat',ru:'Топливный чат'},
  {en:'Spreadsheets',ru:'Таблицы'},{en:'Phone calls',ru:'Звонки'},
  {en:'Recruiting inbox',ru:'Почта найма'},{en:'Safety tools',ru:'Безопасность'}
];
/*
 * FRAGS and AFTER are INDEX-MATCHED, one entry per fragment tile: the
 * convergence scene morphs each "system we juggle" into the capability that
 * replaced it. They must stay the same length — removing an entry from one
 * side without the other throws on the DOM node that has no partner, which is
 * exactly what happened when the Trailers capability was removed. The tile
 * count below is derived from FRAGS for the same reason, and
 * tests/presentationConvergence.test.js asserts the parity.
 */
var AFTER=[
  {en:'Dispatch',ru:'Диспетчерская'},{en:'Route Control',ru:'Контроль маршрута'},
  {en:'Fuel Monitoring',ru:'Мониторинг топлива'},{en:'Drivers',ru:'Водители'},
  {en:'Documents',ru:'Документы'},{en:'Home Time',ru:'Время дома'},
  {en:'Recruiting',ru:'Найм'},{en:'Safety',ru:'Безопасность'}
];
var fragEls=[],threadEls=[];
function layoutConv(){
  var field=$('#field');if(!field)return;
  var wpx=field.clientWidth,hpx=field.clientHeight;
  var svg=$('#threads');
  if(!fragEls.length){
    for(var i=0;i<FRAGS.length;i++){
      var d=document.createElement('div');d.className='frag';field.appendChild(d);
      fragEls.push(d);
      var l=el('path',{fill:'none','stroke-width':'1'});svg.appendChild(l);threadEls.push(l);
    }
  }
  var r=rng(19);
  fragEls.forEach(function(d,i){
    d.textContent=FRAGS[i][_S.lang];
    var w=d.offsetWidth,h=d.offsetHeight;
    var col=i%4,row=(i/4)|0;
    // scattered start — jittered ring, so nothing collides
    var ang=(i/8)*Math.PI*2+(r()-.5)*.42;
    var sx=wpx*0.5+Math.cos(ang)*wpx*(0.30+r()*0.12)-w/2;
    var sy=hpx*0.5+Math.sin(ang)*hpx*(0.32+r()*0.13)-h/2;
    var rot=(r()-.5)*20;
    // aligned end — 4 x 2 grid, centred in the frame
    var padx=wpx*0.07, cw=(wpx-padx*2)/4;
    var ex=padx+cw*col+cw/2-w/2;
    var ey=hpx*0.5+(row?1:-1)*(h*0.9)-h/2;
    d._s=[clamp(sx,4,wpx-w-4),clamp(sy,4,hpx-h-4),rot];
    d._e=[clamp(ex,4,wpx-w-4),clamp(ey,4,hpx-h-4),0];
  });
  paintConv(scenes.length?undefined:0);
}
function paintConv(p){
  if(p===undefined)p=($('#s-conv')?clamp(-$('#s-conv').getBoundingClientRect().top/Math.max(1,$('#s-conv').offsetHeight-window.innerHeight),0,1):0);
  var e=ease(clamp((p-.16)/.6,0,1));
  var after=e>.5;
  $('#cvA').classList.toggle('off',after);
  $('#cvB').classList.toggle('off',!after);
  $('#frame').style.opacity=clamp((e-.42)/.4,0,1);
  $('#frame').style.transform='scale('+lerp(.96,1,clamp((e-.42)/.4,0,1)).toFixed(3)+')';
  var pts=[];
  fragEls.forEach(function(d,i){
    var x=lerp(d._s[0],d._e[0],e),y=lerp(d._s[1],d._e[1],e),rot=lerp(d._s[2],d._e[2],e);
    d.style.transform='translate3d('+x.toFixed(1)+'px,'+y.toFixed(1)+'px,0) rotate('+rot.toFixed(2)+'deg)';
    d.style.opacity=lerp(.62,1,e);
    d.style.borderColor=after?'rgba(242,162,76,.34)':'rgba(255,255,255,.1)';
    d.style.color=after?'rgba(255,255,255,.95)':'rgba(255,255,255,.62)';
    if(after&&d.textContent!==AFTER[i][_S.lang])d.textContent=AFTER[i][_S.lang];
    if(!after&&d.textContent!==FRAGS[i][_S.lang])d.textContent=FRAGS[i][_S.lang];
    pts.push([x+d.offsetWidth/2,y+d.offsetHeight/2]);
  });
  var fw=$('#field').clientWidth||1,fh=$('#field').clientHeight||1;
  threadEls.forEach(function(l,i){
    var a=pts[i],b=pts[(i+3)%8];
    var sx=a[0]/fw*1000,sy=a[1]/fh*560,ex=b[0]/fw*1000,ey=b[1]/fh*560;
    l.setAttribute('d','M'+sx.toFixed(1)+' '+sy.toFixed(1)+' L'+ex.toFixed(1)+' '+ey.toFixed(1));
    l.setAttribute('stroke',after?'rgba(242,162,76,'+(0.16*(e-.5)*2).toFixed(3)+')'
                                 :'rgba(240,112,92,'+(0.22*(1-e*2)).toFixed(3)+')');
    l.setAttribute('stroke-dasharray',after?'none':'3 6');
  });
}
runLayoutHooks();
reg('#s-conv',paintConv);

/* ─────────── closing map ─────────── */
(function(){
  var m=Map3('mapEnd',{seed:7});
  var rp=routePair(m.layer,PLANNED,PLANNED);
  rp.actual.setAttribute('opacity','.75');
  var ride=rider(rp.actual);
  var tk=m.addPin(0,0,function(){return truckMarker('#F2A24C',1);});
  function frame(t){
    var p=ride.at(t);
    m.look(p.x+180,p.y-40,.72);
    tk.setAttribute('transform','translate('+p.x.toFixed(1)+' '+p.y.toFixed(1)+') scale('+(1/m.k).toFixed(3)+') rotate('+p.a.toFixed(1)+')');
  }
  if(reduced){frame(.6);return;}
  var live=false,t0=performance.now();
  if('IntersectionObserver' in window)
    new IntersectionObserver(function(e){live=e[0].isIntersecting;if(live){t0=performance.now()-24000;loop();}},
      {threshold:0}).observe($('#s-end'));
  function loop(now){if(!live)return;frame((((now||performance.now())-t0)/78000)%1);requestAnimationFrame(loop);}
  frame(.3);
})();

/* ─────────── presentation mode ─────────── */
var SLIDES=[
  {id:'s-hero',p:0,  en:'Opening',ru:'Начало'},
  {id:'s-route',p:.05,en:'Route assigned',ru:'Маршрут назначен'},
  {id:'s-route',p:.16,en:'Delivered to the driver',ru:'Доставлено водителю'},
  {id:'s-route',p:.32,en:'On route',ru:'На маршруте'},
  {id:'s-route',p:.50,en:'Deviation detected',ru:'Отклонение'},
  {id:'s-route',p:.66,en:'Driver warned',ru:'Предупреждение'},
  {id:'s-route',p:.80,en:'Back on route',ru:'Вернулся'},
  {id:'s-route',p:.95,en:'Route closes itself',ru:'Маршрут закрыт'},
  {id:'s-fuel',p:.06, en:'Stop assigned',ru:'Станция назначена'},
  {id:'s-fuel',p:.24, en:'Geocoded',ru:'Геокодировано'},
  {id:'s-fuel',p:.46, en:'50-mile radius',ru:'Радиус 50 миль'},
  {id:'s-fuel',p:.70, en:'Reminder sent',ru:'Напоминание'},
  {id:'s-fuel',p:.92, en:'Nobody chased',ru:'Никто не искал'},
  {id:'s-cc',p:.55,   en:'Command center',ru:'Командный центр'},
  {id:'s-conv',p:.12, en:'Scattered',ru:'Разрозненно'},
  {id:'s-conv',p:.80, en:'Converged',ru:'Связано'},
  {id:'s-cap',p:0,    en:'Capabilities',ru:'Возможности'},
  {id:'s-end',p:0,    en:'Closing',ru:'Финал'}
];
var present=false,idx=0;
SLIDES.forEach(function(){$('#pDots').insertAdjacentHTML('beforeend','<i></i>');});
var dotEls=$$('#pDots i');
function slideY(s){
  var e=document.getElementById(s.id);if(!e)return 0;
  var top=e.getBoundingClientRect().top+window.pageYOffset;
  var span=e.offsetHeight-window.innerHeight;
  if(span>0)return top+span*s.p;
  return top-Math.max(0,(window.innerHeight-e.offsetHeight)/2);
}
function goTo(i){
  idx=clamp(i,0,SLIDES.length-1);
  window.scrollTo({top:slideY(SLIDES[idx]),behavior:'auto'});
  measure();
  $('#pNum').textContent=String(idx+1);
  $('#pLbl').textContent='/ '+SLIDES.length+' · '+SLIDES[idx][_S.lang];
  dotEls.forEach(function(d,k){d.classList.toggle('on',k===idx);});
  $('#pPrev').disabled=idx===0;$('#pNext').disabled=idx===SLIDES.length-1;
}
function nearest(){var y=window.pageYOffset,b=0,bd=Infinity;
  SLIDES.forEach(function(s,i){var d=Math.abs(slideY(s)-y);if(d<bd){bd=d;b=i;}});return b;}
function setPresent(on){
  present=on;document.body.classList.toggle('present',on);
  $('#presBtn').setAttribute('aria-pressed',String(on));
  if(on){goTo(nearest());$('#pNext').focus();}
}
$('#presBtn').addEventListener('click',function(){setPresent(!present);});
$('#pExit').addEventListener('click',function(){setPresent(false);});
$('#pPrev').addEventListener('click',function(){goTo(idx-1);});
$('#pNext').addEventListener('click',function(){goTo(idx+1);});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&present){setPresent(false);return;}
  if(!present)return;
  if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();goTo(idx+1);}
  else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();goTo(idx-1);}
  else if(e.key==='Home'){e.preventDefault();goTo(0);}
  else if(e.key==='End'){e.preventDefault();goTo(SLIDES.length-1);}
});
(function(){var sx=0,sy=0;
  document.addEventListener('touchstart',function(e){if(!present)return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;},{passive:true});
  document.addEventListener('touchend',function(e){if(!present)return;
    var dx=e.changedTouches[0].clientX-sx,dy=e.changedTouches[0].clientY-sy;
    if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.4)goTo(idx+(dx<0?1:-1));},{passive:true});
})();

/* ─────────── boot ─────────── */
// What the framework's setLang used to call directly, now registered:
onLangChange(buildCC);
onLangChange(function(){ if(present) goTo(idx); });
onLayout(layoutConv);

window.addEventListener('load',function(){layoutConv();measure();});
measure();
})();
