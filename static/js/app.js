// ===== STATE =====
let token = localStorage.getItem('token');
let currentUser = null;
let socket = null;
let roomCode = '';
let myRole = 'user';
let localStream = null;
let screenStream = null;
let peers = {}; // sid -> {pc, stream, username, audio, video, audioEl}
let audioEnabled = true;
let videoEnabled = true;
let isRecording = false;
let mediaRecorder = null;
let recordedChunks = [];
let callTimer = null;
let callSeconds = 0;
let chatOpen = false;
let participantsOpen = false;
let speakerInterval = null;
let audioContext = null;
let audioAnalyser = null;
let screenShareAllowed = false;
let isScreenSharing = false;
let pinnedSid = null;
let handRaised = false;
const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent);

const ICE = {iceServers:[
  {urls:'stun:stun.l.google.com:19302'},
  {urls:'stun:stun1.l.google.com:19302'},
  {urls:'stun:stun2.l.google.com:19302'}
], iceCandidatePoolSize:10};

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  if (token) { verifyToken(); } else { showAuth(); }
});

function showAuth() {
  document.getElementById('auth-screen').style.display='flex';
  document.getElementById('lobby-screen').style.display='none';
  document.getElementById('meeting-screen').style.display='none';
}

function showLobby() {
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('lobby-screen').style.display='flex';
  document.getElementById('meeting-screen').style.display='none';
  document.getElementById('lobby-user').textContent=currentUser.username;
  document.getElementById('lobby-avatar').textContent=currentUser.username[0].toUpperCase();
  connectSocket();
}

function showMeeting() {
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('lobby-screen').style.display='none';
  document.getElementById('meeting-screen').style.display='flex';
}

// ===== AUTH =====
async function verifyToken() {
  try {
    const r = await fetch('/api/auth/me',{headers:{'Authorization':'Bearer '+token}});
    if(r.ok){const d=await r.json();currentUser=d.user;showLobby();}
    else{localStorage.removeItem('token');token=null;showAuth();}
  } catch(e){localStorage.removeItem('token');token=null;showAuth();}
}

function showLogin(){
  document.getElementById('login-form').style.display='block';
  document.getElementById('register-form').style.display='none';
}
function showRegister(){
  document.getElementById('login-form').style.display='none';
  document.getElementById('register-form').style.display='block';
}

async function doLogin(){
  const u=document.getElementById('login-user').value.trim();
  const p=document.getElementById('login-pass').value;
  const err=document.getElementById('login-error');
  err.style.display='none';
  if(!u||!p){err.textContent='Fill all fields';err.style.display='block';return;}
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json();
    if(r.ok){token=d.token;localStorage.setItem('token',token);currentUser=d.user;showLobby();}
    else{err.textContent=d.error||'Login failed';err.style.display='block';}
  }catch(e){err.textContent='Network error';err.style.display='block';}
}

async function doRegister(){
  const u=document.getElementById('reg-user').value.trim();
  const e=document.getElementById('reg-email').value.trim();
  const p=document.getElementById('reg-pass').value;
  const err=document.getElementById('reg-error');
  err.style.display='none';
  if(!u||!e||!p){err.textContent='Fill all fields';err.style.display='block';return;}
  try{
    const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,email:e,password:p})});
    const d=await r.json();
    if(r.ok){token=d.token;localStorage.setItem('token',token);currentUser=d.user;showLobby();}
    else{err.textContent=d.error||'Registration failed';err.style.display='block';}
  }catch(e2){err.textContent='Network error';err.style.display='block';}
}

function doLogout(){
  localStorage.removeItem('token');token=null;currentUser=null;
  if(socket){socket.disconnect();}
  showAuth();
}

