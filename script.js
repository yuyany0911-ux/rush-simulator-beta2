"use strict";
const $=id=>document.getElementById(id);
const ui={denom:$("denom"),spins:$("spins"),payouts:$("payouts"),specInfo:$("specInfo"),error:$("error"),start:$("start"),spin:$("spin"),auto:$("auto"),sound:$("sound"),chain:$("chain"),total:$("total"),remain:$("remain"),mode:$("mode"),message:$("message"),sub:$("submessage"),digits:$("screen").querySelector(".digits"),flash:$("flash"),result:$("result"),best:$("best")};
let spec=null,remaining=0,chain=0,total=0,busy=false,active=false,sound=true,audio=null,autoRunning=false,autoToken=0,spinsDone=0,roundSpins=0,holdQueue=[],instantSimulating=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const rand=n=>Math.floor(Math.random()*n);
function setSymbolStyle(element,value){
 const number=Number(value);
 element.classList.remove("symbol-even","symbol-odd","symbol-zero","symbol-art");
 element.removeAttribute("data-symbol");
 if(Number.isInteger(number)&&number>=0&&number<=9){
  element.classList.add(number===0?"symbol-zero":number%2===0?"symbol-even":"symbol-odd","symbol-art");
  element.dataset.symbol=String(number);
 }
}
function digits(a){
 ["d1","d2","d3"].forEach((id,i)=>{const track=$("track"+(i+1));track.replaceChildren();const el=document.createElement("span");el.id=id;el.textContent=a[i];setSymbolStyle(el,a[i]);track.appendChild(el);track.style.transform="translateY(0)";});
}
// iPhone Chrome / Safari: preload and unlock short effects via one Web Audio context.
// BGM and pre-alert remain on their existing players.
const effectAudio={ctx:null,buffers:{},loading:null,urls:{stop:"reel-stop.mp3",jackpot:"jackpot-sound.mp3",setup:"setup-complete.mp3",prealert:"prealert-v109.mp3"},volumes:{stop:0.275,jackpot:0.81,setup:0.255,prealert:1.0}};
// HTMLAudio fallback ensures stop sounds are not silently discarded while WebAudio decodes.
const effectFallback={stop:new Audio("reel-stop.mp3"),jackpot:new Audio("jackpot-sound.mp3"),setup:new Audio("setup-complete.mp3")};
Object.values(effectFallback).forEach(a=>{a.preload="auto";a.load();});
function playFallback(key){
 const source=effectFallback[key];if(!source)return;
 try{const a=source.cloneNode(true);a.volume=effectAudio.volumes[key];
  const promise=a.play();if(promise&&promise.catch)promise.catch(e=>console.warn("効果音の再生が制限されました",key,e));
 }catch(e){console.warn("効果音フォールバック失敗",key,e);}
}
function ensureEffectContext(){
 const AudioContextType=window.AudioContext||window.webkitAudioContext;
 if(!AudioContextType)return null;
 if(!effectAudio.ctx)effectAudio.ctx=new AudioContextType();
 return effectAudio.ctx;
}
function unlockEffects(){
 try{
  const ctx=ensureEffectContext();if(!ctx)return;
  // Called synchronously inside the RUSH START / manual / auto button gesture.
  if(ctx.state!=="running")ctx.resume().catch(e=>console.warn("音声の有効化待ち",e));
  if(!effectAudio.loading){
   effectAudio.loading=Promise.all(Object.entries(effectAudio.urls).map(async ([key,url])=>{
    try{const response=await fetch(url);if(!response.ok)throw new Error(url+" HTTP "+response.status);
     const bytes=await response.arrayBuffer();
     effectAudio.buffers[key]=await ctx.decodeAudioData(bytes);
    }catch(err){console.warn("効果音の読み込みに失敗",key,err);}
   }));
  }
 }catch(err){console.warn("音声初期化エラー",err);}
}
function playEffect(key){
 if(!sound)return;
 const ctx=effectAudio.ctx,buffer=effectAudio.buffers[key];
 if(!ctx||!buffer){unlockEffects();playFallback(key);return;}
 if(ctx.state!=="running"){ctx.resume().catch(()=>{});playFallback(key);return;}
 try{
  const source=ctx.createBufferSource(),gain=ctx.createGain();
  source.buffer=buffer;gain.gain.value=effectAudio.volumes[key];
  source.connect(gain);gain.connect(ctx.destination);source.start(0);
  source.onended=()=>{source.disconnect();gain.disconnect();};
 }catch(err){console.warn("効果音再生エラー",key,err);playFallback(key);}
}
function playStopSound(){playEffect("stop");}
function playJackpotSound(){playEffect("jackpot");}
// Animate the three stopped reels together. Web Animations avoids changing the
// track transform used by the vertical-spin renderer (and works on iOS Chrome).
function playJackpotBounce(){
 const reels=[1,2,3].map(i=>$("reel"+i));
 for(const reel of reels){
  try{
   reel.getAnimations().filter(a=>a.id==="jackpot-bounce").forEach(a=>a.cancel());
   const anim=reel.animate([
    {transform:"translateY(0)"},
    {transform:"translateY(-11px)",offset:.27},
    {transform:"translateY(7px)",offset:.62},
    {transform:"translateY(0)"}
   ],{duration:360,easing:"ease-out",iterations:1});
   anim.id="jackpot-bounce";
  }catch(e){console.warn("Jackpot bounce unavailable",e);}
 }
}

