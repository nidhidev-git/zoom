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
const btnMic = document.getElementById('btn-mic');
const btnMicMenu = document.getElementById('btn-mic-menu');
const micDropdown = document.getElementById('mic-dropdown');
const btnVideo = document.getElementById('btn-video');
const btnVideoMenu = document.getElementById('btn-video-menu');
const videoDropdown = document.getElementById('video-dropdown');
const btnShareScreen = document.getElementById('btn-share-screen');
const btnParticipants = document.getElementById('btn-participants');
const btnCopyLink = document.getElementById('btn-copy-link');


// --- INIT ---
const urlParams = new URLSearchParams(window.location.search);
const paramRoom = urlParams.get('room');

if (paramRoom) {
    createMode.classList.add('hidden');
    joinMode.classList.remove('hidden');
    document.getElementById('join-room-display').innerText = paramRoom;
}

document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('host-name-input').value.trim();
    if (!name) return alert('Name required');
    joinProcedure(Math.random().toString(36).substring(2, 7), name);
};
document.getElementById('btn-join-manual').onclick = () => {
    const r = document.getElementById('room-id-input').value.trim();
    const n = document.getElementById('join-name-input-manual').value.trim();
    if (!r || !n) return alert('Missing fields');
    joinProcedure(r, n);
};
document.getElementById('btn-join').onclick = () => {
    const n = document.getElementById('join-name-input').value.trim();
    if (!n) return alert('Name required');
    joinProcedure(paramRoom, n);
};

async function joinProcedure(rid, name) {
    myRoomId = rid;
    myName = name;

    // UI Switch
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');
    roomIdDisp.innerText = `ID: ${rid}`;

    // Update URL
    if (!paramRoom) {
        const u = new URL(window.location);
        u.searchParams.set('room', rid);
        window.history.pushState({}, '', u);
    }

    // Mic Device Enum
    await refreshDeviceList();

    // Connect
    await connectSocket();
}

// --- SOCKET LOGIC ---
async function connectSocket() {
    try {
        const { rtpCapabilities, existingProducers, checkRole } = await request('joinRoom', { roomId: myRoomId, name: myName });

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
    const el = document.getElementById(`card-${producerId}`);
    if (el) el.remove();
    // Also check hidden audio elements
    const audioEl = document.getElementById(`hidden-audio-${producerId}`);
    if (audioEl) audioEl.remove();
});

socket.on('producerForcedStop', () => {
    // If I was streaming, stop everything
    if (localAudioProducer) {
        toggleMic(false);
    }
    if (localVideoProducer) {
        toggleVideo(false);
    }
    if (isScreenSharing) {
        stopScreenShare();
    }
    alert('Host stopped your stream.');
});

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
        await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        const devices = await navigator.mediaDevices.enumerateDevices();

        // Audio Inputs
        const audioIns = devices.filter(d => d.kind === 'audioinput');
        micDropdown.innerHTML = '';
        audioIns.forEach(d => {
            const div = document.createElement('div');
            div.className = 'mic-option';
            div.innerText = d.label || `Mic ${d.deviceId.substring(0, 4)}`;
            if (d.deviceId === selectedAudioDeviceId) div.classList.add('selected');

            div.onclick = () => {
                selectedAudioDeviceId = d.deviceId;
                refreshDeviceList();
                micDropdown.classList.remove('show');
                if (localAudioProducer) {
                    toggleMic(false);
                    setTimeout(() => toggleMic(true), 500);
                }
            };
            micDropdown.appendChild(div);
        });

        // Video Inputs
        const videoIns = devices.filter(d => d.kind === 'videoinput');
        videoDropdown.innerHTML = '';
        videoIns.forEach(d => {
            const div = document.createElement('div');
            div.className = 'mic-option';
            div.innerText = d.label || `Cam ${d.deviceId.substring(0, 4)}`;
            if (d.deviceId === selectedVideoDeviceId) div.classList.add('selected');

            div.onclick = () => {
                selectedVideoDeviceId = d.deviceId;
                refreshDeviceList();
                videoDropdown.classList.remove('show');
                if (localVideoProducer) {
                    toggleVideo(false);
                    setTimeout(() => toggleVideo(true), 500);
                }
            };
            videoDropdown.appendChild(div);
        });

    } catch (e) { console.log('Device list error', e); }
}