// ===== SOCKET =====
function connectSocket(){
  if(socket&&socket.connected)return;
  socket=io({transports:['websocket','polling'],reconnection:true,reconnectionDelay:1000,reconnectionDelayMax:5000});
  socket.on('connect',()=>{socket.emit('authenticate',{token});});
  socket.on('authenticated',()=>{toast('Connected','success');});
  socket.on('auth_error',(d)=>{toast(d.message,'error');doLogout();});
  socket.on('error_message',(d)=>{toast(d.message,'error');});
  socket.on('room_created',(d)=>{enterRoom(d);});
  socket.on('room_joined',(d)=>{enterRoom(d);});
  socket.on('user_joined',(d)=>{updateParticipants(d.participants);toast(d.username+' joined');
    // new peer arrived - they will initiate offers to us via join_call
  });
  socket.on('user_left',(d)=>{updateParticipants(d.participants);removePeer(d.sid);toast(d.username+' left');});
  socket.on('host_changed',(d)=>{
    if(d.new_host_sid===socket.id){myRole='host';toast('You are now the host','success');}
    updateParticipants(d.participants);
  });
  socket.on('system_message',(d)=>{addSystemMsg(d.text);});
  socket.on('receive_message',(d)=>{addChatMsg(d);highlightChat();});
  socket.on('kicked',()=>{toast('Removed by host','error');leaveMeeting();});
  socket.on('call_ended_by_host',()=>{toast('Host ended the call','error');leaveMeeting();});
  socket.on('force_mute',(d)=>{
    if(localStream){localStream.getAudioTracks().forEach(t=>t.enabled=false);}
    audioEnabled=false;updateToolbarState();toast('Muted by '+d.by);
    socket.emit('toggle_audio',{enabled:false});
  });
  socket.on('force_video_off',(d)=>{
    if(localStream){localStream.getVideoTracks().forEach(t=>t.enabled=false);}
    videoEnabled=false;updateToolbarState();updateLocalTile();toast('Camera disabled by '+d.by);
    socket.emit('toggle_video',{enabled:false});
  });
  // WebRTC signaling
  socket.on('call_peers',(d)=>{d.peers.forEach(p=>createPeer(p.sid,p.username,true));});
  socket.on('new_peer',(d)=>{createPeer(d.sid,d.username,false);});
  socket.on('peer_left',(d)=>{removePeer(d.sid);});
  socket.on('webrtc_offer',async(d)=>{await handleOffer(d);});
  socket.on('webrtc_answer',async(d)=>{await handleAnswer(d);});
  socket.on('webrtc_ice',async(d)=>{await handleIce(d);});
  socket.on('peer_audio_toggle',(d)=>{
    if(peers[d.sid])peers[d.sid].audio=d.enabled;
    updateTileStatus(d.sid);updateParticipantsList();
  });
  socket.on('peer_video_toggle',(d)=>{
    if(peers[d.sid])peers[d.sid].video=d.enabled;
    updateTileVideo(d.sid);updateParticipantsList();
  });
  socket.on('speaker_update',(d)=>{
    const tile=document.getElementById('tile-'+d.sid);
    if(tile){
      if(d.level>30)tile.classList.add('speaking');
      else tile.classList.remove('speaking');
    }
  });
  // Screen share permission events
  socket.on('screen_share_request_received',(d)=>{showScreenShareRequest(d.requester_sid,d.requester_name);});
  socket.on('screen_share_approved',()=>{toast('Screen share approved!','success');screenShareAllowed=true;doStartScreenShare();});
  socket.on('screen_share_rejected',()=>{toast('Screen share request rejected','error');});
  socket.on('screen_share_permission_changed',(d)=>{
    screenShareAllowed=d.allowed;
    toast(d.message,d.allowed?'success':'error');
    if(!d.allowed&&isScreenSharing){stopScreenShareLocal();}
  });
  socket.on('force_stop_screen_share',(d)=>{toast('Screen share stopped by '+d.by,'error');stopScreenShareLocal();});
  socket.on('peer_screen_sharing',(d)=>{toast(d.username+' is sharing their screen');});
  socket.on('peer_screen_share_stopped',(d)=>{toast(d.username+' stopped sharing');});
  socket.on('participants_updated',(d)=>{updateParticipants(d.participants);});
  // Hand raise
  socket.on('peer_hand_raise',(d)=>{
    const tile=document.getElementById('tile-'+(d.sid===socket.id?'local':d.sid));
    if(tile){if(d.raised){tile.classList.add('hand-raised');let hi=tile.querySelector('.hand-indicator');if(!hi){hi=document.createElement('div');hi.className='hand-indicator';hi.textContent='✋';tile.appendChild(hi);}}else{tile.classList.remove('hand-raised');const hi=tile.querySelector('.hand-indicator');if(hi)hi.remove();}}
    if(d.sid!==socket.id)toast(d.username+(d.raised?' raised hand':' lowered hand'));
  });
  // Emoji reactions
  socket.on('peer_emoji_reaction',(d)=>{showFloatingEmoji(d.emoji,d.username);});
  socket.on('disconnect',()=>{toast('Disconnected','error');});
}

