// --- Type Definitions ---
// These interfaces define the shape of the YouTube IFrame Player API
// to satisfy TypeScript's type checker.

declare global {
    interface Window {
        onYouTubeIframeAPIReady: () => void;
        YT: typeof YT;
    }
}

declare namespace YT {
    enum PlayerState {
        ENDED = 0,
        PLAYING = 1,
        PAUSED = 2,
        BUFFERING = 3,
        CUED = 5,
    }

    class Player {
        constructor(elementId: string, options: PlayerOptions);
        destroy(): void;
        stopVideo(): void;
        loadVideoById(videoId: string): void;
        cueVideoById(videoId: string): void;
        loadPlaylist(options: { list: string; listType: 'playlist' }): void;
        cuePlaylist(options: { list: string; listType: 'playlist' }): void;
        getPlaylistIndex(): number;
        getPlaylist(): string[] | undefined;
        seekTo(seconds: number, allowSeekAhead?: boolean): void;
        playVideo(): void;
        playVideoAt(index: number): void;
        getIframe(): HTMLIFrameElement;
    }

    interface PlayerOptions {
        height: string;
        width: string;
        playerVars?: {
            playsinline?: 1;
            controls?: 0;
        };
        events?: {
            onReady?: (event: PlayerEvent) => void;
            onStateChange?: (event: PlayerStateChangeEvent) => void;
            onError?: (event: PlayerErrorEvent) => void;
        };
    }

    interface PlayerEvent {
        target: Player;
    }

    interface PlayerStateChangeEvent extends PlayerEvent {
        data: PlayerState;
    }

    interface PlayerErrorEvent extends PlayerEvent {
        data: number;
    }
}

interface QueueItem {
    type: 'video' | 'playlist';
    id: string;
    url: string;
    loopCount: number;
    delay: number;
    currentLoops: number;
    rowId: string;
}

interface Account {
    email: string;
    enabled: boolean;
}

// --- YouTube IFrame API Loader ---
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode!.insertBefore(tag, firstScriptTag);

// --- Global State & Elements ---
let players = new Map<string, YT.Player>();
let isApiReady = false;
let queuedPlayerCreations: { rowId: string, playerElementId: string }[] = [];
let videoQueue: QueueItem[] = [];
let accounts: Account[] = [];
let currentPlaybackState = {
    videoIndex: -1,
    isStopped: true,
};
let activeTimeout: number | null = null;
let scheduleInterval: number | null = null;
let wakeLock: WakeLockSentinel | null = null;

const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const addVideoBtn = document.getElementById('add-video-btn') as HTMLButtonElement;
const videoListContainer = document.getElementById('video-list-container') as HTMLElement;
const playerStatus = document.getElementById('player-status') as HTMLElement;
const enableScheduleToggle = document.getElementById('enable-schedule') as HTMLInputElement;
const scheduleTimeInputs = document.querySelectorAll<HTMLInputElement>('#schedule-list input[type="time"]');
const saveAccountsBtn = document.getElementById('save-accounts-btn') as HTMLButtonElement;
const accountEmailInputs = document.querySelectorAll<HTMLInputElement>('.account-email-input');
const accountEnableToggles = document.querySelectorAll<HTMLInputElement>('.account-enable-toggle');


// --- Main Entry Point from YouTube API ---
window.onYouTubeIframeAPIReady = () => {
    isApiReady = true;
    queuedPlayerCreations.forEach(({ rowId, playerElementId }) => {
        createPlayer(rowId, playerElementId);
    });
    queuedPlayerCreations = [];
};

function createPlayer(rowId: string, playerElementId: string) {
    if (!document.getElementById(playerElementId)) return;
    const player = new YT.Player(playerElementId, {
        height: '100%',
        width: '100%',
        playerVars: { 'playsinline': 1, 'controls': 0 },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError,
        }
    });
    players.set(rowId, player);
}

function getRowIdForPlayer(playerInstance: YT.Player): string | null {
    for (const [id, p] of players.entries()) {
        if (p === playerInstance) return id;
    }
    return null;
}

// --- Player Event Handlers ---
function onPlayerReady(event: YT.PlayerEvent) {
    const rowId = getRowIdForPlayer(event.target);
    if (rowId) {
        const rowElement = document.querySelector<HTMLElement>(`[data-id='${rowId}']`);
        if (rowElement) loadVideoInPlayer(rowElement, true);
    }
    if (players.size > 0) {
        startBtn.disabled = false;
        updateStatus('Ready. Add videos to start.');
    }
}

