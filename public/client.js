import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';

const socket = io();
let device;
let producerTransport;
let consumerTransport;
let producers = new Map();

// --- STATE ---
let myRoomId = '';
let myName = '';
let amHost = false;
let canProduce = false;
let selectedAudioDeviceId = 'default';
let selectedVideoDeviceId = 'default';
let localAudioProducer = null;
let localVideoProducer = null;
let isScreenSharing = false;

// --- UI GLOBALS ---
window.toggleSidebar = () => {
    const sb = document.getElementById('sidebar');
    const btn = document.getElementById('btn-participants');

    if (sb.classList.contains('hidden')) {
        sb.classList.remove('hidden');
        btn.classList.add('active');
    } else {
        sb.classList.add('hidden');
        btn.classList.remove('active');
    }
};

window.leaveRoom = () => {
    if (confirm('Are you sure you want to leave?')) {
        window.location.href = '/'; // Go back to root
    }
};

window.toggleMicMenu = () => {
    document.getElementById('mic-dropdown').classList.toggle('show');
    document.getElementById('video-dropdown').classList.remove('show');
};

window.toggleVideoMenu = () => {
    document.getElementById('video-dropdown').classList.toggle('show');
    document.getElementById('mic-dropdown').classList.remove('show');
};

window.toggleMic = (val) => {
    // Logic calls internal toggleMic(val)
    // But internal is async function toggleMic(on)...
    // We can just proxy it or make the internal one global.
    // However, internal toggleMic depends on closure variables (producerTransport etc is module scope, which is fine)
    // Let's rely on the internal functions being available if we export them, but bundling isolates them.
    // We MUST attach the internal `toggleMic` to window.
    // The previous code had `btnMic.onclick = ...` which is fine for that button.
    // But `index.html` has `onclick="toggleMic()"`. 
    // So we need `window.toggleMic = toggleMic;`
    // Wait, let's just make the assignments at the end of the file.
};
// I will just change the function definitions to assignments on window or add assignments at the end.
// Simplest is to just replace this block with window assignments and call the internal logic.
// BUT `toggleMic` is defined later.
// Let's just REPLACE this block with window assignments for the UI helpers.

window.toggleSidebar = function () {
    const sb = document.getElementById('sidebar');
    const btn = document.getElementById('btn-participants');
    sb.classList.toggle('hidden');
    if (sb.classList.contains('hidden')) btn.classList.remove('active');
    else btn.classList.add('active');
}

window.leaveRoom = function () {
    if (confirm('Leave Meeting?')) window.location.href = window.location.pathname;
}

window.toggleMicMenu = function () {
    document.getElementById('mic-dropdown').classList.toggle('show');
    document.getElementById('video-dropdown').classList.remove('show');
}
window.toggleVideoMenu = function () {
    document.getElementById('video-dropdown').classList.toggle('show');
    document.getElementById('mic-dropdown').classList.remove('show');
}

// Close menus on click outside
window.onclick = (e) => {
    if (!e.target.closest('.mic-select-wrap')) {
        document.getElementById('mic-dropdown').classList.remove('show');
        document.getElementById('video-dropdown').classList.remove('show');
    }
};


// --- DOM ELEMENTS ---
// Login
const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const createMode = document.getElementById('create-mode');
const joinMode = document.getElementById('join-mode');

// Info
const roleBadge = document.getElementById('my-role-badge');
const roomIdDisp = document.getElementById('room-id-display');

// Containers
const videoContainer = document.getElementById('video-container');
const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const sidebar = document.getElementById('sidebar');

// Controls
// Controls
const btnMic = document.getElementById('btn-mic');
const btnMicMenu = document.getElementById('btn-mic-menu');
const btnVideo = document.getElementById('btn-cam');
const btnVideoMenu = document.getElementById('btn-video-menu');
const btnShareScreen = document.getElementById('btn-share-screen');
const btnParticipants = document.getElementById('btn-participants');
const btnCopyLink = document.getElementById('btn-copy-link');

const micDropdown = document.getElementById('mic-dropdown');
const videoDropdown = document.getElementById('video-dropdown');


// --- INIT ---
const urlParams = new URLSearchParams(window.location.search);
const paramRoom = urlParams.get('room');