function playSetupCompleteSound(){playEffect("setup");}
// Independent 40%-reliability pre-alert. Color does not determine the alert.
// P(hit | alert) = 40% for base hit rates below 40% (Bayes' rule).
// iOS ignores HTMLMediaElement.volume. The MP3 itself is attenuated to 4.05%.
const prealertSound=new Audio("prealert-v109.mp3");
prealertSound.preload="auto";
prealertSound.volume=1;
prealertSound.load();
let pendingPrealerts=0;
let prealertEnabled=true;
const prealertTarget=0.99; // ON時は信頼度99%固定
// Ver.101: one calibrated lottery for all three selected reliability values.
// Diagnostics count every generated signal independently of audio playback.
let prealertGenerated=0,prealertNotified=0,specialGenerated=0,specialNotified=0;
function prealertFor(hit){
 if(!prealertEnabled)return false;
 const p=1/spec.n, q=Number(prealertTarget);
 if(!Number.isFinite(q)||q<=0||q>=1||p>q)return false;
 const onHit=.85;
 const onMiss=Math.min(1,onHit*p*(1-q)/(q*(1-p)));
 const result=Math.random()<(hit?onHit:onMiss);
 if(result)prealertGenerated++;
 return result;
}
function updateCueDiagnostics(){
 // Diagnostic panel removed from production UI.
}
// Pre-alert must never be silently discarded just because audio decoding is pending.
// The GainNode controls volume on iOS, where HTMLAudioElement.volume is unreliable.
// Prefer the unlocked WebAudio context for iOS Chrome. The fallback is a
// physically attenuated MP3, not HTMLMediaElement.volume (ignored on iOS).
// All reliability settings share the same playback path. A visible indicator
// makes it possible to distinguish a missed draw from a failed audio output.
let prealertPlayToken=0;
let prealertNoticeCount=0;
// Ver.107: use the same HTMLAudio playback route that worked in the
// user-gesture test. Keep WebAudio only as a fallback when play() rejects.
// Ver.108: independent short-lived player for each alert. Avoid a shared
// HTMLAudio element being reset by subsequent alerts during 0.3s auto-play.
let lastPrealertAt=0;
const prealertFallbackPool=Array.from({length:3},()=>{
 const a=new Audio("prealert-v109.mp3");a.preload="auto";a.load();return a;
});
let prealertFallbackIndex=0;
function playPrealert(){
 if(!prealertEnabled||instantSimulating||!sound||!active)return;
 prealertNotified++;updateCueDiagnostics();
 const now=performance.now();
 if(now-lastPrealertAt<180)return;
 lastPrealertAt=now;
 const ctx=effectAudio.ctx,buffer=effectAudio.buffers.prealert;
 if(ctx&&buffer&&ctx.state==="running"){
  try{
   const source=ctx.createBufferSource(),gain=ctx.createGain();
   source.buffer=buffer;gain.gain.value=1;
   source.connect(gain);gain.connect(ctx.destination);
   source.onended=()=>{source.disconnect();gain.disconnect();};
   source.start(0);return;
  }catch(e){console.warn("先バレWebAudio失敗",e);}
 }
 // Preloaded persistent fallback; avoid new Audio() inside delayed callbacks.
 const a=prealertFallbackPool[prealertFallbackIndex++%prealertFallbackPool.length];
 try{a.pause();a.currentTime=0;
  const promise=a.play();if(promise?.catch)promise.catch(e=>console.warn("先バレ再生拒否",e));
 }catch(e){console.warn("先バレ再生例外",e);}
}
// BGM: two independent audio decks for gap-free overlapping transitions.
// Fade-out near the end while fading in the next playback, at a quiet volume.
const bgmSource="rush-bgm.mp3";
const bgmLevel=0.151725; // Ver.68: previous 0.21 x 0.85 (15% quieter).
const bgmOverlap=4.0;
let bgmEnabled=true, bgmActive=false, bgmPaused=false, bgmPauseAt=0, bgmDeck=null, bgmNext=null, bgmFadeStart=0, bgmRaf=0;
const bgmPlayers=[new Audio(bgmSource),new Audio(bgmSource)];
for(const player of bgmPlayers){player.preload="auto";player.loop=false;player.volume=0;}
function bgmPlay(player){
 player.play().catch(error=>console.warn("BGMの再生に失敗しました。再生ボタンを押してください。",error));
}
function bgmStop(){
 bgmPaused=false;bgmActive=false;cancelAnimationFrame(bgmRaf);bgmRaf=0;
 for(const player of bgmPlayers){player.pause();player.volume=0;try{player.currentTime=0}catch{}}
 bgmDeck=null;bgmNext=null;
}
function bgmPause(){
 if(!bgmActive||bgmPaused)return;
 bgmPaused=true;bgmPauseAt=performance.now();
 cancelAnimationFrame(bgmRaf);bgmRaf=0;
 bgmPlayers.forEach(p=>p.pause());
}
function bgmResume(){
 if(!bgmEnabled)return;
 if(!bgmActive){bgmBegin();return;}
 if(!bgmPaused)return;
 bgmFadeStart+=performance.now()-bgmPauseAt;
 bgmPaused=false;
 if(bgmDeck)bgmPlay(bgmDeck);
 if(bgmNext)bgmPlay(bgmNext);
 bgmRaf=requestAnimationFrame(bgmTick);
}
function bgmBegin(){
 bgmStop();if(!bgmEnabled)return;
 bgmActive=true;bgmDeck=bgmPlayers[0];bgmDeck.volume=bgmLevel;
 bgmPlay(bgmDeck);bgmRaf=requestAnimationFrame(bgmTick);
}
function bgmTick(now){
 if(!bgmActive||bgmPaused)return;
 const current=bgmDeck;
 if(current&&Number.isFinite(current.duration)&&current.duration>0){
  const duration=current.duration;
  const fadeWindow=Math.min(bgmOverlap,Math.max(0.5,duration*.2));
  const remainingTime=duration-current.currentTime;
  if(!bgmNext&&remainingTime<=fadeWindow){
   bgmNext=bgmPlayers.find(p=>p!==current);
   bgmNext.currentTime=0;bgmNext.volume=0;
   bgmFadeStart=now;
   bgmPlay(bgmNext);
  }
  if(bgmNext){
   const t=Math.min(1,Math.max(0,(now-bgmFadeStart)/(fadeWindow*1000)));
   // Equal-power crossfade reduces perceived volume dips.
   current.volume=bgmLevel*Math.cos(t*Math.PI/2);
   bgmNext.volume=bgmLevel*Math.sin(t*Math.PI/2);
   if(t>=1||current.ended){
    current.pause();current.volume=0;
    try{current.currentTime=0}catch{}
    bgmDeck=bgmNext;bgmNext=null;
   }
  }
  // Short tracks or background tab throttling: resume playback if a deck ended.
  else if(current.ended){current.currentTime=0;current.volume=bgmLevel;bgmPlay(current);}
 }
 bgmRaf=requestAnimationFrame(bgmTick);
}

// Ver.66: event-driven fallback for iOS Chrome/WebKit, where requestAnimationFrame
// may be throttled and media can reach its end between animation frames.
// Keep the original crossfade; never require toggling BGM OFF/ON to restart it.
function bgmRecover(){
 if(!bgmEnabled||!bgmActive||bgmPaused||!bgmDeck)return;
 const deck=bgmDeck;
 if(deck.ended){
  if(bgmNext && !bgmNext.ended){
   deck.pause();deck.volume=0;
   bgmDeck=bgmNext;bgmNext=null;
   bgmDeck.volume=bgmLevel;
   if(bgmDeck.paused)bgmPlay(bgmDeck);
  }else{
   bgmNext=null;
   try{deck.currentTime=0;}catch{}
   deck.volume=bgmLevel;
   bgmPlay(deck);
  }
 }else if(deck.paused && !bgmNext){
  // An unexpected media pause must not permanently silence an active RUSH.
  bgmPlay(deck);
 }
}
for(const player of bgmPlayers){
 player.addEventListener('ended',bgmRecover);
 player.addEventListener('timeupdate',()=>{
  if(bgmActive&&!bgmPaused && player===bgmDeck){
   // A timeupdate event still arrives on many devices when RAF is throttled.
   if(player.ended)bgmRecover();
  }
 });
}
// Low-frequency watchdog: only checks media state, no extra drawing or decoding.
setInterval(bgmRecover,750);