// ===== ROOM =====
function createRoom(){
  const name=document.getElementById('room-name-input').value.trim()||currentUser.username+"'s Room";
  socket.emit('create_room',{name});
}

function joinRoom(){
  const code=document.getElementById('room-code-input').value.trim();
  if(!code){toast('Enter room code','error');return;}
  socket.emit('join_room_request',{room_code:code});
}

async function enterRoom(data){
  roomCode=data.room.code;myRole=data.role;
  screenShareAllowed=(myRole==='host');
  isScreenSharing=false;
  showMeeting();
  document.getElementById('room-code-display').textContent=roomCode;
  updateParticipants(data.participants);
  loadChatHistory();
  // get media and join call
  try{
    localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    audioEnabled=true;videoEnabled=true;
  }catch(e){
    try{localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});audioEnabled=true;videoEnabled=false;}
    catch(e2){toast('No camera/mic access','error');localStream=null;}
  }
  renderLocalTile();
  startSpeakerDetection();
  socket.emit('join_call',{});
  startTimer();
  updateToolbarState();
}

async function loadChatHistory(){
  try{
    const r=await fetch('/api/rooms/'+roomCode+'/messages',{headers:{'Authorization':'Bearer '+token}});
    if(r.ok){const d=await r.json();d.messages.forEach(m=>addChatMsg(m));}
  }catch(e){}
}

function leaveMeeting(){
  stopTimer();stopSpeakerDetection();stopRecording();
  if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;}
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  Object.keys(peers).forEach(sid=>removePeer(sid));
  socket.emit('leave_call',{});
  socket.emit('leave_room_request',{});
  roomCode='';myRole='user';
  document.getElementById('video-grid').innerHTML='';
  document.getElementById('chat-messages').innerHTML='';
  showLobby();
}

// ===== WEBRTC =====
async function createPeer(sid,username,initiator){
  if(peers[sid])return;
  const pc=new RTCPeerConnection(ICE);
  const peer={pc,stream:null,username,audio:true,video:true,audioEl:null,pendingIce:[]};
  peers[sid]=peer;
  // Add local tracks
  if(localStream){
    localStream.getTracks().forEach(t=>{
      pc.addTrack(t,localStream);
    });
  } else {
    // Add empty transceiver so audio/video is negotiated
    pc.addTransceiver('audio',{direction:'sendrecv'});
    pc.addTransceiver('video',{direction:'sendrecv'});
  }
  pc.ontrack=(e)=>{
    peer.stream=e.streams[0];
    renderPeerTile(sid);
    // Create audio element for reliable remote audio playback
    if(!peer.audioEl){
      const a=document.createElement('audio');
      a.autoplay=true;a.playsInline=true;a.volume=1.0;
      a.style.cssText='position:absolute;opacity:0;pointer-events:none;';
      document.body.appendChild(a);peer.audioEl=a;
    }
    peer.audioEl.srcObject=e.streams[0];
    // Aggressively try to play audio
    function tryPlayAudio(){
      if(!peer.audioEl)return;
      peer.audioEl.play().then(()=>{
        console.log('Audio playing for',username);
      }).catch(()=>{
        // Retry on any user interaction
        ['click','touchstart','keydown'].forEach(evt=>{
          document.addEventListener(evt,function retryPlay(){
            if(peer.audioEl)peer.audioEl.play().catch(()=>{});
            document.removeEventListener(evt,retryPlay);
          },{once:true});
        });
      });
    }
    tryPlayAudio();
    // Also retry after a short delay
    setTimeout(tryPlayAudio,1000);
  };
  pc.onicecandidate=(e)=>{
    if(e.candidate)socket.emit('webrtc_ice',{target_sid:sid,candidate:e.candidate});
  };
  pc.oniceconnectionstatechange=()=>{
    if(pc.iceConnectionState==='failed'){
      pc.restartIce&&pc.restartIce();
    } else if(pc.iceConnectionState==='connected'){
      // Force play audio when connected
      if(peer.audioEl)peer.audioEl.play().catch(()=>{});
    }
  };
  if(initiator){
    try{
      const offer=await pc.createOffer({offerToReceiveAudio:true,offerToReceiveVideo:true});
      await pc.setLocalDescription(offer);
      socket.emit('webrtc_offer',{target_sid:sid,offer});
    }catch(e){console.error('Offer error',e);}
  }
  renderPeerTile(sid);
}