if (paramRoom) {
    createMode.classList.add('hidden');
    joinMode.classList.remove('hidden');
    document.getElementById('join-room-display').innerText = paramRoom;

    // Auto-fill Name if available (Room Specific)
    const savedName = localStorage.getItem(`zoom_name_${paramRoom}`);
    if (savedName) {
        document.getElementById('join-name-input').value = savedName;
        // Auto-join immediately
        console.log('Auto-joining...', savedName);
        joinProcedure(paramRoom, savedName);
    }
} else {
    // If no room in URL but room in localstorage? 
    // Maybe better to wait for user action unless it's a "recover" scenario.
    // We can't easily guess the room if not in URL, but we can look for "last_room"?
    // User wants "for 1111 he only rejoin if 1111".
    // So if no URL param, we do NOTHING (standard behavior) or maybe fill name if we track "last used name"?
    // Let's just leave it blank or fill global name if we want, but User asked for specificity.
    // We will do nothing if no room param.
}

document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('host-name-input').value.trim();
    if (!name) return alert('Name required');
    const newRoom = Math.random().toString(36).substring(2, 7);
    localStorage.setItem(`zoom_name_${newRoom}`, name);
    joinProcedure(newRoom, name);
};
document.getElementById('btn-join-manual').onclick = () => {
    const r = document.getElementById('room-id-input').value.trim();
    const n = document.getElementById('join-name-input-manual').value.trim();
    if (!r || !n) return alert('Missing fields');
    localStorage.setItem(`zoom_name_${r}`, n);
    joinProcedure(r, n);
};
document.getElementById('btn-join').onclick = () => {
    const n = document.getElementById('join-name-input').value.trim();
    if (!n) return alert('Name required');
    localStorage.setItem(`zoom_name_${paramRoom}`, n);
    joinProcedure(paramRoom, n);
};

// --- IDENTITY ---
function getUserId() {
    let uid = localStorage.getItem('zoom_userId');
    if (!uid) {
        uid = Math.random().toString(36).substring(2) + Date.now().toString(36);
        localStorage.setItem('zoom_userId', uid);
    }
    return uid;
}

async function joinProcedure(rid, name) {
    myRoomId = rid;
    myName = name;

    // UI Switch
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    roomIdDisp.innerText = `ID: ${rid}`;

    // Update URL
    const u = new URL(window.location);
    u.searchParams.set('room', rid);
    window.history.pushState({}, '', u);

    // Mic Device Enum
    await refreshDeviceList();

    // Connect
    await connectSocket();
}

// --- SOCKET LOGIC ---
async function connectSocket() {
    try {
        const uid = getUserId();
        const { rtpCapabilities, existingProducers, checkRole } = await request('joinRoom', {
            roomId: myRoomId,
            name: myName,
            userId: uid
        });

        amHost = checkRole.isHost;
        updatePermissions(checkRole.canProduce);

        // Roles UI
        roleBadge.innerText = amHost ? 'HOST' : 'Viewer';
        roleBadge.style.color = amHost ? '#3be665' : '#ccc';

        await loadDevice(rtpCapabilities);

        for (const pid of existingProducers) await consumeStream(pid);

    } catch (e) {
        alert('Join failed: ' + e);
        location.reload();
    }
}

socket.on('updateParticipants', list => {
    console.log('Received participants list:', list);
    participantCount.innerText = `(${list.length})`;
    participantList.innerHTML = '';

    list.forEach(p => {
        const item = document.createElement('div');
        item.className = 'p-item';

        const isMe = p.id === socket.id;
        let actions = '';

        if (amHost && !isMe) {
            if (!p.canProduce) {
                actions = `<button class="p-btn" onclick="promoteUser('${p.id}')">Make Host/Prod</button>`;
            } else {
                actions = `<span class="p-role" style="color:#3be665">Producer</span>`;
            }
        } else {
            actions = p.canProduce ? `<span class="p-role">Producer</span>` : `<span class="p-role">Viewer</span>`;
        }

        item.innerHTML = `
            <div style="display:flex;align-items:center;">
                <div class="p-avatar">${p.name.substring(0, 2).toUpperCase()}</div>
                <div class="p-details">
                    <div style="font-weight:500; font-size:13px;">${p.name} ${isMe ? '(You)' : ''}</div>
                    ${actions}
                </div>
            </div>
        `;
        participantList.appendChild(item);
    });
});