function onPlayerError(event: YT.PlayerErrorEvent) {
    const rowId = getRowIdForPlayer(event.target);
    console.error(`YouTube Player Error in row ${rowId}:`, event.data);
    updateStatus(`Error in row ${rowId}. Moving to next item.`);
    if (!currentPlaybackState.isStopped) playNextVideoInQueue();
}

function onPlayerStateChange(event: YT.PlayerStateChangeEvent) {
    if (currentPlaybackState.isStopped) return;

    const rowId = getRowIdForPlayer(event.target);
    if (!rowId) return;

    const currentItem = videoQueue[currentPlaybackState.videoIndex];
    if (!currentItem || currentItem.rowId !== rowId) return;

    if (event.data === YT.PlayerState.CUED) {
        event.target.playVideo();
    }

    if (currentItem.type === 'playlist' && event.data === YT.PlayerState.PLAYING) {
        const playlistIndex = event.target.getPlaylistIndex();
        const playlistSize = event.target.getPlaylist()?.length || 1;
        updateStatus(`Playing: ${currentItem.url} (Track ${playlistIndex + 1}/${playlistSize})`, currentItem.rowId);
    }

    if (event.data === YT.PlayerState.ENDED) {
        let isCycleComplete = false;
        if (currentItem.type === 'video') {
            isCycleComplete = true;
        } else if (currentItem.type === 'playlist') {
            const playlistIndex = event.target.getPlaylistIndex();
            const playlist = event.target.getPlaylist();
            if (playlist && playlistIndex === playlist.length - 1) {
                isCycleComplete = true;
            }
        }
        if (isCycleComplete) {
            handleLoopOrNext(currentItem, event.target);
        }
    }
}

// --- Playback Logic ---
function handleLoopOrNext(item: QueueItem, playerInstance: YT.Player) {
    item.currentLoops += 1;
    const loopLimit = item.loopCount;
    const isInfinite = !loopLimit || loopLimit <= 0;

    if (isInfinite || item.currentLoops < loopLimit) {
        const delay = (item.delay || 0) * 1000;
        updateStatus(`Looping in ${item.delay || 0}s...`, item.rowId);

        if (activeTimeout) clearTimeout(activeTimeout);
        activeTimeout = window.setTimeout(() => {
            if (currentPlaybackState.isStopped) return;
            if (item.type === 'video') {
                playerInstance.seekTo(0);
            } else {
                playerInstance.playVideoAt(0);
            }
        }, delay);
    } else {
        updateStatus('Finished loops. Moving to next...', item.rowId);
        playNextVideoInQueue();
    }
}

async function playNextVideoInQueue() {
    if (currentPlaybackState.isStopped) return;

    document.querySelector<HTMLElement>('.video-row.active')?.classList.remove('active');

    currentPlaybackState.videoIndex++;
    if (currentPlaybackState.videoIndex >= videoQueue.length) {
        updateStatus('Queue finished.');
        await stopPlayback();
        return;
    }

    const nextItem = videoQueue[currentPlaybackState.videoIndex];
    nextItem.currentLoops = 0;

    const playerToPlay = players.get(nextItem.rowId);
    if (!playerToPlay) {
        console.error(`Player not found for row ${nextItem.rowId}. Skipping.`);
        playNextVideoInQueue();
        return;
    }

    updateStatus(`Loading: ${nextItem.url}`, nextItem.rowId);
    document.querySelector<HTMLElement>(`[data-id='${nextItem.rowId}']`)?.classList.add('active');

    if (nextItem.type === 'video') {
        playerToPlay.loadVideoById(nextItem.id);
    } else if (nextItem.type === 'playlist') {
        playerToPlay.loadPlaylist({ list: nextItem.id, listType: 'playlist' });
    }
}