async function handleOffer(data){
  let peer=peers[data.sender_sid];
  if(!peer)await createPeer(data.sender_sid,data.sender_name,false);
  peer=peers[data.sender_sid];if(!peer)return;
  try{
    await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const answer=await peer.pc.createAnswer();await peer.pc.setLocalDescription(answer);
    socket.emit('webrtc_answer',{target_sid:data.sender_sid,answer});
    peer.pendingIce.forEach(c=>peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{}));
    peer.pendingIce=[];
  }catch(e){console.error('Answer error',e);}
}

async function handleAnswer(data){
  const peer=peers[data.sender_sid];if(!peer)return;
  try{await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    peer.pendingIce.forEach(c=>peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{}));
    peer.pendingIce=[];
  }catch(e){console.error('setRemote error',e);}
}

async function handleIce(data){
  const peer=peers[data.sender_sid];if(!peer)return;
  try{
    if(peer.pc.remoteDescription)await peer.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    else peer.pendingIce.push(data.candidate);
  }catch(e){}
}

function removePeer(sid){
  const peer=peers[sid];
  if(peer){
    peer.pc.close();
    if(peer.audioEl){peer.audioEl.srcObject=null;peer.audioEl.remove();}
    delete peers[sid];
  }
  const tile=document.getElementById('tile-'+sid);if(tile)tile.remove();
  updateGridLayout();
}

// ===== VIDEO TILES =====
function renderLocalTile(){
  const grid=document.getElementById('video-grid');
  let tile=document.getElementById('tile-local');
  if(!tile){
    tile=document.createElement('div');tile.id='tile-local';tile.className='video-tile';
    grid.insertBefore(tile,grid.firstChild);
  }
  tile.innerHTML='';
  // Pin button
  const pinBtn=document.createElement('button');pinBtn.className='pin-btn';pinBtn.title='Pin this video';
  pinBtn.textContent=pinnedSid==='local'?'📌':'📍';
  pinBtn.onclick=(e)=>{e.stopPropagation();pinTile('local');};
  tile.appendChild(pinBtn);
  if(localStream&&videoEnabled){
    const v=document.createElement('video');v.srcObject=localStream;v.autoplay=true;v.muted=true;v.playsInline=true;
    v.style.transform='scaleX(-1)';tile.appendChild(v);
  }else{
    const av=document.createElement('div');av.className='avatar-placeholder';
    av.textContent=currentUser?currentUser.username[0].toUpperCase():'?';tile.appendChild(av);
  }
  const lbl=document.createElement('div');lbl.className='tile-label';
  lbl.innerHTML=(currentUser?currentUser.username:'You')+' (You) '+(audioEnabled?'🎤':'<span class="mic-off">🔇</span>');
  tile.appendChild(lbl);
  if(pinnedSid==='local')tile.classList.add('pinned');else tile.classList.remove('pinned');
  updateGridLayout();
}

function updateLocalTile(){renderLocalTile();}

function renderPeerTile(sid){
  const peer=peers[sid];if(!peer)return;
  const grid=document.getElementById('video-grid');
  let tile=document.getElementById('tile-'+sid);
  if(!tile){
    tile=document.createElement('div');tile.id='tile-'+sid;tile.className='video-tile';
    grid.appendChild(tile);
  }
  tile.innerHTML='';
  // Pin button
  const pinBtn=document.createElement('button');pinBtn.className='pin-btn';pinBtn.title='Pin this video';
  pinBtn.textContent=pinnedSid===sid?'📌':'📍';
  pinBtn.onclick=(e)=>{e.stopPropagation();pinTile(sid);};
  tile.appendChild(pinBtn);
  if(peer.stream&&peer.video!==false){
    const v=document.createElement('video');v.srcObject=peer.stream;v.autoplay=true;v.playsInline=true;
    tile.appendChild(v);
  }else{
    const av=document.createElement('div');av.className='avatar-placeholder';
    av.textContent=peer.username?peer.username[0].toUpperCase():'?';tile.appendChild(av);
  }
  const lbl=document.createElement('div');lbl.className='tile-label';
  lbl.innerHTML=peer.username+(peer.audio!==false?' 🎤':' <span class="mic-off">🔇</span>');
  tile.appendChild(lbl);
  // host actions
  if(myRole==='host'){
    const ha=document.createElement('div');ha.className='host-actions';
    ha.innerHTML=`<button onclick="hostMute('${sid}')" title="Mute">🔇</button><button onclick="hostVideoOff('${sid}')" title="Cam off">📷</button><button onclick="hostKick('${sid}')" title="Kick">❌</button>`;
    tile.appendChild(ha);
  }
  if(pinnedSid===sid)tile.classList.add('pinned');else tile.classList.remove('pinned');
  updateGridLayout();
}