window.promoteUser = (targetId) => {
    socket.emit('promoteToProducer', { targetSocketId: targetId });
};

socket.on('permissionGranted', ({ canProduce }) => {
    if (canProduce) {
        alert('Promoted to Producer!');
        updatePermissions(true);
    }
});

socket.on('newProducer', ({ producerId }) => consumeStream(producerId));

socket.on('producerClosed', ({ producerId }) => {
    removeStreamElement(producerId);
});

socket.on('producerForcedStop', ({ producerId }) => {
    // Check if it was one of mine
    if (localAudioProducer && localAudioProducer.id === producerId) {
        toggleMic(false);
        alert('Host stopped your Audio.');
    }
    if (localVideoProducer && localVideoProducer.id === producerId) {
        toggleVideo(false);
        alert('Host stopped your Video.');
    }
    if (isScreenSharing) {
        // Check if one of screen producers
        const p = screenProducers.find(sp => sp.id === producerId);
        if (p) {
            stopScreenShare();
            alert('Host stopped your Screen Share.');
        }
    }
});

// Helper to remove stream elements
function removeStreamElement(pid) {
    const el = document.getElementById(`elem-${pid}`);
    if (el) {
        // Find parent card
        const card = el.closest('.video-card');
        el.remove();

        if (card) {
            // Updated State
            const hasVideo = card.querySelector('video');
            const hasAudio = card.querySelector('audio');

            if (!hasVideo && !hasAudio) {
                // Empty card -> Remove
                card.remove();
            } else if (!hasVideo) {
                // No video -> Show placeholder
                const ph = card.querySelector('.audio-placeholder');
                if (ph) ph.style.display = 'flex';

                // If it was audio, maybe reset icon? 
                // Wait, if we removed audio, we should set icon to mic_off?
                // But if we removed audio, `hasAudio` is false.
                // If `hasAudio` is true (e.g. multiple mics?), we keep it.
                // Assuming 1 mic per user:
            }

            if (!hasAudio && !hasVideo) {
                // Already removed above
            } else if (!hasAudio) {
                // Reset mic icon if audio track gone but card stays (e.g. video only)
                const icon = card.querySelector('.mic-icon i');
                const iconDiv = card.querySelector('.mic-icon');
                if (icon) icon.innerText = 'mic_off';
                if (iconDiv) iconDiv.classList.remove('pulsing');
            }
        }
    }

    // Legacy cleanup for screen share separate cards (they used card-PID)
    const legacyCard = document.getElementById(`card-screen-${pid}`);
    if (legacyCard) legacyCard.remove();
}

// --- PERMISSIONS UI ---
function updatePermissions(can) {
    canProduce = can;
    const btns = [btnMic, btnMicMenu, btnVideo, btnVideoMenu, btnShareScreen];
    btns.forEach(b => {
        b.disabled = !can;
        b.style.opacity = can ? 1 : 0.5;
    });

    if (can) {
        roleBadge.innerText = amHost ? 'HOST' : 'Producer';
    }
}

// --- MEDIA LOGIC ---
async function loadDevice(caps) {
    device = new Device();
    await device.load({ routerRtpCapabilities: caps });
    await createTransports();
}
async function createTransports() {
    // Producer
    const p1 = await request('createProducerTransport', { forceTcp: false, rtpCapabilities: device.rtpCapabilities });
    producerTransport = device.createSendTransport(p1);
    producerTransport.on('connect', async ({ dtlsParameters }, cb, err) => {
        try { await request('connectProducerTransport', { dtlsParameters }); cb(); } catch (e) { err(e); }
    });
    producerTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, err) => {
        try { const { id } = await request('produce', { kind, rtpParameters, appData }); cb({ id }); } catch (e) { err(e); }
    });

    // Consumer
    const p2 = await request('createConsumerTransport', { forceTcp: false, rtpCapabilities: device.rtpCapabilities });
    consumerTransport = device.createRecvTransport(p2);
    consumerTransport.on('connect', async ({ dtlsParameters }, cb, err) => {
        try { await request('connectConsumerTransport', { dtlsParameters }); cb(); } catch (e) { err(e); }
    });
}