// --- Control Button Handlers ---
async function startPlayback() {
    videoQueue = [];
    document.querySelectorAll<HTMLElement>('.video-row').forEach(row => {
        const urlInput = row.querySelector('.video-url-input') as HTMLInputElement;
        const parsed = parseYoutubeUrl(urlInput.value);
        if (parsed) {
            videoQueue.push({
                ...parsed,
                url: urlInput.value,
                loopCount: parseInt((row.querySelector('.loop-input') as HTMLInputElement).value, 10) || 0,
                delay: parseInt((row.querySelector('.delay-input') as HTMLInputElement).value, 10) || 0,
                currentLoops: 0,
                rowId: row.dataset.id!,
            });
        }
    });

    if (videoQueue.length === 0) {
        updateStatus('Error: No valid YouTube URLs found.');
        return;
    }

    const activeAccount = accounts.find(acc => acc.enabled && acc.email);

    if (!enableScheduleToggle.checked) await requestWakeLock();

    currentPlaybackState = { videoIndex: -1, isStopped: false };
    startBtn.disabled = true;
    stopBtn.disabled = false;
    
    if (activeAccount) {
        updateStatus(`Starting queue for ${activeAccount.email}...`);
    } else {
        updateStatus('Starting queue...');
    }
    
    await playNextVideoInQueue();
}

async function stopPlayback() {
    if (!enableScheduleToggle.checked) await releaseWakeLock();

    if (activeTimeout) clearTimeout(activeTimeout);
    players.forEach(p => {
        if (p && typeof p.stopVideo === 'function') {
            try { p.stopVideo(); } catch (e) { /* ignore */ }
        }
    });

    currentPlaybackState.isStopped = true;
    stopBtn.disabled = true;
    if (!enableScheduleToggle.checked) startBtn.disabled = false;
    updateStatus('Stopped. Ready to start.');
    document.querySelector<HTMLElement>('.video-row.active')?.classList.remove('active');
}

// --- Scheduling Logic ---
function checkSchedule() {
    const now = new Date();
    const currentTime = now.toTimeString().substring(0, 5);
    const scheduleRows = document.querySelectorAll<HTMLElement>('.schedule-row');

    if (!currentPlaybackState.isStopped) {
        for (const row of scheduleRows) {
            const stopInput = row.querySelector('.schedule-stop-time') as HTMLInputElement;
            if (stopInput.value && stopInput.value === currentTime) {
                updateStatus(`Scheduler: Stopping at ${currentTime}`);
                stopPlayback();
                return;
            }
        }
    }

    if (currentPlaybackState.isStopped) {
        for (const row of scheduleRows) {
            const startInput = row.querySelector('.schedule-start-time') as HTMLInputElement;
            if (startInput.value && startInput.value === currentTime) {
                updateStatus(`Scheduler: Starting at ${currentTime}`);
                startPlayback();
                return;
            }
        }
    }
}

async function toggleScheduler(enabled: boolean) {
    if (enabled) {
        await requestWakeLock();
        if (scheduleInterval) clearInterval(scheduleInterval);
        scheduleInterval = window.setInterval(checkSchedule, 1000);
        startBtn.disabled = true;
        stopBtn.disabled = true;
        scheduleTimeInputs.forEach(input => input.disabled = false);
        updateStatus('Scheduler enabled. Waiting for a start time.');
    } else {
        await releaseWakeLock();
        if (scheduleInterval) clearInterval(scheduleInterval);
        scheduleInterval = null;
        startBtn.disabled = players.size === 0;
        stopBtn.disabled = true;
        scheduleTimeInputs.forEach(input => input.disabled = true);
        if(!currentPlaybackState.isStopped) await stopPlayback();
        updateStatus('Scheduler disabled. Ready for manual start.');
    }
}

// --- Wake Lock Logic ---
async function requestWakeLock() {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            updateStatus(playerStatus.textContent || 'Status updated');
        });
    } catch (err) {
        console.error(`Wake Lock Error: ${(err as Error).name}, ${(err as Error).message}`);
    } finally {
        updateStatus(playerStatus.textContent || 'Status updated');
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }
    updateStatus(playerStatus.textContent || 'Status updated');
}

// --- Account Logic ---
function loadAccounts() {
    const savedAccounts = localStorage.getItem('looptube_accounts');
    let loadedAccounts: Account[] = [];
    if (savedAccounts) {
        try {
            loadedAccounts = JSON.parse(savedAccounts);
        } catch (e) {
            console.error("Failed to parse saved accounts, resetting.", e);
        }
    }
    
    accounts = Array.from({ length: 3 }, (_, i) => ({
        email: loadedAccounts[i]?.email || '',
        enabled: loadedAccounts[i]?.enabled || false,
    }));
    
    updateAccountUI();
}

function updateAccountUI() {
    accountEmailInputs.forEach((input, index) => {
        input.value = accounts[index]?.email || '';
    });
    accountEnableToggles.forEach((toggle, index) => {
        toggle.checked = accounts[index]?.enabled || false;
    });
}