let reelAnimations=[];
async function spinReels(symbols, duration){
 const isReach=String(symbols[0])===String(symbols[2]);
 ui.digits.classList.remove("reach-focus");
 // Visible vertical reel scrolling. Stop order: left (0), right (2), middle (1).
 const base=Math.max(900,Math.min(Number(duration)||1200,4200));
 const offsets=[0,640,320]; // L=first, R=second, M=last
 const tasks=symbols.map((target,i)=>new Promise(resolve=>{
   const reel=$("reel"+(i+1)),track=$("track"+(i+1));
   const h=reel.clientHeight||150;
   const startAt=performance.now();
   const stopAt=base+offsets[i];
   const stepMs=75;
   let lastStep=-1;
   let previous=Number(track.lastElementChild?.textContent)||7;
   function frame(now){
     const elapsed=now-startAt;
     if(elapsed>=stopAt){
       track.innerHTML="";
       const final=document.createElement("span");
       final.id="d"+(i+1);final.textContent=String(target);setSymbolStyle(final,target);
       track.appendChild(final);
       track.style.transform="translate3d(0,0,0)";
       reel.classList.remove("spinning");
       playStopSound();
       // When the right reel stops on the same symbol as the left,
       // pull the outer reels apart and emphasize the still-spinning middle reel.
       if(i===2 && isReach){
         ui.digits.classList.add("reach-focus");
       }
       if(i===1){ui.digits.classList.remove("reach-focus");}
       resolve();return;
     }
     const cycle=Math.floor(elapsed/stepMs);
     if(cycle!==lastStep){
       lastStep=cycle;
       const top=document.createElement("span"),bottom=document.createElement("span");
       top.textContent=String(previous);setSymbolStyle(top,previous);
       previous=rand(10);
       bottom.textContent=String(previous);setSymbolStyle(bottom,previous);
       track.replaceChildren(top,bottom);
     }
     // The lower number enters from above, while the upper one exits below.
     const phase=(elapsed%stepMs)/stepMs;
     track.style.transform=`translate3d(0,${-h+phase*h}px,0)`;
     requestAnimationFrame(frame);
   }
   reel.classList.add("spinning");
   requestAnimationFrame(frame);
 }));
 await Promise.all(tasks);
}