// --- DEVICE SELECT ---
async function refreshDeviceList() {
    try {
        // Ensure perm updates
        // await navigator.mediaDevices.getUserMedia({ audio: true, video: true }); // Avoid double permission prompt on load if possible, assume verified

        const devices = await navigator.mediaDevices.enumerateDevices();

        // Audio Inputs
        const mics = devices.filter(d => d.kind === 'audioinput');
        micDropdown.innerHTML = '';
        mics.forEach(d => {
            const div = document.createElement('div');
            div.className = 'mic-option';
            div.innerText = d.label || `Mic ${d.deviceId.substring(0, 4)}`;
            if (d.deviceId === selectedAudioDeviceId) div.classList.add('selected');

            div.onclick = () => {
                selectMic(d.deviceId);
            };
            micDropdown.appendChild(div);
        });

        // Video Inputs
        const cams = devices.filter(d => d.kind === 'videoinput');
        videoDropdown.innerHTML = '';
        cams.forEach(d => {
            const div = document.createElement('div');
            div.className = 'mic-option'; // Resize class if needed, reusing mic-option for compatible styling
            div.innerText = d.label || `Cam ${d.deviceId.substring(0, 4)}`;
            if (d.deviceId === selectedVideoDeviceId) div.classList.add('selected');

            div.onclick = () => {
                selectCam(d.deviceId);
            };
            videoDropdown.appendChild(div);
        });

    } catch (e) {
        console.error('Device list error:', e);
    }
}

async function selectCam(deviceId) {
    selectedVideoDeviceId = deviceId;
    videoDropdown.classList.remove('show');
    refreshDeviceList(); // Highlight selection

    // Switch logic
    if (localVideoProducer) {
        console.log('Switching cam to', deviceId);
        await toggleVideo(false);
        setTimeout(() => toggleVideo(true), 500);
    }
}


async function selectMic(deviceId) {
    selectedAudioDeviceId = deviceId;
    micDropdown.classList.remove('show');
    refreshDeviceList(); // Highlight selection

    // Switch logic
    if (localAudioProducer) {
        console.log('Switching mic to', deviceId);
        await toggleMic(false);
        setTimeout(() => toggleMic(true), 500);
    }
}


// --- ACTIONS ---
let isMicOn = false;
let isVideoOn = false;
// btnMic.onclick ... handled in HTML or below logic
// btnVideo.onclick ... handled in HTML
btnMic.onclick = () => toggleMic(!isMicOn);
btnVideo.onclick = () => toggleVideo(!isVideoOn);
btnMicMenu.onclick = (e) => { e.stopPropagation(); micDropdown.classList.toggle('show'); videoDropdown.classList.remove('show'); };
btnVideoMenu.onclick = (e) => { e.stopPropagation(); videoDropdown.classList.toggle('show'); micDropdown.classList.remove('show'); };
window.onclick = () => { micDropdown.classList.remove('show'); videoDropdown.classList.remove('show'); };

async function toggleMic(on) {
    if (on) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: selectedAudioDeviceId } }
            });
            const track = stream.getAudioTracks()[0];

            localAudioProducer = await producerTransport.produce({
                track,
                appData: { source: 'mic', peerId: socket.id } // Tag as Mic
            });
            producers.set(localAudioProducer.id, localAudioProducer);

            // UI Update
            isMicOn = true;
            btnMic.innerHTML = `<i class="material-icons">mic</i><span>Mute</span>`;
            btnMic.classList.add('active');

            // Local Placeholder
            addVideoCard(stream, localAudioProducer.id, true, true, { source: 'mic' });

            localAudioProducer.on('trackended', () => toggleMic(false));

        } catch (e) { console.error(e); }
    } else {
        if (localAudioProducer) {
            socket.emit('producerClose', { producerId: localAudioProducer.id });
            localAudioProducer.close();
            removeStreamElement(localAudioProducer.id);

            producers.delete(localAudioProducer.id);
            localAudioProducer = null;
        }
        isMicOn = false;
        btnMic.innerHTML = `<i class="material-icons">mic_off</i><span>Unmute</span>`;
        btnMic.classList.remove('active');
    }
}