function updateTileStatus(sid){
  const peer=peers[sid];if(!peer)return;
  const tile=document.getElementById('tile-'+sid);if(!tile)return;
  const lbl=tile.querySelector('.tile-label');
  if(lbl)lbl.innerHTML=peer.username+(peer.audio!==false?' 🎤':' <span class="mic-off">🔇</span>');
}

function updateTileVideo(sid){renderPeerTile(sid);}

function updateGridLayout(){
  const grid=document.getElementById('video-grid');
  const count=grid.children.length;
  if(pinnedSid){
    grid.setAttribute('data-count','pinned');
  } else {
    grid.setAttribute('data-count',Math.min(count,10));
  }
}

// ===== TOOLBAR =====
function toggleAudio(){
  if(!localStream)return;
  audioEnabled=!audioEnabled;
  localStream.getAudioTracks().forEach(t=>t.enabled=audioEnabled);
  socket.emit('toggle_audio',{enabled:audioEnabled});
  updateToolbarState();renderLocalTile();
}

function toggleVideo(){
  if(!localStream)return;
  videoEnabled=!videoEnabled;
  localStream.getVideoTracks().forEach(t=>t.enabled=videoEnabled);
  socket.emit('toggle_video',{enabled:videoEnabled});
  updateToolbarState();renderLocalTile();
}

async function toggleScreenShare(){
  if(isScreenSharing){
    stopScreenShareLocal();
    socket.emit('stop_screen_share');
    return;
  }
  // Check if getDisplayMedia is available
  if(!navigator.mediaDevices||!navigator.mediaDevices.getDisplayMedia){
    toast('Screen sharing not supported on this device','error');
    return;
  }
  // Host can share directly, users need permission
  if(myRole==='host'||screenShareAllowed){
    doStartScreenShare();
  } else {
    socket.emit('screen_share_request');
    toast('Screen share request sent to host...');
  }
}

async function doStartScreenShare(){
  const btn=document.getElementById('btn-screen');
  try{
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always'},audio:false});
    const st=screenStream.getVideoTracks()[0];
    if(st.contentHint!==undefined)st.contentHint='detail';
    // Replace video track in all peer connections
    const replacePromises=[];
    Object.values(peers).forEach(p=>{
      const sender=p.pc.getSenders().find(s=>s.track&&s.track.kind==='video');
      if(sender)replacePromises.push(sender.replaceTrack(st));
    });
    await Promise.all(replacePromises);
    st.onended=()=>{stopScreenShareLocal();socket.emit('stop_screen_share');};
    btn.classList.add('active');
    isScreenSharing=true;
    socket.emit('start_screen_share');
    // show screen in local tile
    const tile=document.getElementById('tile-local');
    if(tile){tile.innerHTML='';const v=document.createElement('video');v.srcObject=screenStream;v.autoplay=true;v.muted=true;v.playsInline=true;tile.appendChild(v);
      const lbl=document.createElement('div');lbl.className='tile-label';lbl.innerHTML='🖥️ Screen Share';tile.appendChild(lbl);}
  }catch(e){toast('Screen share cancelled or not supported');}
}

function stopScreenShareLocal(){
  const btn=document.getElementById('btn-screen');
  if(screenStream){screenStream.getTracks().forEach(t=>t.stop());screenStream=null;}
  isScreenSharing=false;
  // restore camera
  if(localStream){
    const vt=localStream.getVideoTracks()[0];
    if(vt)Object.values(peers).forEach(p=>{const sender=p.pc.getSenders().find(s=>s.track&&s.track.kind==='video');if(sender)sender.replaceTrack(vt);});
  }
  if(btn)btn.classList.remove('active');
  renderLocalTile();
}