function saveAccounts() {
    const newAccounts: Account[] = [];
    accountEmailInputs.forEach((input, index) => {
        const toggle = accountEnableToggles[index];
        newAccounts.push({
            email: input.value.trim(),
            enabled: toggle.checked,
        });
    });
    accounts = newAccounts;
    localStorage.setItem('looptube_accounts', JSON.stringify(accounts));
    updateStatus('Accounts saved successfully.');
}


// --- UI & Utility Functions ---
function getWakeLockStatusText(): string {
    if (!('wakeLock' in navigator)) return ' (Screen Lock not supported)';
    if (wakeLock) return ' (Screen Lock Active 🔒)';
    return '';
}

function loadVideoInPlayer(row: HTMLElement, isPreview: boolean = false) {
    const rowId = row.dataset.id;
    if (!rowId) return;

    const player = players.get(rowId);
    const urlInput = row.querySelector('.video-url-input') as HTMLInputElement;
    if (!player || !urlInput.value) return;

    const parsed = parseYoutubeUrl(urlInput.value);
    if (!parsed) return;
    
    // For previews (on blur), we only cue the video.
    if (isPreview) {
        if (parsed.type === 'video') {
            player.cueVideoById(parsed.id);
        } else if (parsed.type === 'playlist') {
            player.cuePlaylist({ list: parsed.id, listType: 'playlist' });
        }
    }
}

function addNewVideoRow() {
    const template = document.getElementById('video-row-template') as HTMLTemplateElement;
    const clone = template.content.cloneNode(true) as DocumentFragment;
    const newRow = clone.querySelector('.video-row') as HTMLElement;
    const newId = `row-${Date.now()}`;
    newRow.dataset.id = newId;

    const playerContainer = newRow.querySelector('.player-container') as HTMLElement;
    const playerElementId = `player-${newId}`;
    playerContainer.id = playerElementId;

    const removeBtn = newRow.querySelector('.btn-remove') as HTMLButtonElement;
    removeBtn.addEventListener('click', () => {
        if (newRow.classList.contains('active') && !currentPlaybackState.isStopped) {
            updateStatus("Cannot remove active item. Stop first.");
        } else {
            const playerToRemove = players.get(newId);
            if (playerToRemove && typeof playerToRemove.destroy === 'function') {
                try { playerToRemove.destroy(); } catch (e) { /* ignore */ }
            }
            players.delete(newId);
            newRow.remove();
            if (players.size === 0) startBtn.disabled = true;
        }
    });

    const urlInput = newRow.querySelector('.video-url-input') as HTMLInputElement;
    urlInput.addEventListener('blur', () => loadVideoInPlayer(newRow, true));

    videoListContainer.appendChild(clone);

    if (isApiReady) {
        createPlayer(newId, playerElementId);
    } else {
        queuedPlayerCreations.push({ rowId: newId, playerElementId });
    }
}

function parseYoutubeUrl(url: string): { type: 'playlist' | 'video'; id: string } | null {
    if (!url) return null;
    const playlistRegex = /[?&]list=([^&]+)/;
    const videoRegex = /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const playlistMatch = url.match(playlistRegex);
    if (playlistMatch && playlistMatch[1]) return { type: 'playlist', id: playlistMatch[1] };
    const videoMatch = url.match(videoRegex);
    if (videoMatch && videoMatch[1]) return { type: 'video', id: videoMatch[1] };
    return null;
}

function updateStatus(message: string, activeRowId: string | null = null) {
    const baseMessage = message.startsWith('Status: ') ? message.substring(8) : message;
    const cleanMessage = baseMessage.split(' (Screen Lock')[0].trim();
    playerStatus.textContent = `Status: ${cleanMessage}${getWakeLockStatusText()}`;

    document.querySelectorAll<HTMLElement>('.video-row').forEach(row => {
        if (row.dataset.id === activeRowId) row.classList.add('active');
        else row.classList.remove('active');
    });
}

// --- Initial Setup ---
document.addEventListener('DOMContentLoaded', () => {
    startBtn.disabled = true;
    stopBtn.disabled = true;
    startBtn.addEventListener('click', startPlayback);
    stopBtn.addEventListener('click', stopPlayback);
    addVideoBtn.addEventListener('click', addNewVideoRow);
    saveAccountsBtn.addEventListener('click', saveAccounts);
    enableScheduleToggle.addEventListener('change', (e) => toggleScheduler((e.target as HTMLInputElement).checked));

    loadAccounts();
    addNewVideoRow();
    updateStatus('Initializing...');
});

export {};