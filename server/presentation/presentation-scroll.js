'use strict';

/*
 * Wenze Operations Hub product page — the scroll/scene framework.
 *
 * A scene registers a selector and a progress function; this file measures
 * every registered scene on scroll and resize, pins what needs pinning, drives
 * the progress bar and the caption, and owns the EN/RU language state.
 *
 * Extracted from presentation-scenes.js when the page passed the repository's
 * 500-line limit. It is the natural seam: every scene talks to the page only
 * through `reg`, `caps`, `measure`, `lang` and the layout hook, so this is the
 * page's framework and the scenes are its content.
 *
 * `onLayout` replaces what used to be a forward reference to a function
 * declared 300 lines further down inside one of the scenes — a scene that
 * needs re-laying-out on resize or a language change now says so.
 *
 * Loads AFTER presentation-engine.js and BEFORE presentation-scenes.js; the
 * page's script tags encode that order.
 */

window.WZL_SCROLL = (function(){

var _P = window.WZL_PRES;
var $ = _P['$'], $$ = _P['$$'], clamp = _P.clamp, reduced = _P.reduced;

/**
 * Two hook lists, because the scenes have to react to two different things and
 * this file must not reach forward into them:
 *
 *   onLayout    — re-position on resize, on load and after a language change.
 *   onLangChange — rebuild content whose text depends on the language.
 *
 * Both replace what used to be direct calls to functions declared hundreds of
 * lines further down inside a scene, back when everything shared one closure.
 * Hooks run in registration order.
 */
var layoutHooks = [];
var langHooks = [];
function onLayout(fn){ layoutHooks.push(fn); }
function onLangChange(fn){ langHooks.push(fn); }
function runLayoutHooks(){ for (var i=0;i<layoutHooks.length;i++) layoutHooks[i](); }
function runLangHooks(){ for (var i=0;i<langHooks.length;i++) langHooks[i](); }

/* ─────────── scroll engine ─────────── */
var scenes=[],raf=0;
function reg(sel,fn){var e=$(sel);if(!e)return;scenes.push({el:e,fn:fn,last:-1,pin:e.querySelector(':scope > .pin')});}
function measure(){
  var vh=window.innerHeight;
  for(var i=0;i<scenes.length;i++){
    var s=scenes[i],r=s.el.getBoundingClientRect();
    if(s.pin){
      var off=clamp(-r.top,0,Math.max(0,s.el.offsetHeight-vh));
      s.pin.style.transform='translate3d(0,'+off.toFixed(1)+'px,0)';
    }
    var span=s.el.offsetHeight-vh;
    var p=span>0?clamp(-r.top/span,0,1):(r.top<=0?1:0);
    if(Math.abs(p-s.last)>0.0006){s.last=p;s.fn(p);}
  }
  var bar=$('#top'),q=$('#s-cap').getBoundingClientRect();
  bar.classList.toggle('light',q.top<=58&&q.bottom>=58);
}
window.addEventListener('scroll',function(){if(!raf)raf=requestAnimationFrame(function(){raf=0;measure();});},{passive:true});
window.addEventListener('resize',function(){runLayoutHooks();measure();},{passive:true});

/* caption driver */
function caps(rootSel){
  var list=$$(rootSel+' .cap');
  var cur=-1;
  return function(i){
    if(i===cur)return;cur=i;
    list.forEach(function(c){c.classList.toggle('on',Number(c.dataset.at)===i);});
  };
}

/* ─────────── language ─────────── */
var lang='en';
function setLang(next){
  lang=next;document.documentElement.lang=next;
  $$('[data-ru]').forEach(function(e){
    if(!e.dataset.en)e.dataset.en=e.innerHTML;
    e.innerHTML=next==='ru'?e.dataset.ru:e.dataset.en;
  });
  $$('.lang button').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.lang===next));});
  runLangHooks();runLayoutHooks();
}
$$('.lang button').forEach(function(b){b.addEventListener('click',function(){setLang(b.dataset.lang);});});


return {
  reg: reg,
  scenes: scenes,
  measure: measure,
  caps: caps,
  onLayout: onLayout,
  onLangChange: onLangChange,
  runLayoutHooks: runLayoutHooks,
  get lang(){ return lang; },
  setLang: setLang
};

})();