function showScreenShareRequest(requesterSid,requesterName){
  // Remove existing modal if any
  const old=document.getElementById('screen-share-modal');if(old)old.remove();
  const modal=document.createElement('div');modal.id='screen-share-modal';modal.className='ss-request-modal';
  modal.innerHTML=`<div class="ss-request-card">
    <div class="ss-request-icon">🖥️</div>
    <h3>Screen Share Request</h3>
    <p><strong>${esc(requesterName)}</strong> wants to share their screen</p>
    <div class="ss-request-actions">
      <button class="btn btn-success btn-sm" onclick="respondScreenShare('${requesterSid}',true)">✓ Allow</button>
      <button class="btn btn-danger btn-sm" onclick="respondScreenShare('${requesterSid}',false)">✕ Deny</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  // Auto-dismiss after 30s
  setTimeout(()=>{const m=document.getElementById('screen-share-modal');if(m)m.remove();},30000);
}

function respondScreenShare(sid,approved){
  socket.emit('screen_share_respond',{target_sid:sid,approved});
  const m=document.getElementById('screen-share-modal');if(m)m.remove();
  toast(approved?'Screen share allowed':'Screen share denied');
}

function toggleRecordBtn(){
  if(isRecording){stopRecording();}else{startRecording();}
}

function startRecording(){
  if(!localStream||isRecording)return;
  const tracks=[];
  if(localStream)localStream.getTracks().forEach(t=>tracks.push(t));
  // add remote audio tracks
  Object.values(peers).forEach(p=>{if(p.stream)p.stream.getAudioTracks().forEach(t=>tracks.push(t));});
  const combined=new MediaStream(tracks);
  recordedChunks=[];
  const mimeTypes=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
  let selectedMime='';
  for(const mime of mimeTypes){if(MediaRecorder.isTypeSupported(mime)){selectedMime=mime;break;}}
  try{
    mediaRecorder=new MediaRecorder(combined,selectedMime?{mimeType:selectedMime}:undefined);
  }catch(e){toast('Recording not supported on this device','error');return;}
  mediaRecorder.ondataavailable=(e)=>{if(e.data.size>0)recordedChunks.push(e.data);};
  mediaRecorder.onstop=()=>{saveRecording();};
  mediaRecorder.start(1000);isRecording=true;
  document.getElementById('btn-record').classList.add('active','recording');
  toast('⏺ Recording started','success');
}

function stopRecording(){
  if(!isRecording||!mediaRecorder)return;
  mediaRecorder.stop();isRecording=false;
  document.getElementById('btn-record').classList.remove('active','recording');
  toast('Recording stopped — saving...');
}

function saveRecording(){
  const ext=mediaRecorder&&mediaRecorder.mimeType&&mediaRecorder.mimeType.includes('mp4')?'mp4':'webm';
  const blob=new Blob(recordedChunks,{type:mediaRecorder?mediaRecorder.mimeType:'video/webm'});
  const now=new Date();
  const ts=now.toISOString().slice(0,19).replace(/[T:]/g,'-');
  const filename=`NexusMeating_${roomCode}_${ts}.${ext}`;
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),5000);
  toast(`✅ Recording saved: ${filename}`,'success');
}

function updateToolbarState(){
  const am=document.getElementById('btn-mic');
  const vc=document.getElementById('btn-cam');
  if(am){am.classList.toggle('active',!audioEnabled);am.textContent=audioEnabled?'🎤':'🔇';}
  if(vc){vc.classList.toggle('active',!videoEnabled);vc.textContent=videoEnabled?'📹':'🚫';}
}

// ===== CHAT =====
function toggleChat(){
  chatOpen=!chatOpen;
  document.getElementById('chat-panel').classList.toggle('open',chatOpen);
  if(chatOpen){participantsOpen=false;document.getElementById('participants-panel').classList.remove('open');}
  const badge=document.getElementById('chat-badge');if(badge)badge.style.display='none';
}

function toggleParticipants(){
  participantsOpen=!participantsOpen;
  document.getElementById('participants-panel').classList.toggle('open',participantsOpen);
  if(participantsOpen){chatOpen=false;document.getElementById('chat-panel').classList.remove('open');}
}

function sendChat(){
  const inp=document.getElementById('chat-input');
  const text=inp.value.trim();if(!text)return;
  socket.emit('send_message',{text});inp.value='';
}

function chatKeyPress(e){if(e.key==='Enter')sendChat();}

function addChatMsg(d){
  const box=document.getElementById('chat-messages');
  const div=document.createElement('div');div.className='chat-msg';
  div.innerHTML=`<div class="msg-header"><span class="msg-name">${esc(d.username)}</span><span class="msg-time">${d.timestamp||d.created_at||''}</span></div><div class="msg-body">${esc(d.content)}</div>`;
  box.appendChild(div);box.scrollTop=box.scrollHeight;
}

function addSystemMsg(text){
  const box=document.getElementById('chat-messages');
  const div=document.createElement('div');div.className='chat-msg system';div.textContent=text;
  box.appendChild(div);box.scrollTop=box.scrollHeight;
}

function highlightChat(){
  if(!chatOpen){
    let badge=document.getElementById('chat-badge');
    if(badge)badge.style.display='flex';
  }
}

// ===== PARTICIPANTS =====
function updateParticipants(list){
  const pl=document.getElementById('participants-list');
  const pc=document.getElementById('participants-count');
  if(pc)pc.textContent=list?list.length:0;
  if(!pl)return;pl.innerHTML='';
  (list||[]).forEach(p=>{
    const isMe=p.sid===socket.id;
    const div=document.createElement('div');div.className='participant-item';
    let actions='';
    if(myRole==='host'&&!isMe){
      const ssAllowed=p.screen_share_allowed;
      const ssActive=p.is_screen_sharing;
      let ssBtn=ssAllowed
        ?`<button onclick="revokeScreenShare('${p.sid}')" title="Revoke screen share" class="ss-revoke">🖥️✕</button>`
        :`<button onclick="grantScreenShare('${p.sid}')" title="Grant screen share" class="ss-grant">🖥️✓</button>`;
      if(ssActive) ssBtn+=`<button onclick="forceStopScreenShare('${p.sid}')" title="Stop sharing" class="ss-stop">⏹️</button>`;
      actions=`<div class="p-actions">${ssBtn}<button onclick="hostMute('${p.sid}')" title="Mute">🔇</button><button onclick="hostVideoOff('${p.sid}')" title="Cam off">📷</button><button onclick="hostKick('${p.sid}')" title="Kick">❌</button></div>`;
    }
    const ssIndicator=p.is_screen_sharing?'<span class="ss-badge">🖥️</span>':'';
    div.innerHTML=`<div class="p-avatar">${(p.username||'?')[0].toUpperCase()}</div><div class="p-info"><div class="p-name">${esc(p.username)}${isMe?' (You)':''}${ssIndicator}</div>${p.role==='host'?'<div class="p-role">Host</div>':''}</div><div class="p-status">${p.audio!==false?'🎤':'🔇'}${p.video!==false?'📹':'🚫'}</div>${actions}`;
    pl.appendChild(div);
  });
}

function updateParticipantsList(){
  // rebuild from peers + self
  const list=[{sid:socket.id,username:currentUser.username,role:myRole,audio:audioEnabled,video:videoEnabled}];
  Object.entries(peers).forEach(([sid,p])=>{list.push({sid,username:p.username,role:'user',audio:p.audio,video:p.video});});
  updateParticipants(list);
}

// ===== HOST CONTROLS =====
function hostMute(sid){socket.emit('mute_user',{target_sid:sid});}
function hostVideoOff(sid){socket.emit('disable_video_user',{target_sid:sid});}
function hostKick(sid){if(confirm('Remove this user?'))socket.emit('kick_user',{target_sid:sid});}
function endCallAll(){if(confirm('End call for everyone?'))socket.emit('end_call_all');}
function grantScreenShare(sid){socket.emit('grant_screen_share',{target_sid:sid});}
function revokeScreenShare(sid){socket.emit('revoke_screen_share',{target_sid:sid});}
function forceStopScreenShare(sid){socket.emit('force_stop_user_screen_share',{target_sid:sid});}

// ===== SPEAKER DETECTION =====
function startSpeakerDetection(){
  if(!localStream||!localStream.getAudioTracks().length)return;
  try{
    audioContext=new(window.AudioContext||window.webkitAudioContext)();
    const source=audioContext.createMediaStreamSource(localStream);
    audioAnalyser=audioContext.createAnalyser();audioAnalyser.fftSize=512;
    source.connect(audioAnalyser);
    const data=new Uint8Array(audioAnalyser.frequencyBinCount);
    speakerInterval=setInterval(()=>{
      audioAnalyser.getByteFrequencyData(data);
      let sum=0;for(let i=0;i<data.length;i++)sum+=data[i];
      const avg=sum/data.length;
      const tile=document.getElementById('tile-local');
      if(tile){if(avg>20)tile.classList.add('speaking');else tile.classList.remove('speaking');}
      socket.emit('active_speaker',{level:avg});
    },300);
  }catch(e){}
}

function stopSpeakerDetection(){
  if(speakerInterval)clearInterval(speakerInterval);
  if(audioContext)audioContext.close().catch(()=>{});
  audioContext=null;audioAnalyser=null;
}

// ===== TIMER =====
function startTimer(){
  callSeconds=0;
  const el=document.getElementById('call-timer');
  callTimer=setInterval(()=>{
    callSeconds++;
    const m=String(Math.floor(callSeconds/60)).padStart(2,'0');
    const s=String(callSeconds%60).padStart(2,'0');
    if(el)el.textContent=m+':'+s;
  },1000);
}

function stopTimer(){if(callTimer)clearInterval(callTimer);callTimer=null;}

// ===== UTILS =====
function esc(s){const d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}

function toast(msg,type){
  let c=document.getElementById('toast-container');
  if(!c){c=document.createElement('div');c.id='toast-container';c.className='toast-container';document.body.appendChild(c);}
  const t=document.createElement('div');t.className='toast';
  t.style.borderLeft=type==='error'?'3px solid var(--danger)':type==='success'?'3px solid var(--success)':'3px solid var(--accent)';
  t.textContent=msg;c.appendChild(t);
  setTimeout(()=>t.remove(),3000);
}

function copyRoomCode(){
  navigator.clipboard.writeText(roomCode).then(()=>toast('Code copied!','success')).catch(()=>{});
}

// ===== PIN / SPOTLIGHT =====
function pinTile(sid){
  if(pinnedSid===sid){pinnedSid=null;}else{pinnedSid=sid;}
  // Re-render all tiles
  renderLocalTile();
  Object.keys(peers).forEach(s=>renderPeerTile(s));
}

// ===== HAND RAISE =====
function toggleHandRaise(){
  handRaised=!handRaised;
  socket.emit('hand_raise',{raised:handRaised});
  const btn=document.getElementById('btn-hand');
  if(btn){btn.classList.toggle('active',handRaised);btn.textContent=handRaised?'✋':'🤚';}
  toast(handRaised?'Hand raised':'Hand lowered');
}

// ===== EMOJI REACTIONS =====
function toggleReactions(){
  const popup=document.getElementById('reactions-popup');
  if(popup)popup.classList.toggle('open');
}

function sendEmoji(emoji){
  socket.emit('emoji_reaction',{emoji});
  showFloatingEmoji(emoji,currentUser?currentUser.username:'You');
  const popup=document.getElementById('reactions-popup');
  if(popup)popup.classList.remove('open');
}

function showFloatingEmoji(emoji,username){
  const container=document.getElementById('video-area')||document.querySelector('.video-area');
  if(!container)return;
  const el=document.createElement('div');el.className='floating-emoji';
  el.innerHTML=`<span class="fe-emoji">${emoji}</span><span class="fe-name">${esc(username)}</span>`;
  el.style.left=Math.random()*60+20+'%';
  container.appendChild(el);
  setTimeout(()=>el.remove(),3000);
}

// ===== FULLSCREEN =====
function toggleFullscreen(){
  if(!document.fullscreenElement){
    document.documentElement.requestFullscreen().catch(()=>{});
  }else{
    document.exitFullscreen().catch(()=>{});
  }
}

// ===== AUDIO PLAYBACK FIX =====
document.addEventListener('click',function ensureAudio(){
  // Resume any suspended AudioContext
  if(audioContext&&audioContext.state==='suspended')audioContext.resume();
  // Force play all peer audio elements
  Object.values(peers).forEach(p=>{if(p.audioEl)p.audioEl.play().catch(()=>{});});
},{once:false});