function note(freq=600,duration=.09){if(!sound)return;try{audio??=new (window.AudioContext||window.webkitAudioContext)();const osc=audio.createOscillator(),gain=audio.createGain();osc.type="sine";osc.frequency.value=freq;gain.gain.setValueAtTime(.055,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+duration);osc.connect(gain).connect(audio.destination);osc.start();osc.stop(audio.currentTime+duration)}catch{}}
function parse(){const n=Number(ui.denom.value),s=Number(ui.spins.value),e=0,rows=[...ui.payouts.querySelectorAll(".row")].map(row=>[...row.querySelectorAll("input")].map(x=>Number(x.value)));if(!Number.isFinite(n)||n<1||!Number.isInteger(s)||s<1||s>10000||!Number.isInteger(e)||e<0||e>100)return null;if(!rows.length||rows.some(([balls,p])=>!Number.isInteger(balls)||balls<0||!Number.isFinite(p)||p<0)||Math.abs(rows.reduce((a,r)=>a+r[1],0)-100)>.000001)return null;return {n,s,e,rows};}
function preview(){const v=parse();ui.error.textContent=v?"":"確率・回転数・振り分け（合計100%）を確認してください。";ui.specInfo.textContent=v?`理論継続率：約${((1-Math.pow(1-1/v.n,v.s+v.e))*100).toFixed(2)}% ／ 振り分け合計100%`:"";}
function controls(){const replayArea=$("replayArea");if(replayArea){const finished=Boolean(spec)&&!active&&remaining<=0&&document.getElementById("appRoot").classList.contains("play-mode");replayArea.hidden=!finished;}ui.spin.disabled=!active||busy||autoRunning;ui.auto.disabled=!active||busy;ui.auto.textContent=autoRunning?"回転オート STOP":"回転オート START";ui.auto.classList.toggle("running",autoRunning);$("instant").disabled=!active||busy||autoRunning;ui.start.disabled=busy||autoRunning;ui.mode.textContent=active?"RUSH ACTIVE":"STANDBY";}
// [color, P(hit | color), P(color | hit) before optional global scaling].
// Bayes: P(color | miss) = P(color | hit) * P(hit) * (1-q) / (q*(1-P(hit))).
// The same global scale is applied to both hit/miss color weights when needed,
// preserving the exact conditional hit expectation for each non-white color.
const holdColors=[["blue",.10,.12],["green",.30,.06],["purple",.60,.025],["red",.80,.012],["gold",.90,.005],["rainbow",.98,.001]];
function pickColor(hit){
 const p=1/spec.n;if(p>=1)return "white";
 const miss=holdColors.map(([,q,w])=>w*p*(1-q)/(q*(1-p)));
 const scale=Math.min(1,.75/Math.max(1e-10,miss.reduce((a,b)=>a+b,0)));
 let r=Math.random();
 for(let i=0;i<holdColors.length;i++){r-=(hit?holdColors[i][2]:miss[i])*scale;if(r<0)return holdColors[i][0];}
 return "white";
}
// Independent 80%-reliability haptic cue, unrelated to hold color.
// P(cue|hit)=0.08; P(cue|miss) is chosen so P(hit|cue)=0.8.
function highConfidenceCue(hit){
 const p=1/spec.n;
 const onHit=.08;
 const onMiss=p>=1?0:(onHit*p*.20)/(.80*(1-p));
 return Math.random()<(hit?onHit:Math.min(1,onMiss));
}
// A dedicated, slightly louder file for the special vibrating hold.
// Play from the user-triggered spin flow, avoiding iOS HTMLAudio volume limitations.
const specialVoice=new Audio("special-hold-voice-v104.mp3");
specialVoice.preload="auto";
function playSpecialVoice(){
 if(instantSimulating)return;
 specialNotified++;updateCueDiagnostics();
 if(!sound)return;
 try{
  specialVoice.pause();specialVoice.currentTime=0;
  const result=specialVoice.play();
  if(result&&typeof result.catch==="function")result.catch(err=>console.warn("特殊保留ボイス再生失敗",err));
 }catch(err){console.warn("特殊保留ボイス再生エラー",err);}
}
// One-time milestone voice when cumulative payout first reaches 10,000 balls.
// Keep a separate audio player; this does not change jackpot / pre-alert effects.
const tenThousandVoice=new Audio("ten-thousand-voice-v104.mp3");
tenThousandVoice.preload="auto";
let tenThousandVoicePlayed=false;
let milestoneVoicePending=false;
function playTenThousandVoice(){
 if(tenThousandVoicePlayed||!sound||instantSimulating)return;
 tenThousandVoicePlayed=true;
 try{
  tenThousandVoice.currentTime=0;
  const result=tenThousandVoice.play();
  if(result&&typeof result.catch==="function")result.catch(err=>console.warn("10000玉ボイス再生失敗",err));
 }catch(err){console.warn("10000玉ボイス再生エラー",err);}
}
// Ver.95: fire only after the visible cumulative payout has reached 20,000.
const twentyThousandVoice=new Audio("twenty-thousand-voice-v104.mp3");
twentyThousandVoice.preload="auto";
let twentyThousandVoicePlayed=false;
let twentyThousandVoicePending=false;
function flushTwentyThousandVoice(){
 if(!twentyThousandVoicePending)return;
 twentyThousandVoicePending=false;
 // The caller updates the visible HUD before scheduling this audio.
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(!active||total<20000||twentyThousandVoicePlayed||!sound||instantSimulating)return;
  twentyThousandVoicePlayed=true;
  try{
   twentyThousandVoice.currentTime=0;
   const result=twentyThousandVoice.play();
   if(result&&typeof result.catch==="function")result.catch(err=>console.warn("20000玉ボイス再生失敗",err));
  }catch(err){console.warn("20000玉ボイス再生エラー",err);}
 }));
}
// Ver.105: payout milestones are cued only AFTER the total HUD has been painted.
// Use independent players, but never overlap milestone voices with each other.
const thirtyThousandVoice=new Audio("thirty-thousand-voice-v105.mp3");
const fortyThousandVoice=new Audio("forty-thousand-voice-v105.mp3");
const fiftyThousandVoice=new Audio("fifty-thousand-voice-v105.mp3");
const extraMilestoneVoices=[thirtyThousandVoice,fortyThousandVoice,fiftyThousandVoice];
extraMilestoneVoices.forEach(audio=>audio.preload="auto");
let thirtyThousandVoicePlayed=false,fortyThousandVoicePlayed=false,fiftyThousandVoicePlayed=false;
let thirtyThousandVoicePending=false,fortyThousandVoicePending=false,fiftyThousandVoicePending=false;
// Keep a token to prevent delayed callbacks from a previous RUSH firing in the next.
let payoutCueEpoch=0;
function playPayoutCue(audio,label){
 if(!sound||instantSimulating)return;
 for(const other of [tenThousandVoice,twentyThousandVoice,...extraMilestoneVoices]){
  if(other!==audio){other.pause();other.currentTime=0;}
 }
 try{
  audio.currentTime=0;
  const attempt=audio.play();
  if(attempt&&typeof attempt.catch==="function")attempt.catch(err=>console.warn(label+"ボイス再生失敗",err));
 }catch(err){console.warn(label+"ボイス再生エラー",err);}
}
function flushNewPayoutVoices(){
 const pending=[
  [30000,thirtyThousandVoice,'thirtyThousandVoicePending','thirtyThousandVoicePlayed'],
  [40000,fortyThousandVoice,'fortyThousandVoicePending','fortyThousandVoicePlayed'],
  [50000,fiftyThousandVoice,'fiftyThousandVoicePending','fiftyThousandVoicePlayed']
 ];
 const fired=pending.filter(([threshold])=>threshold<=total&&(
  threshold===30000?thirtyThousandVoicePending:threshold===40000?fortyThousandVoicePending:fiftyThousandVoicePending));
 if(!fired.length)return;
 // Thresholds are monotonic; if a large single payout crosses several, announce the highest.
 const [threshold,audio]=fired.at(-1);
 thirtyThousandVoicePending=false;fortyThousandVoicePending=false;fiftyThousandVoicePending=false;
 const epoch=payoutCueEpoch;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(epoch!==payoutCueEpoch||!active||!sound||instantSimulating||total<threshold)return;
  if(threshold>=30000)thirtyThousandVoicePlayed=true;
  if(threshold>=40000)fortyThousandVoicePlayed=true;
  if(threshold>=50000)fiftyThousandVoicePlayed=true;
  playPayoutCue(audio,threshold+"玉");
 }));
}
// Play once when the displayed RUSH count first reaches 10.
const tenChainVoice=new Audio("ten-chain-voice-v104.mp3");
tenChainVoice.preload="auto";
let tenChainVoicePlayed=false;
let tenChainVoicePending=false;
function flushTenChainVoice(){
 if(!tenChainVoicePending)return;
 tenChainVoicePending=false;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(!active||chain<10||tenChainVoicePlayed||!sound||instantSimulating)return;
  tenChainVoicePlayed=true;
  try{
   tenChainVoice.currentTime=0;
   const attempt=tenChainVoice.play();
   if(attempt&&typeof attempt.catch==="function")attempt.catch(err=>console.warn("10連ボイス再生失敗",err));
  }catch(err){console.warn("10連ボイス再生エラー",err);}
 }));
}
let lastHapticAt=0;
function triggerHighConfidenceHaptic(){
 // Avoid a queue of shake effects during 0.3-second auto spins.
 const now=performance.now();
 if(now-lastHapticAt<200)return;
 lastHapticAt=now;
 // Special hold itself has no pre-alert. Other independent holds keep theirs.
 playSpecialVoice();
 try{if(typeof navigator.vibrate==="function")navigator.vibrate([90,45,120]);}catch(e){}
 const target=$("screen");
 if(target && typeof target.animate==="function"){
  target.animate([{transform:"translateX(0)"},{transform:"translateX(-4px)"},{transform:"translateX(4px)"},{transform:"translateX(-3px)"},{transform:"translateX(3px)"},{transform:"translateX(0)"}],{duration:320,easing:"ease-out"});
 }
}
function newHold(){
 const hit=Math.random()<1/spec.n;
 const haptic=highConfidenceCue(hit);
 if(haptic)specialGenerated++;
 // Never play ordinary pre-alert for the vibrating special hold.
 return {hit,balls:hit?payout():0,color:pickColor(hit),prealert:prealertFor(hit),haptic};
}