async function toggleVideo(on) {
    if (on) {
        try {
            // HD Constraints + Device Selection
            const constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                }
            };
            if (selectedVideoDeviceId !== 'default') {
                constraints.video.deviceId = { exact: selectedVideoDeviceId };
            }

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const track = stream.getVideoTracks()[0];

            localVideoProducer = await producerTransport.produce({
                track,
                appData: { source: 'webcam', peerId: socket.id },
                // Enable simulcast if needed to handle bandwidth, but for now specific HD
                encodings: [
                    { maxBitrate: 500000, scaleResolutionDownBy: 2 }, // Low quality backup
                    { maxBitrate: 1500000, scaleResolutionDownBy: 1 } // HD
                ]
            });
            producers.set(localVideoProducer.id, localVideoProducer);

            // UI Update
            isVideoOn = true;
            btnVideo.innerHTML = `<i class="material-icons">videocam</i><span>Stop Video</span>`;
            btnVideo.classList.add('active');

            // Local Placeholder
            addVideoCard(stream, localVideoProducer.id, false, true, { source: 'webcam' });

            localVideoProducer.on('trackended', () => {
                toggleVideo(false);
            });

            // UI Update
            btnVideo.classList.add('active');
            btnVideo.querySelector('i').innerText = 'videocam';
            btnVideo.querySelector('span').innerText = 'Stop Video';

        } catch (err) {
            console.error('Publish video error:', err);
            alert('Cannot access camera or device not found.');
        }
    } else {
        // Stop Video
        if (localVideoProducer) {
            socket.emit('producerClose', { producerId: localVideoProducer.id });
            localVideoProducer.close();
            removeStreamElement(localVideoProducer.id);

            producers.delete(localVideoProducer.id);
            localVideoProducer = null;
        }
        isVideoOn = false;
        btnVideo.innerHTML = `<i class="material-icons">videocam_off</i><span>Start Video</span>`;
        btnVideo.classList.remove('active');

        // UI Update
        btnVideo.classList.remove('active');
        btnVideo.querySelector('i').innerText = 'videocam_off';
        btnVideo.querySelector('span').innerText = 'Start Video';
    }
}

// SCREEN SHARE
let screenProducers = [];

btnShareScreen.onclick = async () => {
    if (isScreenSharing) {
        stopScreenShare();
        return;
    }

    try {
        // Request Audio + High FPS Video
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30, max: 60 }
            },
            audio: true
        });
        screenProducers = [];
        isScreenSharing = true;

        // Update Button UI
        btnShareScreen.classList.add('sharing');
        btnShareScreen.innerHTML = `<i class="material-icons">stop_screen_share</i><span>Stop</span>`;

        for (const track of stream.getTracks()) {
            const params = {
                track,
                appData: { source: 'screen', peerId: socket.id }
            };

            // STRICT Screen Share Quality for Video
            if (track.kind === 'video') {
                params.encodings = [
                    { maxBitrate: 4000000, scaleResolutionDownBy: 1 }, // High Bitrate 4Mbps
                ];
                // Try to force high resolution if available in browser
                // Note: contentHint helps browsers optimize for motion/detail
                if (track.contentHint) track.contentHint = 'motion';
            }

            const producer = await producerTransport.produce(params);
            screenProducers.push(producer);
            producers.set(producer.id, producer);

            // Video Track -> Show Card
            if (track.kind === 'video') {
                addVideoCard(stream, producer.id, false, true, { source: 'screen' });

                // Handle "Stop Sharing" bubble from Browser
                track.onended = () => stopScreenShare();
            }
            // Audio Track -> Do nothing locally
        }

        // UI Update
        btnShareScreen.classList.add('active', 'sharing');
        btnShareScreen.querySelector('i').innerText = 'stop_screen_share';
        btnShareScreen.querySelector('span').innerText = 'Stop Share';

        isScreenSharing = true;
    } catch (err) {
        console.error('Screen share error:', err);
    }
}