// --- ACTIONS ---
let isMicOn = false;
let isVideoOn = false;
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
                appData: { source: 'mic' } // Tag as Mic
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
            const el = document.getElementById(`card-${localAudioProducer.id}`);
            if (el) el.remove();

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
                appData: { source: 'webcam' },
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

            localVideoProducer.on('trackended', () => toggleVideo(false));

        } catch (e) {
            console.error(e);
            alert('Cannot access camera or device not found.');
        }
    } else {
        if (localVideoProducer) {
            socket.emit('producerClose', { producerId: localVideoProducer.id });
            localVideoProducer.close();
            const el = document.getElementById(`card-${localVideoProducer.id}`);
            if (el) el.remove();

            producers.delete(localVideoProducer.id);
            localVideoProducer = null;
        }
        isVideoOn = false;
        btnVideo.innerHTML = `<i class="material-icons">videocam_off</i><span>Start Video</span>`;
        btnVideo.classList.remove('active');
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
                appData: { source: 'screen' }
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
    } catch (e) { console.error(e); }
};

function stopScreenShare() {
    isScreenSharing = false;
    btnShareScreen.classList.remove('sharing');
    btnShareScreen.innerHTML = `<i class="material-icons" style="color:#28a745">screen_share</i><span>Share</span>`;

    screenProducers.forEach(p => {
        socket.emit('producerClose', { producerId: p.id });
        p.close();
        producers.delete(p.id);
        const el = document.getElementById(`card-${p.id}`);
        if (el) el.remove();
    });
    screenProducers = [];
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
function addVideoCard(stream, pid, isAudio, isLocal, appData = {}) {
    if (document.getElementById(`card-${pid}`)) return;

    const card = document.createElement('div');
    card.className = 'video-card';
    card.id = `card-${pid}`;

    // Content
    if (isAudio) {
        card.innerHTML = `
            <div class="audio-placeholder">
                <div class="mic-icon pulsing">
                    <i class="material-icons" style="font-size:40px; color:white">mic</i>
                </div>
            </div>
            <audio autoplay></audio>
        `;
        const audio = card.querySelector('audio');
        audio.srcObject = stream;
        if (isLocal) audio.muted = true;
    } else {
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.srcObject = stream;
        if (isLocal) video.muted = true;
        card.appendChild(video);
    }

    const overlay = document.createElement('div');
    overlay.className = 'card-overlay';

    // Full Screen Btn
    const fsBtn = document.createElement('button');
    fsBtn.className = 'overlay-btn btn-fullscreen';
    fsBtn.innerHTML = '<i class="material-icons">fullscreen</i>';
    fsBtn.title = 'Full Screen';
    fsBtn.onclick = () => {
        enterFullscreen(card, overlay);
    };
    overlay.appendChild(fsBtn);

    if (amHost && !isLocal) {
        const stopBtn = document.createElement('button');
        stopBtn.className = 'overlay-btn btn-stop';
        stopBtn.innerHTML = '<i class="material-icons">stop</i>';
        stopBtn.title = 'Force Stop';
        stopBtn.onclick = () => {
            if (confirm('Force stop this stream?')) {
                socket.emit('forceStopProducer', { producerId: pid });
            }
        };
        overlay.appendChild(stopBtn);
    }

    card.appendChild(overlay);

    // Name Tag
    const tag = document.createElement('div');
    tag.className = 'name-tag';

    let label = isLocal ? 'You' : `User (${pid.substr(0, 4)})`;
    if (appData.source === 'screen') label += ' (Screen)';

    tag.innerText = label;
    card.appendChild(tag);

    setupOverlayAutohide(card, overlay);

    videoContainer.appendChild(card);
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
        }, 5000);
    };

    card.addEventListener('mousemove', show);
    card.addEventListener('click', show);
}


function request(type, data = {}) {
    return new Promise((res, rej) => {
        socket.emit(type, data, response => {
            if (response && response.error) rej(response.error);
            else res(response);
        });
    });
}