// V100: Dispatch exactly once for each *displayed* hold.
// Do not infer alert state from its color or from a DOM class.
function notifyVisiblePrealerts(holds){
 if(!active||instantSimulating||!prealertEnabled)return;
 const freshAlerts=holds.filter(h=>h&&h.prealert&&!h.prealertPlayed);
 if(!freshAlerts.length)return;
 freshAlerts.forEach(h=>{h.prealertPlayed=true;});
 // Keep audio dispatch after hold render; no on-screen diagnostic banner.
 requestAnimationFrame(()=>requestAnimationFrame(()=>{if(active)playPrealert();}));
}

function refill(){
 if(!active)return;
 while(holdQueue.length<Math.min(5,remaining)){
  const hold=newHold();holdQueue.push(hold);
  // A hold carries its own prealert state until it is actually displayed.
  if(hold.haptic && !instantSimulating){hold.specialEntrance=true;}
 }
}
const holdImageMap={white:"hold-white.png",blue:"hold-blue.png",green:"hold-green.png",purple:"hold-purple.png",red:"hold-red.png",gold:"hold-gold.png",rainbow:"hold-rainbow.png"};
const specialHoldImageMap={white:"special-hold-white.png",blue:"special-hold-blue.png",green:"special-hold-green.png",purple:"special-hold-purple.png",red:"special-hold-red.png",gold:"special-hold-gold.png",rainbow:"special-hold-rainbow.png"};
const activeHoldImageMap={white:"active-white.png",blue:"active-blue.png",green:"active-green.png",purple:"active-purple.png",red:"active-red.png",gold:"active-gold.png",rainbow:"active-rainbow.png"};
function attachHoldFace(orb,color,isActive=false,isSpecial=false){
 if(color==="empty")return;
 const face=document.createElement("img");
 face.className="hold-face-img";
 face.src=isSpecial?"special-hold-v90.png":(isActive?activeHoldImageMap:holdImageMap)[color]||holdImageMap.white;
 face.alt="";
 face.draggable=false;
 orb.appendChild(face);
}
function renderHolds(){
 const box=$("holdLamps");box.replaceChildren();
 for(let i=0;i<5;i++){
  const hold=holdQueue[i];
  const orb=document.createElement("span");
  orb.className="hold-orb "+(hold?.color||"empty")+(i===0&&hold?" next":"")+(hold&&i!==0?" waiting-face":"")+(hold?.haptic?" special-cue":"")+(hold?.specialEntrance?" special-enter":"")+(hold?.specialMove?" special-move":"");
  orb.title=hold?`保留 ${i+1}：${hold.color}`:"空き";
  if(hold)attachHoldFace(orb,hold.color,i===0,!!hold.haptic);
  if(hold?.specialEntrance)hold.specialEntrance=false;
  if(hold?.specialMove)hold.specialMove=false;
  box.appendChild(orb);
 }
 $("holdNote").textContent=active?"右から補充 / 左から消化":"STANDBY";
}
async function settleHolds(out){
 const box=$("holdLamps");
 const orbs=[...box.children];
 const first=orbs.find(el=>!el.classList.contains("empty"));
 if(!first){renderHolds();return;}
 // 1) Only AFTER the reel result has stopped: fade the consumed hold slowly.
 const fade=first.animate([
  {opacity:1,transform:"scale(1)",filter:"brightness(1)"},
  {opacity:.75,transform:"scale(.88)",filter:"brightness(1.5)",offset:.45},
  {opacity:0,transform:"scale(.2)",filter:"brightness(.8)"}
 ],{duration:550,easing:"ease-in-out",fill:"forwards"});
 await fade.finished.catch(()=>{});
 fade.cancel();
 first.style.visibility="hidden";
 // 2) The remaining holds glide left, while the rightmost new hold grows from its center.
 const before=orbs.slice(orbs.indexOf(first)+1).filter(el=>!el.classList.contains("empty"));
 // Every surviving special hold shakes after moving one position left.
 // Do not retrigger the special voice: it is an appearance-only effect.
 for(let i=0;i<before.length;i++){
  const movedHold=holdQueue[i];
  if(movedHold?.haptic)movedHold.specialMove=true;
 }
 const rects=before.map(el=>el.getBoundingClientRect());
 // Remove the consumed node first so CSS flex naturally reflows to the left.
 first.remove();
 const moves=before.map((el,i)=>{
  const after=el.getBoundingClientRect();
  const delta=rects[i].left-after.left;
  return el.animate([
   {transform:`translateX(${delta}px)`},
   {transform:"translateX(0px)"}
  ],{duration:490,easing:"cubic-bezier(.2,.75,.25,1)",fill:"forwards"});
 });
 // Add new hold at the far right; keep it hidden until slide is underway.
 const targetCount=Math.min(5,holdQueue.length);
 const missing=Math.max(0,targetCount-before.length);
 const fresh=[];
 for(let k=0;k<missing;k++){
  const index=before.length+k;
  const hold=holdQueue[index];
  const orb=document.createElement("span");
  orb.className="hold-orb "+(hold?.color||"empty");
  orb.style.opacity="0";
  orb.style.transformOrigin="center center";
  if(hold){
   orb.classList.add(index===0?"next":"waiting-face");
   // Preserve the special cue on newly replenished holds (not only on full renders).
   if(hold.haptic){orb.classList.add("special-cue","special-enter");}
   attachHoldFace(orb,hold.color,index===0,!!hold.haptic);
   if(hold.specialEntrance)hold.specialEntrance=false;
  }
  box.appendChild(orb);
  fresh.push(orb);
 }
 await wait(190);
 const growth=fresh.map(el=>{
  el.style.opacity="";
  return el.animate([
   {opacity:0,transform:"scale(.05)"},
   {opacity:.65,transform:"scale(.65)",offset:.65},
   {opacity:1,transform:"scale(1)"}
  ],{duration:450,easing:"cubic-bezier(.18,.8,.2,1)",fill:"forwards"});
 });
 // Dispatch audio after newly appeared holds have been painted.
 if((fresh.some(el=>el.classList.contains("special-cue"))||holdQueue.slice(before.length).some(h=>h?.prealert&&!h.prealertPlayed)) && !instantSimulating){
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(fresh.some(el=>el.classList.contains("special-cue"))){holdQueue.slice(before.length).filter(h=>h?.haptic).forEach(h=>h.specialVoicePlayed=true);triggerHighConfidenceHaptic();}
  const alerts=holdQueue.slice(before.length).filter(h=>h?.prealert&&!h.prealertPlayed);
  if(alerts.length){alerts.forEach(h=>h.prealertPlayed=true);if(fresh.some(el=>el.classList.contains("special-cue")))setTimeout(()=>{if(active)playPrealert();},650);else playPrealert();}
 }
 await Promise.all([...moves,...growth].map(anim=>anim.finished.catch(()=>{})));
 [...moves,...growth].forEach(anim=>anim.cancel());
 renderHolds();
}
function updateHud(){
 $("hudRemain").textContent=spec?Math.min(remaining,spec.s):"---";
 $("hudChain").textContent=String(chain).padStart(2,"0");$("hudTotal").textContent=total.toLocaleString();renderHolds();
}
function stats(){updateHud();ui.chain.textContent=chain;ui.total.innerHTML=total.toLocaleString()+" <em>玉</em>";ui.remain.textContent=active?remaining:"---";}
function flushMilestoneVoice(){
 if(!milestoneVoicePending)return;
 milestoneVoicePending=false;
 // Paint the updated 10,000+ counter before beginning the milestone audio.
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(active && total>=10000)playTenThousandVoice();
 }));
}
function payout(){const x=Math.random()*100;let sum=0;for(const [balls,p] of spec.rows){sum+=p;if(x<sum)return balls;}return spec.rows.at(-1)[0];}
function updateBest(){let best={balls:0,chain:0};try{best=JSON.parse(localStorage.getItem("rushBestClassic"))||best}catch{};if(total>best.balls)best.balls=total;if(chain>best.chain)best.chain=chain;try{localStorage.setItem("rushBestClassic",JSON.stringify(best))}catch{}ui.best.textContent=`${best.balls.toLocaleString()}玉 / ${best.chain}連`;}
function end(){tenChainVoicePending=false;milestoneVoicePending=false;twentyThousandVoicePending=false;thirtyThousandVoicePending=false;fortyThousandVoicePending=false;fiftyThousandVoicePending=false;remaining=0;document.getElementById("replayArea").hidden=false;$("screen").querySelector(".rush-bottom-counter")?.classList.remove("high-confidence-active");pendingPrealerts=0;stopRushVideo();bgmStop();autoRunning=false;active=false;holdQueue=[];ui.message.textContent="RUSH END";ui.sub.textContent=`FINAL RESULT  ${chain}連 / ${total.toLocaleString()}玉`;ui.result.innerHTML=`今回の結果：<strong>${chain}連・${total.toLocaleString()}玉</strong><br>最高記録：<span id="best"></span>`;ui.best=$("best");updateBest();stats();controls();}
function draw(){
 if(!holdQueue.length)refill();
 const hold=holdQueue.shift()||newHold();
 // Active hold warning: 80% independent cue or >=70% color reliability.
 const confidence=hold.haptic?.80:({blue:.10,green:.30,purple:.60,red:.80,gold:.90,rainbow:.98}[hold.color]||0);
 $("screen").querySelector(".rush-bottom-counter")?.classList.toggle("high-confidence-active",confidence>=.70);
 remaining--;spinsDone++;roundSpins++;
 if(hold.hit){chain++;if(chain===10){if(instantSimulating)tenChainVoicePlayed=true;else tenChainVoicePending=true;}const previousTotal=total;total+=hold.balls;if(previousTotal<10000&&total>=10000){if(instantSimulating)tenThousandVoicePlayed=true;else milestoneVoicePending=true;}if(previousTotal<20000&&total>=20000){if(instantSimulating)twentyThousandVoicePlayed=true;else twentyThousandVoicePending=true;}if(previousTotal<30000&&total>=30000){if(instantSimulating)thirtyThousandVoicePlayed=true;else thirtyThousandVoicePending=true;}if(previousTotal<40000&&total>=40000){if(instantSimulating)fortyThousandVoicePlayed=true;else fortyThousandVoicePending=true;}if(previousTotal<50000&&total>=50000){if(instantSimulating)fiftyThousandVoicePlayed=true;else fiftyThousandVoicePending=true;}const hitAt=roundSpins;roundSpins=0;remaining=spec.s+spec.e;refill();return {hit:true,balls:hold.balls,hitAt,color:hold.color};}
 refill();return {hit:false,color:hold.color};
}
function finalSymbols(out){
 // Determine the special presentation only after jackpot and payout are fixed.
 const maximum=Math.max(...spec.rows.filter(row=>row[1]>0).map(row=>row[0]));
 if(out.hit&&out.balls===maximum&&Math.random()<0.25){
  out.special810=true;
  return [8,1,0];
 }
 // Ordinary jackpots always align three identical symbols (0-9).
 if(out.hit){
  const n=rand(10);
  return [n,n,n];
 }
 // Misses are randomized, not sequential 123/456 patterns.
 // Keep some reach misses to preserve the left/right reach animation.
 if(Math.random()<0.18){
  const n=rand(10);
  const middle=(n+1+rand(9))%10; // guaranteed different
  return [n,middle,n];
 }
 // All other misses: three independently drawn symbols,
 // rejecting triple matches, accidental 810 and reach duplicates.
 let a,b,c;
 do{
  a=rand(10);b=rand(10);c=rand(10);
 }while(a===c || (a===8&&b===1&&c===0));
 return [a,b,c];
}