function stopScreenShare() {
    if (!isScreenSharing) return;

    screenProducers.forEach(p => {
        socket.emit('producerClose', { producerId: p.id });
        p.close();
        producers.delete(p.id);
        removeStreamElement(p.id);
    });
    screenProducers = [];
    isScreenSharing = false;

    // UI Update
    btnShareScreen.classList.remove('active', 'sharing');
    btnShareScreen.querySelector('i').innerText = 'screen_share';
    btnShareScreen.querySelector('span').innerText = 'Share';
}


btnCopyLink.onclick = () => {
    navigator.clipboard.writeText(location.href);
    alert('Link Copied!');
};

btnParticipants.onclick = () => {
    sidebar.classList.toggle('hidden');
};

// --- CONSUME ---
async function consumeStream(producerId) {
    const { rtpCapabilities } = device;
    const { id, kind, rtpParameters, appData } = await request('consume', { producerId, rtpCapabilities });

    // Check if hidden audio
    if (appData && appData.source === 'screen' && kind === 'audio') {
        const consumer = await consumerTransport.consume({ id, producerId, kind, rtpParameters });
        const stream = new MediaStream([consumer.track]);

        const audio = document.createElement('audio');
        audio.id = `hidden-audio-${producerId}`;
        audio.srcObject = stream;
        audio.autoplay = true;
        document.body.appendChild(audio);

        await request('resume', { consumerId: consumer.id });
        return;
    }

    const consumer = await consumerTransport.consume({ id, producerId, kind, rtpParameters });
    const stream = new MediaStream([consumer.track]);

    addVideoCard(stream, producerId, kind === 'audio', false, appData);
    await request('resume', { consumerId: consumer.id });
}

// --- UI CARD BUILDER ---
// --- UI CARD BUILDER ---
function addVideoCard(stream, pid, isAudio, isLocal, appData = {}) {
    const peerId = appData.peerId || (isLocal ? socket.id : 'unknown');
    const isScreen = appData.source === 'screen';

    // ID for the Card (Container)
    // - Screen Share: unique card per share (card-screen-PID)
    // - User Stream: unique card per user (card-user-PEERID)
    const cardId = isScreen ? `card-screen-${pid}` : `card-user-${peerId}`;

    let card = document.getElementById(cardId);

    if (!card) {
        card = document.createElement('div');
        card.className = 'video-card';
        card.id = cardId;

        let label = isLocal ? 'You' : `User ${peerId.substr(0, 4)}`;
        if (isScreen) label += ' (Screen)';

        // Base Structure
        card.innerHTML = `
            <div class="audio-placeholder">
                <div class="mic-icon">
                    <i class="material-icons" style="font-size:40px; color:white">mic_off</i>
                </div>
            </div>
            <div class="media-container" style="width:100%; height:100%; position:absolute; top:0; left:0;"></div>
            <div class="name-tag">${label}</div>
            <div class="card-overlay"></div>
        `;

        videoContainer.appendChild(card);

        // Setup Overlay
        const overlay = card.querySelector('.card-overlay');

        // Fullscreen
        const fsBtn = document.createElement('button');
        fsBtn.className = 'overlay-btn btn-fullscreen';
        fsBtn.innerHTML = '<i class="material-icons">fullscreen</i>';
        fsBtn.onclick = () => enterFullscreen(card, overlay);
        overlay.appendChild(fsBtn);

        // Host Stop (only for remote users)
        if (amHost && !isLocal && !isScreen) {
            // We can't easily force stop per-track here if they are merged, 
            // but we can add a "Kick/Stop" button that stops everything for that user?
            // For now, let's keep it simple: no per-track stop btn in merged view yet, 
            // or add it if we track producers.
            // Let's rely on the Participant List for kicking/muting.
        } else if (amHost && isScreen && !isLocal) {
            // For screen share, we can allow stop
            const stopBtn = document.createElement('button');
            stopBtn.className = 'overlay-btn btn-stop';
            stopBtn.innerHTML = '<i class="material-icons">stop</i>';
            stopBtn.onclick = () => {
                if (confirm('Stop this screen share?')) socket.emit('forceStopProducer', { producerId: pid });
            };
            overlay.appendChild(stopBtn);
        }

        setupOverlayAutohide(card, overlay);
    }

    // Check if we already have this specific element
    if (document.getElementById(`elem-${pid}`)) return; // Already added

    // Add Media Element
    const mediaContainer = card.querySelector('.media-container');

    if (isAudio) {
        // Audio Track
        const audio = document.createElement('audio');
        audio.id = `elem-${pid}`;
        audio.srcObject = stream;
        if (isLocal) audio.muted = true;
        audio.style.display = 'none'; // Hidden audio
        mediaContainer.appendChild(audio);

        // Attempt Play
        audio.play().catch(e => {
            console.warn("Audio Autoplay failed", e);
            showPlayOverlay(card, audio);
        });

        // Update Placeholder to show active mic
        const icon = card.querySelector('.mic-icon i');
        const iconDiv = card.querySelector('.mic-icon');
        icon.innerText = 'mic';
        iconDiv.classList.add('pulsing');

    } else {
        // Video Track
        const video = document.createElement('video');
        video.id = `elem-${pid}`;
        video.playsInline = true;
        video.srcObject = stream;
        if (isLocal) video.muted = true;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'contain';

        // Clear placeholder if video is present (z-index or remove)
        // With styling, we can just put video on top
        // But cleaner to hide placeholder
        card.querySelector('.audio-placeholder').style.display = 'none';

        mediaContainer.appendChild(video);

        // Attempt Play
        video.play().catch(e => {
            console.warn("Video Autoplay failed", e);
            showPlayOverlay(card, video);
        });
    }
}