async function showFinal(out,ms){
 ui.digits.classList.toggle("win",false);
 ui.digits.classList.remove("reach-focus","special-810-freeze");
 ui.message.textContent="SPINNING";
 ui.sub.textContent="図柄変動中 / 左 → 右 → 中 の順に停止";
 await spinReels(finalSymbols(out),ms);
 if(out.special810){
  // Freeze all three stopped symbols for about one second, without advancing auto mode.
  ui.digits.classList.add("special-810-freeze");
  await wait(1000);
  ui.digits.classList.remove("special-810-freeze");
 }
 ui.digits.classList.toggle("win",out.hit);
 ui.message.textContent=out.hit?"BONUS":"NEXT";
 ui.sub.textContent=out.hit?`+${out.balls.toLocaleString()}玉 / ${chain}連`:`ハズレ / ST残り${remaining}回転`;
 if(out.hit){
  ui.flash.classList.remove("on");void ui.flash.offsetWidth;ui.flash.classList.add("on");if(!out.special810)playJackpotBounce();playJackpotSound();
 }
 await wait(out.hit?500:160);
}

async function animation(out){await showFinal(out,950);}
async function step(){if(!active||busy)return;unlockEffects();resumeRushMedia();busy=true;controls();const out=draw();logSpin(out);await animation(out);await settleHolds(out);$("screen").querySelector(".rush-bottom-counter")?.classList.remove("high-confidence-active");stats();flushMilestoneVoice();flushTwentyThousandVoice();flushNewPayoutVoices();flushTenChainVoice();if(!out.hit&&remaining<=0)end();else{ui.message.textContent=out.hit?"RUSH CONTINUE":"READY";ui.sub.textContent=out.hit?"NEXT ROUND":"次の変動へ";}busy=false;controls();}
function start(){if(busy)return;document.getElementById("replayArea").hidden=true;$("screen").querySelector(".rush-bottom-counter")?.classList.remove("high-confidence-active");unlockEffects();tenThousandVoice.load();twentyThousandVoice.load();thirtyThousandVoice.load();fortyThousandVoice.load();fiftyThousandVoice.load();tenChainVoice.load();prealertEnabled=$("prealertEnabled").checked;
 prealertNoticeCount=0;prealertGenerated=0;prealertNotified=0;specialGenerated=0;specialNotified=0;updateCueDiagnostics();const v=parse();preview();if(!v)return;playSetupCompleteSound();stopRushVideo();bgmStop();document.getElementById("appRoot").classList.replace("setup-mode","play-mode");window.scrollTo({top:0,behavior:"instant"});spec=v;remaining=v.s+v.e;chain=0;total=0;tenChainVoicePlayed=false;tenChainVoicePending=false;tenChainVoice.pause();tenChainVoice.currentTime=0;tenThousandVoicePlayed=false;milestoneVoicePending=false;tenThousandVoice.pause();tenThousandVoice.currentTime=0;twentyThousandVoicePlayed=false;twentyThousandVoicePending=false;twentyThousandVoice.pause();twentyThousandVoice.currentTime=0;thirtyThousandVoicePlayed=false;thirtyThousandVoicePending=false;thirtyThousandVoice.pause();thirtyThousandVoice.currentTime=0;fortyThousandVoicePlayed=false;fortyThousandVoicePending=false;fortyThousandVoice.pause();fortyThousandVoice.currentTime=0;fiftyThousandVoicePlayed=false;fiftyThousandVoicePending=false;fiftyThousandVoice.pause();fiftyThousandVoice.currentTime=0;payoutCueEpoch++;spinsDone=0;roundSpins=0;autoRunning=false;autoToken++;$("historyLog").innerHTML="";$("progress").textContent="消化回転数：0";active=true;holdQueue=[];pendingPrealerts=0;refill();ui.result.innerHTML='最高記録：<span id="best"></span>';ui.best=$("best");updateBest();ui.message.textContent="RUSH START";ui.sub.textContent="図柄が上から下へ流れて停止";ui.digits.classList.remove("win");digits(["–","–","–"]);stats();controls();
 // Initial holds also count as an appearance, but only after they are drawn.
 if(holdQueue.some(h=>h.haptic||h.prealert))requestAnimationFrame(()=>requestAnimationFrame(()=>{
  if(!active)return;
  if(holdQueue.some(h=>h.haptic)){holdQueue.filter(h=>h.haptic).forEach(h=>h.specialVoicePlayed=true);triggerHighConfidenceHaptic();}
  const alerts=holdQueue.filter(h=>h.prealert&&!h.prealertPlayed);
  if(alerts.length){alerts.forEach(h=>h.prealertPlayed=true);if(holdQueue.some(h=>h.haptic))setTimeout(()=>{if(active)playPrealert();},650);else playPrealert();}
 }));}