function showPlayOverlay(card, mediaElement) {
    // Check if already exists
    if (card.querySelector('.play-overlay')) return;

    const ov = document.createElement('div');
    ov.className = 'play-overlay';
    ov.innerHTML = '<i class="material-icons" style="font-size:48px; color:white">play_circle_outline</i><div style="color:white; font-size:12px; margin-top:4px">Tap to Play</div>';
    ov.style.position = 'absolute';
    ov.style.top = '0';
    ov.style.left = '0';
    ov.style.right = '0';
    ov.style.bottom = '0';
    ov.style.background = 'rgba(0,0,0,0.6)';
    ov.style.display = 'flex';
    ov.style.flexDirection = 'column';
    ov.style.alignItems = 'center';
    ov.style.justifyContent = 'center';
    ov.style.zIndex = '50';
    ov.style.cursor = 'pointer';

    ov.onclick = () => {
        mediaElement.play()
            .then(() => ov.remove())
            .catch(err => console.error("Play failed again", err));
    };

    card.appendChild(ov);
}


// --- FULLSCREEN & AUTOHIDE LOGIC ---

function enterFullscreen(element, overlay) {
    if (element.requestFullscreen) element.requestFullscreen();
    else if (element.webkitRequestFullscreen) element.webkitRequestFullscreen();

    element.classList.add('fullscreen-mode');

    document.addEventListener('fullscreenchange', exitHandler);
    document.addEventListener('webkitfullscreenchange', exitHandler);

    function exitHandler() {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            element.classList.remove('fullscreen-mode');
            // Remove visible class just in case
            overlay.classList.remove('visible');
            element.style.cursor = 'default';

            document.removeEventListener('fullscreenchange', exitHandler);
            document.removeEventListener('webkitfullscreenchange', exitHandler);
        }
    }
}

function setupOverlayAutohide(card, overlay) {
    let timer;

    const show = () => {
        // Show cursor and overlay
        if (card.classList.contains('fullscreen-mode')) {
            overlay.classList.add('visible');
            card.style.cursor = 'default';
        }

        clearTimeout(timer);
        timer = setTimeout(() => {
            if (card.classList.contains('fullscreen-mode')) {
                overlay.classList.remove('visible');
                card.style.cursor = 'none';
            }
        }, 2000);
    };

    card.addEventListener('mousemove', show);
    card.addEventListener('click', show); // e.g. on mobile tap
}

// --- EXPOSE TO WINDOW ---
window.toggleMic = toggleMic;
window.toggleVideo = toggleVideo;
window.toggleScreenShare = () => { btnShareScreen.onclick(); };
window.joinProcedure = joinProcedure;
window.refreshDeviceList = refreshDeviceList;
window.selectMic = selectMic;
window.selectCam = selectCam;


function request(type, data = {}) {
    return new Promise((res, rej) => {
        socket.emit(type, data, response => {
            if (response && response.error) rej(response.error);
            else res(response);
        });
    });
}