function fast(){tenChainVoicePending=false;milestoneVoicePending=false;twentyThousandVoicePending=false;thirtyThousandVoicePending=false;fortyThousandVoicePending=false;fiftyThousandVoicePending=false;$("screen").querySelector(".rush-bottom-counter")?.classList.remove("high-confidence-active");if(!active||busy)return;pendingPrealerts=0;instantSimulating=true;busy=true;controls();let iterations=0;while(active){const out=draw();logSpin(out);iterations++;if(out.hit){ui.message.textContent="BONUS";ui.sub.textContent=`+ ${out.balls.toLocaleString()} BALLS`; }if(!out.hit&&remaining<=0)break;if(iterations>1000000){ui.error.textContent="安全のため100万回転で処理を停止しました。";break;}}pendingPrealerts=0;digits([String(rand(10)),String(rand(10)),String(rand(10))]);stats();end();instantSimulating=false;busy=false;controls();}
$("replay").onclick=()=>{if(busy||active)return;start();};
$("add").onclick=()=>{if(ui.payouts.children.length>=12)return;const row=document.createElement("div");row.className="row";row.innerHTML='<input aria-label="出玉" type="number" min="0" value="1500"><input aria-label="割合" type="number" min="0" value="0"><span>%</span>';ui.payouts.append(row);preview();};
function logSpin(out){$("progress").textContent=`消化回転数：${spinsDone.toLocaleString()}`;const el=document.createElement("div");el.className=out.hit?"hit":"miss";el.textContent=out.hit?`★ ${spinsDone}回転目（ST ${out.hitAt}回転目）：大当たり +${out.balls.toLocaleString()}玉 ／ ${chain}連`:`${spinsDone}回転目：ハズレ（残り${remaining}回転）`;const box=$("historyLog");box.prepend(el);while(box.children.length>180)box.lastChild.remove();}
// Fast path: cap each ordinary spin to ~300ms including visual updates.
// Avoid multiple concurrent reel RAFs and overlapping hold animations.
async function showUltraFast(out){
 ui.digits.classList.remove("win","reach-focus","special-810-freeze");
 const symbols=finalSymbols(out);
 // Lightweight vertical motion; three reels settle together to meet the speed budget.
 for(let i=0;i<3;i++)$("reel"+(i+1)).classList.add("spinning");
 ui.digits.style.transition="filter 100ms linear";
 ui.digits.style.filter="blur(3px)";
 await wait(110);
 digits(symbols);
 for(let i=0;i<3;i++)$("reel"+(i+1)).classList.remove("spinning");
 ui.digits.style.filter="";
 playStopSound();
 if(out.special810){
  ui.digits.classList.add("special-810-freeze");
  await wait(1000); // 810 remains the deliberately longer special effect.
  ui.digits.classList.remove("special-810-freeze");
 }
 ui.digits.classList.toggle("win",out.hit);
 if(out.hit){ui.flash.classList.remove("on");void ui.flash.offsetWidth;ui.flash.classList.add("on");if(!out.special810)playJackpotBounce();playJackpotSound();}
 // Fast-mode holds are redrawn without 1.2s sequential animation.
 renderHolds();
 // Ultra-fast mode previously skipped the special-hold appearance sound.
 const newSpecials=holdQueue.filter(h=>h.haptic&&!h.specialVoicePlayed);
 if(newSpecials.length){newSpecials.forEach(h=>h.specialVoicePlayed=true);triggerHighConfidenceHaptic();}
 const alerts=holdQueue.filter(h=>h.prealert&&!h.prealertPlayed);
 if(alerts.length&&prealertEnabled){alerts.forEach(h=>h.prealertPlayed=true);if(newSpecials.length)setTimeout(()=>{if(active)playPrealert();},650);else playPrealert();}
 updateCueDiagnostics();
 await wait(190);
}
async function autoPlay(){
 if(autoRunning){autoRunning=false;autoToken++;pauseRushMedia();controls();return;}
 if(!active||busy)return;
 unlockEffects();resumeRushMedia();
 autoRunning=true;
 const token=++autoToken;
 controls();
 const valid=()=>autoRunning&&active&&token===autoToken;
 try{
  while(valid()){
   const out=draw();
   logSpin(out);
   const speed=Number($("speed").value);
   if(speed===300){
    await showUltraFast(out);
   }else{
    await showFinal(out,Math.max(700,speed));
    await settleHolds(out);
   }
   if(!valid() && active)break;
   stats();flushMilestoneVoice();flushTwentyThousandVoice();flushNewPayoutVoices();flushTenChainVoice();
   if(!out.hit&&remaining<=0){end();break;}
  }
 }catch(error){
  console.error("Auto spin error:",error);
  ui.error.textContent="オート消化中にエラーが発生しました。コンソールを確認してください。";
 }finally{
  if(token===autoToken){autoRunning=false;if(active)pauseRushMedia();controls();}
 }
}

ui.start.onclick=start;ui.spin.onclick=step;ui.auto.onclick=autoPlay;$("instant").onclick=fast;$("clearHistory").onclick=()=>{$("historyLog").innerHTML="";};ui.sound.onclick=()=>{sound=!sound;ui.sound.textContent=`SOUND: ${sound?"ON":"OFF"}`;if(sound){unlockEffects();note(700);}};document.querySelectorAll("input").forEach(x=>x.addEventListener("input",preview));ui.payouts.addEventListener("input",preview);preview();updateBest();updateHud();controls();

// Two-stage experience: setup first, then immersive large RUSH screen.
$("backSettings").onclick=()=>{
 if(busy)return;
 autoRunning=false;autoToken++;
 stopRushVideo();bgmStop();specialVoice.pause();twentyThousandVoicePending=false;thirtyThousandVoicePending=false;thirtyThousandVoice.pause();fortyThousandVoice.pause();fiftyThousandVoice.pause();payoutCueEpoch++;document.getElementById("replayArea").hidden=true;$("screen").querySelector(".rush-bottom-counter")?.classList.remove("high-confidence-active");active=false;holdQueue=[];pendingPrealerts=0;controls();
 $("appRoot").classList.replace("play-mode","setup-mode");controls();
 exitRushFullscreen();
 window.scrollTo({top:0,behavior:"instant"});
};
// iPhone Chrome/Safari cannot reliably fullscreen arbitrary HTML elements.
// Fall back to a fixed, viewport-filling "immersive" layout on those browsers.
let immersiveFallback=false;
function setFullscreenLabel(){
 $("fullScreen").textContent=(document.fullscreenElement||immersiveFallback)?"⛶ 全画面を終了":"⛶ 全画面表示";
}
function exitRushFullscreen(){
 if(immersiveFallback){
  immersiveFallback=false;
  document.documentElement.classList.remove("rush-immersive");
  document.body.classList.remove("rush-immersive");
 }
 if(document.fullscreenElement && document.exitFullscreen)document.exitFullscreen().catch(()=>{});
 setFullscreenLabel();
}
$("fullScreen").onclick=async()=>{
 if(document.fullscreenElement||immersiveFallback){exitRushFullscreen();return;}
 // Try native fullscreen on browsers that support it, then use iPhone-friendly fallback.
 try{
  if($("machine").requestFullscreen){
   await $("machine").requestFullscreen();
   setFullscreenLabel();return;
  }
 }catch(e){console.info("Native fullscreen unavailable; using immersive viewport mode.");}
 immersiveFallback=true;
 document.documentElement.classList.add("rush-immersive");
 document.body.classList.add("rush-immersive");
 window.scrollTo(0,0);
 setFullscreenLabel();
};
document.addEventListener("fullscreenchange",setFullscreenLabel);

$("bgmToggle").onclick=()=>{
 bgmEnabled=!bgmEnabled;
 $("bgmToggle").textContent=`BGM: ${bgmEnabled?"ON":"OFF"}`;
 if(!bgmEnabled)bgmStop();else if(active&&spinsDone>0&&(autoRunning||busy))bgmResume();
};

// V33: Video and music start together on the FIRST reel spin, not RUSH START.
// Auto STOP pauses both at their current playback positions; Auto START resumes them.
const rushVideo=$('rushBackground');
function playRushVideo(){
 if(!rushVideo)return;
 rushVideo.muted=true;rushVideo.loop=true;
 rushVideo.play().catch(e=>console.warn('背景動画の再生待機中:',e));
}
function pauseRushMedia(){
 bgmPause();
 if(rushVideo)rushVideo.pause();
}
function resumeRushMedia(){
 if(bgmEnabled)bgmResume();
 playRushVideo();
}
function stopRushVideo(){
 if(!rushVideo)return;
 rushVideo.pause();
 try{rushVideo.currentTime=0;}catch{}
}
// If a manual spin ends, pause media too, so it does not run while the draw is idle.
const originalStep=ui.spin.onclick;
ui.spin.onclick=async function(event){
 await originalStep.call(this,event);
 if(active&&!autoRunning)pauseRushMedia();
};

$("prealertEnabled").addEventListener("change",()=>{
 prealertEnabled=$("prealertEnabled").checked;
 updateCueDiagnostics();
 if(!prealertEnabled){pendingPrealerts=0;prealertPlayToken++;prealertSound.pause();prealertSound.currentTime=0;}
});

// Pre-decode the short alert as early as possible. Playback still starts only
// after an explicit user gesture unlocks the AudioContext on iPhone.
window.addEventListener("load",()=>{try{unlockEffects();}catch(e){}},{once:true});

// Preload special artwork to avoid a blank frame during the first rare cue.
const specialHoldPreload=new Image();specialHoldPreload.src="special-hold-v90.png";
