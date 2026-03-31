const state = {
    filter: 'all',
    collapsed: false,
    activeId: null,
    settings: null,
    contacts: [],
    threads: {},
    pendingRequests: {}
};

const runtimeView = {
    lastRenderedId: null,
    lastRenderLen: 0,
    autoScroll: true,
    listSignature: '',
    listFilter: '',
    listSearch: ''
};

const SESSION_KEY = 'qbe.session';
const COLLAPSE_KEY = 'qbe.chat.sidebar.collapsed';
const ACTIVE_KEY = 'qbe.chat.activeId';
const THREADS_KEY = 'qbe.chat.threads.v1';
const CONTACTS_KEY = 'qbe.chat.contacts.v1';
const FRIENDS_KEY = 'qbe.chat.friends.v1';
const MUTED_KEY = 'qbe.chat.muted.v1';
const DRAFT_KEY = 'qbe.chat.drafts.v1';
const SETTINGS_KEY = 'qbe.settings';
const UI_SETTINGS_KEY = 'qbe.ui.settings';
const STATUS_KEY = 'qbe.chat.status.v1';
const ATTACH_PREFIX = '__ATTACH__|';

const GROUP_MEMBERS_KEY = 'qbe.chat.group.members';

function debounce(fn, wait) {
    let t = null;
    return function (...args) {
        if (t) window.clearTimeout(t);
        t = window.setTimeout(() => fn.apply(this, args), wait);
    };
}

function rafThrottle(fn) {
    let raf = 0;
    let lastArgs = null;
    return function (...args) {
        lastArgs = args;
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
            raf = 0;
            fn.apply(this, lastArgs || []);
        });
    };
}

function normalize_id(s) {
    return String(s || '').trim();
}

function createContactId(name) {
    const base = normalize_id(name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'u';
    return base + '-' + String(Date.now()).slice(-6);
}

function addContact(name, peerUid) {
    const n = String(name || '').trim();
    if (!n) return null;
    const uid = Number(peerUid) || 0;
    if (uid) {
        const existing = state.contacts.find((c) => Number(c.uid) === uid);
        if (existing) {
            if (existing.removed) existing.removed = false;
            existing.name = n || existing.name;
            existing.seed = existing.name.slice(0, 1).toUpperCase();
            persist();
            renderUserList(document);
            setActive(existing.id);
            return existing;
        }
    }
    const id = createContactId(n);
    const seed = n.slice(0, 1).toUpperCase();
    const c = { id, uid: uid, name: n, online: true, unread: 0, last: '新会话已创建', time: '刚刚', seed };
    state.contacts.unshift(c);
    if (!state.threads[id]) state.threads[id] = [];
    persist();
    renderUserList(document);
    setActive(id);
    toast('已创建会话');
    return c;
}

function addGroupContact(name, members) {
    const contact = addContact(name);
    if (!contact) return null;
    const map = readGroupMembers();
    map[contact.id] = Array.isArray(members) ? members.slice() : [];
    writeGroupMembers(map);
    return contact;
}

function genCallId() {
    try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    } catch (_) {}
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
}

function removeGroupMembers(id) {
    const map = readGroupMembers();
    if (map && Object.prototype.hasOwnProperty.call(map, id)) {
        delete map[id];
        writeGroupMembers(map);
    }
}

function addFriend(uid, name) {
    const u = Number(uid) || 0;
    if (!u) return;
    if (!state.friends) state.friends = [];
    const existing = state.friends.find((f) => Number(f.uid) === u);
    if (existing) {
        existing.removed = false;
        if (name) existing.name = name;
        persist();
        renderFriendList();
        return;
    }
    state.friends.unshift({ uid: u, name: name || ('UID ' + u), removed: false });
    persist();
    renderFriendList();
}

function removeFriend(uid) {
    const u = Number(uid) || 0;
    if (!u || !state.friends) return;
    const f = state.friends.find((x) => Number(x.uid) === u);
    if (f) f.removed = true;
    persist();
    renderFriendList();
}

function deleteFriend(uid) {
    const u = Number(uid) || 0;
    if (!u || !state.friends) return;
    const idx = state.friends.findIndex((x) => Number(x.uid) === u);
    if (idx >= 0) state.friends.splice(idx, 1);
    persist();
    renderFriendList();
}

function removeContact(id) {
    const cid = String(id || '');
    const idx = state.contacts.findIndex((c) => c.id === cid);
    if (idx < 0) return;
    state.contacts.splice(idx, 1);
    delete state.threads[cid];
    removeGroupMembers(cid);
    if (state.muted) delete state.muted[cid];
    if (state.drafts) delete state.drafts[cid];
    if (state.activeId === cid) {
        state.activeId = state.contacts[0] ? state.contacts[0].id : null;
        saveActiveId(state.activeId);
    }
    persist();
    scheduleRender();
    renderFriendList();
}

function pinContact(id, pinned) {
    const cid = String(id || '');
    const idx = state.contacts.findIndex((c) => c.id === cid);
    if (idx < 0) return;
    const c = state.contacts[idx];
    c.pinned = !!pinned;
    // re-sort: pinned first, then by unread desc, then keep relative
    state.contacts.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const au = a.unread || 0;
        const bu = b.unread || 0;
        if (au !== bu) return bu - au;
        return 0;
    });
    persist();
    renderUserList(document);
}

const searchState = { q: '', matches: [], cursor: -1 };
const runtime = { callTimer: null, callStart: 0, ctxMsgId: null };
const rtc = {
    pc: null,
    localStream: null,
    remoteStream: null,
    targetUid: 0,
    isCaller: false,
    callId: '',
    pendingCandidates: [],
    remoteDescSet: false,
    retryCount: 0
};
const callState = {
    incoming: null,
    pendingOffer: null,
    pendingTimer: null,
    status: 'idle',
    callId: ''
};
const runtime2 = { audio: null, audioUnlocked: false };

function loadSettings() {
    const s = readJson(SETTINGS_KEY, { notify: true, sound: false, privacy: false, hide_uid: false, notify_preview: true });
    if (!s || typeof s !== 'object') return { notify: true, sound: false, privacy: false, hide_uid: false, notify_preview: true };
    return {
        notify: !!s.notify,
        sound: !!s.sound,
        privacy: !!s.privacy,
        hide_uid: !!s.hide_uid,
        notify_preview: (s.notify_preview !== false),
    };
}

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
const dom = {};
function $id(id) {
    const cached = dom[id];
    if (cached) return cached;
    const el = document.getElementById(id);
    if (el) dom[id] = el;
    return el;
}

function toast(msg) {
    const t = $id('toast');
    if (!t) return;
    t.textContent = String(msg || '');
    t.classList.add('show');
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => t.classList.remove('show'), 1800);
}

function readJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function readUiSettings() {
    return readJson(UI_SETTINGS_KEY, { cursor_fx: false, bg_motion: false });
}

function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function persist() {
    writeJson(THREADS_KEY, state.threads);
    // Only persist meta fields for contacts
    writeJson(CONTACTS_KEY, state.contacts.map((c) => ({ id: c.id, uid: c.uid || 0, unread: c.unread || 0, online: !!c.online, name: c.name, seed: c.seed, last: c.last, time: c.time, pinned: !!c.pinned, removed: !!c.removed })));
    writeJson(MUTED_KEY, state.muted || {});
    writeJson(DRAFT_KEY, state.drafts || {});
    writeJson(FRIENDS_KEY, state.friends || []);
}

function updateStatusRemote(uid, status) {
    if (!uid) return;
    fetch('/api/update_status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: String(uid), status: String(status || '') })
    }).catch(() => {});
}

async function loadTurnConfig() {
    try {
        // If the user configured TURN manually in client.html, keep it.
        const existing = readJson('qbe.turn', null);
        if (existing && existing.urls) return;
        const res = await fetch('/api/rtc_config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const j = await res.json().catch(() => null);
        if (j && j.ok && j.enabled && j.urls) {
            writeJson('qbe.turn', { urls: j.urls, username: j.username || '', credential: j.credential || '' });
        }
    } catch (_) {}
}

function totalUnread() {
    return state.contacts.reduce((n, c) => n + (c && c.unread ? c.unread : 0), 0);
}

function syncTitle() {
    const n = totalUnread();
    const base = 'QBE Chat';
    document.title = n > 0 ? `(${n}) ${base}` : base;
}

function ensureAudio() {
    if (runtime2.audio) return runtime2.audio;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    runtime2.audio = new Ctx();
    return runtime2.audio;
}

async function unlockAudioIfNeeded() {
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
        if (ctx.state === 'suspended') await ctx.resume();
        runtime2.audioUnlocked = true;
    } catch (_) {}
}

function playPing() {
    const s = state.settings;
    if (!s || !s.sound) return;
    const ctx = ensureAudio();
    if (!ctx || !runtime2.audioUnlocked) return;

    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(784, t0);
    o.frequency.exponentialRampToValueAtTime(659, t0 + 0.12);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.20);
}

function maybeNotifyIncoming(contact, text) {
    const s = state.settings;
    if (!s || !s.notify) return;

    const name = contact && contact.name ? contact.name : '新消息';
    const msg = (s.notify_preview === false) ? '' : String(text || '').trim();

    // In-app toast for quick feedback
    toast(`${name}: ${msg || '收到新消息'}`);

    // Optional browser notification
    try {
        if (!('Notification' in window)) return;
        if (!document.hidden) return;
        if (Notification.permission === 'granted') {
            new Notification('QBE Chat', { body: `${name}: ${msg || '收到新消息'}`.slice(0, 120) });
        }
    } catch (_) {}
}

function hydrateFromStorage() {
    const savedThreads = readJson(THREADS_KEY, null);
    if (savedThreads && typeof savedThreads === 'object') {
        state.threads = Object.assign({}, state.threads, savedThreads);
    }

    const savedMuted = readJson(MUTED_KEY, null);
    if (savedMuted && typeof savedMuted === 'object') state.muted = savedMuted;
    else state.muted = {};

    const savedDrafts = readJson(DRAFT_KEY, null);
    if (savedDrafts && typeof savedDrafts === 'object') state.drafts = savedDrafts;
    else state.drafts = {};

    const savedContacts = readJson(CONTACTS_KEY, null);
    if (Array.isArray(savedContacts)) {
        for (const s of savedContacts) {
            const c = state.contacts.find((x) => x.id === s.id);
            if (!c) continue;
            if (typeof s.uid === 'number') c.uid = s.uid;
            if (typeof s.unread === 'number') c.unread = s.unread;
            if (typeof s.last === 'string') c.last = s.last;
            if (typeof s.time === 'string') c.time = s.time;
            if (typeof s.pinned === 'boolean') c.pinned = s.pinned;
            if (typeof s.removed === 'boolean') c.removed = s.removed;
        }
    }

    // keep pinned chats on top
    state.contacts.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const au = a.unread || 0;
        const bu = b.unread || 0;
        if (au !== bu) return bu - au;
        return 0;
    });

    const savedFriends = readJson(FRIENDS_KEY, null);
    if (Array.isArray(savedFriends)) state.friends = savedFriends;
    else state.friends = [];
}

// Keep chat settings in sync with profile page.
window.addEventListener('storage', (e) => {
    try {
        if (!e || e.key !== SETTINGS_KEY) return;
        state.settings = loadSettings();
    } catch (_) {}
});

function loadCollapsed() {
    try {
        return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch (_) {
        return false;
    }
}

function loadActiveId() {
    try {
        const id = localStorage.getItem(ACTIVE_KEY);
        return id ? String(id) : null;
    } catch (_) {
        return null;
    }
}

function saveActiveId(id) {
    try {
        if (!id) localStorage.removeItem(ACTIVE_KEY);
        else localStorage.setItem(ACTIVE_KEY, String(id));
    } catch (_) {}
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const renderUserList = rafThrottle((root) => {
    const el = $id('user-list');
    if (!el) return;
    const kw = ($id('search')?.value || '').trim().toLowerCase();

    const list = state.contacts.filter((c) => {
        if (kw && !c.name.toLowerCase().includes(kw)) return false;
        if (state.filter === 'online' && !c.online) return false;
        if (state.filter === 'unread' && !c.unread) return false;
        return true;
    });

    const activeList = list.filter((c) => !c.removed);
    const removedList = list.filter((c) => c.removed);

    // display pinned first
    activeList.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        const au = a.unread || 0;
        const bu = b.unread || 0;
        if (au !== bu) return bu - au;
        return 0;
    });

    if (!activeList.length && !removedList.length) {
        el.innerHTML = `
            <div class="empty" role="status">
                <strong>没有匹配的会话</strong>
                <span>试试清空搜索词，或切换到“全部”。</span>
            </div>
        `;
        runtimeView.listSignature = '';
        runtimeView.listFilter = state.filter;
        runtimeView.listSearch = kw;
        return;
    }

    const renderItem = (c) => {
        const active = c.id === state.activeId ? 'active' : '';
        const dotClass = c.online ? 'u-dot u-dot-status live' : 'u-dot u-dot-status';
        const unread = c.unread ? `<div class="u-dot u-unread">${c.unread}</div>` : `<div class="u-dot u-dot-ghost u-unread">0</div>`;
        const pin = c.pinned ? `<i class="fa-solid fa-thumbtack u-pin" title="已置顶"></i>` : '';
        return `
            <div class="user ${active} ${c.removed ? 'removed' : ''}" role="option" aria-selected="${active ? 'true' : 'false'}" tabindex="0" data-id="${c.id}">
                <div class="u-avatar" aria-hidden="true">${escapeHtml(c.seed)}</div>
                <div class="u-meta">
                    <div class="u-name">${escapeHtml(c.name)}${pin}</div>
                    <div class="u-last">${escapeHtml(c.last)}</div>
                </div>
                <div class="u-badges" aria-hidden="true">
                    <div class="u-time">${escapeHtml(c.time)}</div>
                    ${unread}
                    <div class="${dotClass}" title="${c.online ? '在线' : '离线'}"><i class="fa-solid fa-circle u-status"></i></div>
                </div>
            </div>
        `;
    };

    const signature = activeList.map((c) => c.id).join(',') + '|' + removedList.map((c) => c.id).join(',');
    const needFull = kw.length > 0 || runtimeView.listFilter !== state.filter || runtimeView.listSearch !== kw || runtimeView.listSignature !== signature;

    if (needFull) {
        let html = activeList.map(renderItem).join('');
        if (removedList.length) {
            html += `<div class="list-sep">已删除</div>`;
            html += removedList.map(renderItem).join('');
        }
        el.innerHTML = html;
        try { if (typeof document.__parseEmoji === 'function') document.__parseEmoji(el); } catch (_) {}
    } else {
        const updateRow = (c) => {
            const row = el.querySelector(`.user[data-id="${c.id}"]`);
            if (!row) return false;
            const isActive = c.id === state.activeId;
            row.classList.toggle('active', isActive);
            row.classList.toggle('removed', !!c.removed);
            row.setAttribute('aria-selected', isActive ? 'true' : 'false');

            const avatar = row.querySelector('.u-avatar');
            if (avatar) avatar.textContent = c.seed;

            const nameEl = row.querySelector('.u-name');
            if (nameEl) {
                const pin = c.pinned ? '<i class="fa-solid fa-thumbtack u-pin" title="已置顶"></i>' : '';
                nameEl.innerHTML = escapeHtml(c.name) + pin;
            }

            const lastEl = row.querySelector('.u-last');
            if (lastEl) lastEl.textContent = c.last || '';

            const timeEl = row.querySelector('.u-time');
            if (timeEl) timeEl.textContent = c.time || '';

            const unreadEl = row.querySelector('.u-unread');
            if (unreadEl) {
                if (c.unread) {
                    unreadEl.classList.remove('u-dot-ghost');
                    unreadEl.textContent = String(c.unread);
                } else {
                    unreadEl.classList.add('u-dot-ghost');
                    unreadEl.textContent = '0';
                }
            }

            const statusDot = row.querySelector('.u-dot-status');
            if (statusDot) {
                statusDot.classList.toggle('live', !!c.online);
                statusDot.setAttribute('title', c.online ? '在线' : '离线');
            }
            return true;
        };

        let ok = true;
        for (const c of activeList) {
            if (!updateRow(c)) { ok = false; break; }
        }
        if (ok) {
            for (const c of removedList) {
                if (!updateRow(c)) { ok = false; break; }
            }
        }
        if (!ok) {
            let html = activeList.map(renderItem).join('');
            if (removedList.length) {
                html += `<div class="list-sep">已删除</div>`;
                html += removedList.map(renderItem).join('');
            }
            el.innerHTML = html;
        }
    }

    runtimeView.listSignature = signature;
    runtimeView.listFilter = state.filter;
    runtimeView.listSearch = kw;
});

function renderFriendList() {
    const el = $id('friend-list');
    if (!el) return;
    const list = Array.isArray(state.friends) ? state.friends : [];
    if (!list.length) {
        el.innerHTML = '<div class="muted-hint">暂无好友</div>';
        return;
    }
    const active = list.filter((f) => !f.removed);
    const removed = list.filter((f) => f.removed);
    const item = (f) => {
        const badge = String((f.name || 'U')[0]).toUpperCase();
        const cls = f.removed ? 'friend-item friend-removed' : 'friend-item';
        return `
            <div class="${cls}" data-uid="${f.uid}">
                <div class="friend-meta">
                    <div class="friend-badge">${badge}</div>
                    <div>
                        <div class="friend-name">${escapeHtml(f.name || ('UID ' + f.uid))}</div>
                        <div class="friend-uid">UID ${f.uid}</div>
                    </div>
                </div>
            </div>
        `;
    };
    let html = active.map(item).join('');
    if (removed.length) {
        html += '<div class="list-sep">已删除好友</div>';
        html += removed.map(item).join('');
    }
    el.innerHTML = html;
}

function updateChatBodyPadding() {
    const body = $id('chat-body');
    if (!body) return;
    body.style.paddingBottom = runtimeView.autoScroll ? '18px' : '56px';
}

function isNearBottom(el, px = 24) {
    if (!el) return true;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= px;
}

const renderThread = rafThrottle(() => {
    const c = state.contacts.find((x) => x.id === state.activeId) || state.contacts[0];
    if (!c) return;

    $id('peer-avatar').textContent = c.seed;
    $id('peer-name').textContent = c.name;
    const statusText = c.status ? String(c.status) : (c.online ? '在线' : '离线');
    $id('peer-sub').textContent = statusText;

    const list = state.threads[c.id] || [];
    const body = $id('chat-body');
    if (!body) return;

    const q = (searchState.q || '').trim().toLowerCase();
    const renderRichText = document.__renderRichText || ((s) => escapeHtml(s).replace(/\n/g, '<br>'));
    const renderSearchText = (raw) => {
        const attach = parseAttachText(raw);
        if (attach) {
            if (attach.type === 'media') {
                if (attach.mime && attach.mime.startsWith('video/')) {
                    return `<video controls preload="metadata" src="${escapeHtml(attach.url)}"></video><div class="muted-hint">${escapeHtml(attach.name)}</div>`;
                }
                return `<img class="chat-img" src="${escapeHtml(attach.url)}" alt="${escapeHtml(attach.name)}"><div class="muted-hint">${escapeHtml(attach.name)}</div>`;
            }
            return `<a href="${escapeHtml(attach.url)}" download>${escapeHtml(attach.name)}</a>`;
        }
        if (!q) return renderRichText(raw);
        const text = String(raw || '');
        const lower = text.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx < 0) return renderRichText(text);
        // highlight all matches on plain text, then convert newlines
        let out = '';
        let from = 0;
        while (from < text.length) {
            const i = lower.indexOf(q, from);
            if (i < 0) {
                out += escapeHtml(text.slice(from));
                break;
            }
            out += escapeHtml(text.slice(from, i));
            out += '<mark class="hl">' + escapeHtml(text.slice(i, i + q.length)) + '</mark>';
            from = i + q.length;
        }
        return out.replace(/\r\n|\r|\n/g, '<br>');
    };

    const shouldReset = (runtimeView.lastRenderedId !== c.id);
    const shouldFull = shouldReset || q.length > 0;
    const nearBottom = isNearBottom(body);
    runtimeView.autoScroll = runtimeView.autoScroll && nearBottom;

    if (shouldFull) {
        const top = `<div class="day-sep"><span>今天</span></div>`;
        body.innerHTML = top + list.map((m) => {
            return `
                <div class="msg-row ${m.me ? 'me' : ''}" data-msgid="${escapeHtml(String(m.id || ''))}">
                    <div class="msg">
                        <div class="stamp">${escapeHtml(m.at || '')}</div>
                        <div class="bubble">${renderSearchText(m.text)}</div>
                    </div>
                </div>
            `;
        }).join('');
        try {
            if (typeof document.__parseEmoji === 'function') document.__parseEmoji(body);
        } catch (_) {}
    } else {
        const start = Math.max(runtimeView.lastRenderLen, 0);
        if (start < list.length) {
            const frag = document.createDocumentFragment();
            let lastRow = null;
            for (let i = start; i < list.length; i += 1) {
                const m = list[i];
                const row = document.createElement('div');
                row.className = 'msg-row ' + (m.me ? 'me' : '');
                row.setAttribute('data-msgid', String(m.id || ''));

                const msg = document.createElement('div');
                msg.className = 'msg';

                const stamp = document.createElement('div');
                stamp.className = 'stamp';
                stamp.textContent = m.at || '';

                const bubble = document.createElement('div');
                bubble.className = 'bubble';
                bubble.innerHTML = renderSearchText(m.text);

                msg.appendChild(stamp);
                msg.appendChild(bubble);
                row.appendChild(msg);
                frag.appendChild(row);
                lastRow = row;
            }
            body.appendChild(frag);
            try {
                if (lastRow && typeof document.__parseEmoji === 'function') {
                    document.__parseEmoji(lastRow);
                }
            } catch (_) {}
        }
    }

    runtimeView.lastRenderedId = c.id;
    runtimeView.lastRenderLen = list.length;

    if (runtimeView.autoScroll || shouldReset) {
        body.scrollTop = body.scrollHeight;
    }
    updateChatBodyPadding();
});

function scheduleRender() {
    renderUserList(document);
    renderThread();
}

let cgMembers = [];

function isFriend(uid) {
    const u = Number(uid) || 0;
    if (!u || !state.friends) return false;
    return state.friends.some((f) => Number(f.uid) === u && !f.removed);
}

function readGroupMembers() {
    const data = readJson(GROUP_MEMBERS_KEY, {});
    return data && typeof data === 'object' ? data : {};
}

function writeGroupMembers(map) {
    writeJson(GROUP_MEMBERS_KEY, map || {});
}

const groupAddState = {
    groupId: null,
    search: ''
};

const hoverState = {
    timer: 0,
    uid: null,
    contactId: null
};

const renderGroupAddList = rafThrottle(() => {
    const listEl = $id('group-add-list');
    if (!listEl) return;
    const status = $id('group-add-status');
    const map = readGroupMembers();
    const members = groupAddState.groupId ? (map[groupAddState.groupId] || []) : [];
    const q = (groupAddState.search || '').trim().toLowerCase();

    const friends = (state.friends || []).filter((f) => !f.removed);
    const filtered = friends.filter((f) => {
        const name = String(f.name || ('UID ' + f.uid)).toLowerCase();
        return !q || name.includes(q) || String(f.uid).includes(q);
    });

    if (!filtered.length) {
        listEl.innerHTML = '<div class="muted-hint">暂无可邀请好友</div>';
        if (status) { status.textContent = ''; status.className = 'nm-status'; }
        return;
    }

    const html = filtered.map((f) => {
        const inGroup = members.includes(Number(f.uid));
        const badge = String((f.name || 'U')[0]).toUpperCase();
        return `
            <div class="member-item" data-uid="${f.uid}">
                <div class="member-meta">
                    <div class="member-badge">${badge}</div>
                    <div>
                        <div class="member-name">${escapeHtml(f.name || ('UID ' + f.uid))}</div>
                        <div class="member-sub">UID ${f.uid}</div>
                    </div>
                </div>
                <button class="member-action" type="button" ${inGroup ? 'disabled' : ''}>
                    ${inGroup ? '已在群内' : '添加'}
                </button>
            </div>
        `;
    }).join('');
    listEl.innerHTML = html;
    if (status) { status.textContent = ''; status.className = 'nm-status'; }
});

function showHoverPop(html, x, y) {
    const pop = $id('hover-pop');
    if (!pop) return;
    pop.innerHTML = html;
    const padding = 12;
    const w = pop.offsetWidth || 280;
    const h = pop.offsetHeight || 180;
    const px = Math.max(padding, Math.min(x, window.innerWidth - w - padding));
    const py = Math.max(padding, Math.min(y, window.innerHeight - h - padding));
    pop.style.left = px + 'px';
    pop.style.top = py + 'px';
    pop.classList.add('show');
}

function hideHoverPop() {
    const pop = $id('hover-pop');
    if (!pop) return;
    pop.classList.remove('show');
}

function openAddFriendModal() {
    const pop = $id('new-menu-pop');
    const btn = $id('btn-new-menu');
    if (pop) pop.setAttribute('data-open', 'false');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const modal = $id('add-friend-modal');
    if (!modal) return;
    const input = $id('add-friend-uid');
    const status = $id('add-friend-status');
    if (input) input.value = '';
    if (status) { status.textContent = ''; status.className = 'nm-status'; }
    modal.setAttribute('data-open', 'true');
    window.setTimeout(() => input && input.focus(), 80);
}

function openCreateGroupModal() {
    const pop = $id('new-menu-pop');
    const btn = $id('btn-new-menu');
    if (pop) pop.setAttribute('data-open', 'false');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const modal = $id('create-group-modal');
    if (!modal) return;
    const name = $id('group-name-input');
    const uid = $id('group-uid-input');
    const status = $id('create-group-status');
    const chips = $id('group-member-chips');
    cgMembers = [];
    if (name) name.value = '';
    if (uid) uid.value = '';
    if (status) { status.textContent = ''; status.className = 'nm-status'; }
    if (chips) chips.innerHTML = '<span class="muted-hint">暂无成员，请添加</span>';
    modal.setAttribute('data-open', 'true');
    window.setTimeout(() => name && name.focus(), 80);
}

function rebuildSearchMatches() {
    const q = (searchState.q || '').trim().toLowerCase();
    searchState.matches = [];
    searchState.cursor = -1;
    if (!q) return;
    const id = state.activeId;
    const list = (id && state.threads[id]) ? state.threads[id] : [];
    list.forEach((m) => {
        if (String(m.text || '').toLowerCase().includes(q)) searchState.matches.push(String(m.id || ''));
    });
    if (searchState.matches.length) searchState.cursor = 0;
}

function updateSearchMeta() {
    const el = $id('search-meta');
    if (!el) return;
    const total = searchState.matches.length;
    const cur = (total && searchState.cursor >= 0) ? (searchState.cursor + 1) : 0;
    el.textContent = `${cur}/${total}`;
}

function jumpToMatch(delta) {
    const total = searchState.matches.length;
    if (!total) return;
    searchState.cursor = (searchState.cursor + delta + total) % total;
    updateSearchMeta();
    const msgid = searchState.matches[searchState.cursor];
    const row = qsa('.msg-row').find((el) => String(el.getAttribute('data-msgid') || '') === String(msgid));
    if (row) {
        row.classList.remove('bump');
        // ensure reflow
        void row.offsetWidth;
        row.classList.add('bump');
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

function setActive(id) {
    // Save draft of current thread
    try {
        const ta = $id('composer');
        if (ta && state.activeId) {
            state.drafts[state.activeId] = String(ta.value || '');
        }
    } catch (_) {}

    state.activeId = id;
    saveActiveId(id);
    runtimeView.lastRenderedId = null;
    runtimeView.lastRenderLen = 0;
    const c = state.contacts.find((x) => x.id === id);
    if (c) c.unread = 0;
    scheduleRender();
    syncTitle();

    // Load draft of new thread
    try {
        const ta = $id('composer');
        if (ta) {
            ta.value = state.drafts[id] ? String(state.drafts[id]) : '';
            ta.dispatchEvent(new Event('input'));
        }
    } catch (_) {}

    persist();

    // Mobile: close drawer after selecting
    if (document.body.classList.contains('sidebar-open')) closeDrawer();
}

function setCollapsed(next) {
    state.collapsed = next;
    const side = $id('sidebar');
    if (side) side.setAttribute('data-collapsed', next ? 'true' : 'false');
    syncCollapseIcon();
    renderUserList(document);

    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch (_) {}
}

function syncCollapseIcon() {
    const btn = $id('btn-collapse');
    if (!btn) return;
    const side = $id('sidebar');
    const app = $id('app');
    if (isMobile()) {
        btn.setAttribute('aria-label', '菜单');
        btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
        btn.setAttribute('data-mobile', 'true');
        if (side) side.setAttribute('data-collapsed', document.body.classList.contains('sidebar-open') ? 'false' : 'true');
        if (app) app.classList.remove('sidebar-collapsed');
    } else {
        btn.setAttribute('aria-label', '收起/展开联系人');
        btn.innerHTML = `<i class="${state.collapsed ? 'fa-solid fa-angles-right' : 'fa-solid fa-angles-left'}"></i>`;
        btn.removeAttribute('data-mobile');
        if (side) side.setAttribute('data-collapsed', state.collapsed ? 'true' : 'false');
        if (app) app.classList.toggle('sidebar-collapsed', !!state.collapsed);
    }
}

function bumpComposerHeight() {
    const ta = $id('composer');
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}

function canSend(text) {
    return (text || '').trim().length > 0;
}

function buildAttachText(type, name, url, mime) {
    return ATTACH_PREFIX + [type || '', name || '', url || '', mime || ''].join('|');
}

function parseAttachText(text) {
    if (!text || text.indexOf(ATTACH_PREFIX) !== 0) return null;
    const raw = text.slice(ATTACH_PREFIX.length);
    const parts = raw.split('|');
    if (parts.length < 4) return null;
    return {
        type: parts[0],
        name: parts[1],
        url: parts[2],
        mime: parts[3]
    };
}

function sendOutgoingMessage(text, msgId) {
    const id = state.activeId;
    const c = state.contacts.find((x) => x.id === id);
    const session = readJson(SESSION_KEY, null);
    const fromUid  = session && session.uid ? Number(session.uid) : 0;
    const fromName = (session && (session.username || session.name)) ? String(session.username || session.name) : '';
    const peerUid  = c && c.uid ? Number(c.uid) : 0;

    if (fromUid && peerUid && peerUid !== fromUid) {
        fetch('/api/send_message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from_uid: fromUid,
                to_uid:   peerUid,
                text:     text,
                msg_id:   msgId,
                from_name: fromName
            })
        }).catch(() => {});
    }

    if (fromUid && c && !c.uid) {
        const map = readGroupMembers();
        const members = Array.isArray(map[id]) ? map[id] : [];
        if (members.length) {
            fetch('/api/send_group_message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from_uid: fromUid,
                    group_id: String(id),
                    text,
                    msg_id: msgId,
                    from_name: fromName,
                    members
                })
            }).catch(() => {});
        }
    }
}

function validateFileSize(file, maxBytes) {
    return file && file.size <= maxBytes;
}

function isAllowedArchive(file) {
    if (!file) return false;
    const name = String(file.name || '').toLowerCase();
    return name.endsWith('.zip') || name.endsWith('.rar');
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const res = String(reader.result || '');
            const idx = res.indexOf('base64,');
            resolve(idx >= 0 ? res.slice(idx + 7) : res);
        };
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
    });
}

const uploadState = {
    active: false,
    cancelled: false,
    lastFile: null,
    lastKind: ''
};

async function uploadFileToServer(file) {
    const CHUNK = 1024 * 1024; // 1MB
    let offset = 0;
    const total = file.size || 1;
    const prog = $id('upload-progress');
    const bar = $id('upload-bar');
    const meta = $id('upload-meta');
    const cancelBtn = $id('upload-cancel');
    if (prog) prog.classList.add('show');
    if (bar) bar.style.width = '0%';
    if (meta) meta.textContent = '上传中… 0%';
    if (cancelBtn) cancelBtn.disabled = false;
    uploadState.active = true;
    uploadState.cancelled = false;
    while (offset < file.size) {
        if (uploadState.cancelled) throw new Error('cancelled');
        const slice = file.slice(offset, offset + CHUNK);
        const content = await readFileAsBase64(slice);
        const res = await fetch('/api/upload_chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_name: file.name,
                size: file.size,
                offset,
                content
            })
        });
        const json = await res.json();
        if (!json || !json.ok) throw new Error(json && json.error ? json.error : 'upload failed');
        offset = Number(json.next_offset || 0);
        if (!offset) break;
        const pct = Math.min(100, Math.round((offset / total) * 100));
        if (bar) bar.style.width = pct + '%';
        if (meta) meta.textContent = '上传中… ' + pct + '%';
    }
    if (bar) bar.style.width = '100%';
    if (meta) meta.textContent = '上传完成';
    if (prog) window.setTimeout(() => prog.classList.remove('show'), 800);
    if (cancelBtn) cancelBtn.disabled = true;
    uploadState.active = false;
    return { ok: true, file_url: '/uploads/' + encodeURIComponent(file.name), file_name: file.name };
}

function sendMessage() {
    const ta = $id('composer');
    const text = (ta.value || '');
    if (!canSend(text)) return;

    const id = state.activeId;
    if (!id) {
        toast('请先选择一个会话');
        return;
    }

    if (!state.threads[id]) state.threads[id] = [];
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const msgId = String(Date.now()) + '-' + String(Math.random()).slice(2, 7);
    state.threads[id].push({ id: msgId, me: true, text: text.trim(), at: `${hh}:${mm}` });

    const c = state.contacts.find((x) => x.id === id);
    if (c) {
        c.last = text.trim();
        c.time = `${hh}:${mm}`;
    }

    ta.value = '';
    bumpComposerHeight();
    $id('btn-send').disabled = true;
    scheduleRender();
    state.drafts[id] = '';
    persist();

    // --- Server relay ---
    sendOutgoingMessage(text.trim(), msgId);
}

function isMobile() {
    return window.matchMedia && window.matchMedia('(max-width: 900px)').matches;
}

function wire(root) {
    // Sound needs a user gesture before it can play.
    document.addEventListener('pointerdown', unlockAudioIfNeeded, { once: true });

    // Notifications need permission; ask only on first interaction.
    document.addEventListener('pointerdown', () => {
        try {
            const s = state.settings;
            if (!s || !s.notify) return;
            if (!('Notification' in window)) return;
            if (Notification.permission === 'default') {
                Notification.requestPermission().catch(() => {});
            }
        } catch (_) {}
    }, { once: true });

    // Apply UI settings (cursor effects + background motion)
    const ui = readUiSettings();
    document.documentElement.classList.toggle('cursor-fx-on', !!ui.cursor_fx);
    document.documentElement.classList.toggle('bg-motion-on', !!ui.bg_motion);

    const collapseBtn = $id('btn-collapse');
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            if (isMobile()) {
                if (document.body.classList.contains('sidebar-open')) closeDrawer();
                else openDrawer();
                return;
            }
            setCollapsed(!state.collapsed);
        });
    }

    // File and media buttons
    const btnMedia = $id('btn-media');
    const btnFile = $id('btn-file');
    const mediaInput = $id('media-input');
    const fileInput = $id('file-input');
    const MAX_SIZE = 50 * 1024 * 1024;

    btnMedia && btnMedia.addEventListener('click', () => mediaInput && mediaInput.click());
    btnFile && btnFile.addEventListener('click', () => fileInput && fileInput.click());

    let uploading = false;

    mediaInput && mediaInput.addEventListener('change', (e) => {
        const file = e.target && e.target.files ? e.target.files[0] : null;
        if (!file) return;
        if (uploading) { toast('上传进行中，请稍后'); e.target.value = ''; return; }
        if (!validateFileSize(file, MAX_SIZE)) {
            toast('图片/视频不能超过 50MB');
            e.target.value = '';
            return;
        }
        const isImage = file.type && file.type.startsWith('image/');
        const isVideo = file.type && file.type.startsWith('video/');
        if (!isImage && !isVideo) {
            toast('仅支持图片或视频');
            e.target.value = '';
            return;
        }
        toast('上传中…');
        uploading = true;
        uploadState.lastFile = file;
        uploadState.lastKind = 'media';
        uploadFileToServer(file).then((j) => {
            if (j && j.ok && j.file_url) {
                toast('上传成功');
                const id = state.activeId;
                if (id && state.threads[id]) {
                    const now = new Date();
                    const at = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
                    const msgId = 'file-' + Date.now();
                    const payload = buildAttachText('media', file.name, j.file_url, file.type || '');
                    state.threads[id].push({ id: msgId, me: true, text: payload, at });
                    scheduleRender();
                    persist();
                    sendOutgoingMessage(payload, msgId);
                }
            } else {
                toast('上传失败：' + ((j && j.error) || '未知错误'));
            }
        }).catch((e) => {
            if (e && String(e.message) === 'cancelled') toast('已取消上传');
            else toast('上传失败');
        }).finally(() => { uploading = false; });
        e.target.value = '';
    });

    fileInput && fileInput.addEventListener('change', (e) => {
        const file = e.target && e.target.files ? e.target.files[0] : null;
        if (!file) return;
        if (uploading) { toast('上传进行中，请稍后'); e.target.value = ''; return; }
        if (!validateFileSize(file, MAX_SIZE)) {
            toast('压缩文件不能超过 50MB');
            e.target.value = '';
            return;
        }
        if (!isAllowedArchive(file)) {
            toast('仅支持 .zip 或 .rar');
            e.target.value = '';
            return;
        }
        toast('上传中…');
        uploading = true;
        uploadState.lastFile = file;
        uploadState.lastKind = 'file';
        uploadFileToServer(file).then((j) => {
            if (j && j.ok && j.file_url) {
                toast('上传成功');
                const id = state.activeId;
                if (id && state.threads[id]) {
                    const now = new Date();
                    const at = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
                    const msgId = 'file-' + Date.now();
                    const payload = buildAttachText('file', file.name, j.file_url, file.type || '');
                    state.threads[id].push({ id: msgId, me: true, text: payload, at });
                    scheduleRender();
                    persist();
                    sendOutgoingMessage(payload, msgId);
                }
            } else {
                toast('上传失败：' + ((j && j.error) || '未知错误'));
            }
        }).catch((e) => {
            if (e && String(e.message) === 'cancelled') toast('已取消上传');
            else toast('上传失败');
        }).finally(() => { uploading = false; });
        e.target.value = '';
    });

    $id('upload-cancel')?.addEventListener('click', () => {
        if (!uploadState.active) return;
        uploadState.cancelled = true;
        const meta = $id('upload-meta');
        if (meta) meta.textContent = '正在取消…';
        const cancelBtn = $id('upload-cancel');
        if (cancelBtn) cancelBtn.disabled = true;
        if (uploadState.lastFile) {
            fetch('/api/upload_cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_name: uploadState.lastFile.name })
            }).catch(() => {});
        }
        const prog = $id('upload-progress');
        if (prog) prog.classList.remove('show');
    });

    

    // New-menu button: ensure open even if script runs before DOM ready
    document.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('#btn-new-menu') : null;
        if (!btn) return;
        e.preventDefault();
        const pop = $id('new-menu-pop');
        if (!pop) return;
        const open = pop.getAttribute('data-open') === 'true';
        pop.setAttribute('data-open', open ? 'false' : 'true');
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    const userList = $id('user-list');
    if (userList) {
        userList.addEventListener('click', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.user') : null;
            if (!item) return;
            setActive(item.getAttribute('data-id'));
        });
        userList.addEventListener('keydown', (e) => {
            const item = e.target && e.target.classList && e.target.classList.contains('user') ? e.target : null;
            if (!item) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActive(item.getAttribute('data-id'));
            }
        });
    }

    const friendList = $id('friend-list');
    if (friendList) {
        friendList.addEventListener('click', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.friend-item') : null;
            if (!item) return;
            const uid = Number(item.getAttribute('data-uid') || 0);
            if (!uid) return;
            const nameEl = item.querySelector('.friend-name');
            const name = nameEl ? String(nameEl.textContent || '') : ('UID ' + uid);
            const contact = addContact(name, uid);
            if (contact) {
                contact.removed = false;
                persist();
                scheduleRender();
                renderFriendList();
            }
        });
    }

    qs('.avatar-link', root)?.addEventListener('click', () => {
        try { sessionStorage.setItem('qbe.from', 'client_connect.html'); } catch (_) {}
    });

    const renderListDebounced = debounce(() => renderUserList(root), 120);
    $id('search')?.addEventListener('input', renderListDebounced);

    qsa('.pill', root).forEach((p) => {
        p.addEventListener('click', () => {
            qsa('.pill', root).forEach((x) => x.classList.remove('active'));
            p.classList.add('active');
            state.filter = p.getAttribute('data-filter');
            renderListDebounced();
        });
    });

    $id('composer')?.addEventListener('input', () => {
        bumpComposerHeight();
        $id('btn-send').disabled = !canSend($id('composer').value);
        if (state.activeId) state.drafts[state.activeId] = String($id('composer').value || '');
    });
    $id('btn-send')?.addEventListener('click', sendMessage);

    $id('composer')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Emoji picker (Unicode codepoints + Twemoji for consistent cross-platform rendering)
    const emojiBtn = $id('btn-emoji');
    const pop = $id('emoji-pop');
    const grid = $id('emoji-grid');

    const EMOJIS = [
        '😀','😁','😂','🤣','😊','🙂','😉','😍','😘','😎',
        '🤔','😅','😭','😡','🥳','😴','🤯','🤝','🙏','👏',
        '👍','👎','💪','🎉','🔥','✨','💯','✅','❌','⚠️',
        '❤️','💔','⭐','🌙','☀️','🌈','🍀','☕','🍺','🎧',
        '📌','📎','🧩','📷','🧠','🫡','😶‍🌫️','👀','🕒','🚀'
    ];

    const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/';
    function parseEmoji(el) {
        try {
            if (!el) return;
            if (!window.twemoji || typeof window.twemoji.parse !== 'function') return;
            window.twemoji.parse(el, {
                base: TWEMOJI_BASE,
                folder: 'svg',
                ext: '.svg',
                className: 'twemoji'
            });
        } catch (_) {}
    }

    // expose for thread renderer
    root.__parseEmoji = parseEmoji;
    root.__renderRichText = (s) => {
        const raw = String(s || '');
        const normalized = raw.replace(/\[e:(\d{1,4})\]/g, (_m, n) => {
            const i = Number(n);
            if (!Number.isFinite(i) || !EMOJIS.length) return '';
            return EMOJIS[(i % EMOJIS.length + EMOJIS.length) % EMOJIS.length];
        });
        return escapeHtml(normalized).replace(/\r\n|\r|\n/g, '<br>');
    };

    function openEmoji() {
        if (!pop || !emojiBtn) return;
        pop.setAttribute('data-open', 'true');
        emojiBtn.setAttribute('aria-expanded', 'true');
        emojiBtn.setAttribute('data-active', 'true');
    }

    function closeEmoji() {
        if (!pop || !emojiBtn) return;
        pop.setAttribute('data-open', 'false');
        emojiBtn.setAttribute('aria-expanded', 'false');
        emojiBtn.setAttribute('data-active', 'false');
    }

    function toggleEmoji() {
        if (!pop) return;
        const open = pop.getAttribute('data-open') === 'true';
        if (open) closeEmoji();
        else openEmoji();
    }

    function insertEmojiChar(ch) {
        const ta = $id('composer');
        if (!ta) return;
        const value = String(ta.value || '');
        const start = ta.selectionStart ?? value.length;
        const end = ta.selectionEnd ?? value.length;
        const insert = String(ch || '');
        ta.value = value.slice(0, start) + insert + value.slice(end);
        const pos = start + insert.length;
        try { ta.setSelectionRange(pos, pos); } catch (_) {}
        ta.dispatchEvent(new Event('input'));
        ta.focus();
    }

    function buildEmojiGrid() {
        if (!grid) return;
        grid.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const ch of EMOJIS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'emoji-item';
            btn.title = ch;
            btn.dataset.emoji = ch;

            const span = document.createElement('span');
            span.className = 'emoji-char';
            span.setAttribute('aria-hidden', 'true');
            span.textContent = ch;
            btn.appendChild(span);

            btn.addEventListener('click', () => {
                insertEmojiChar(ch);
                closeEmoji();
            });
            frag.appendChild(btn);
        }
        grid.appendChild(frag);
        parseEmoji(grid);
    }

    if (emojiBtn) {
        emojiBtn.addEventListener('click', () => {
            if (!grid) return;
            if (!grid.childElementCount) buildEmojiGrid();
            toggleEmoji();
        });
    }

    // close when clicking outside the composer
    document.addEventListener('click', (e) => {
        if (!pop || !emojiBtn) return;
        const open = pop.getAttribute('data-open') === 'true';
        if (!open) return;
        const t = e.target;
        if (pop.contains(t) || emojiBtn.contains(t)) return;
        closeEmoji();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeEmoji();
    });

    function closeHeadPops() {
        $id('search-pop')?.setAttribute('data-open', 'false');
        $id('more-pop')?.setAttribute('data-open', 'false');
    }

    function togglePop(id) {
        const el = qs(id);
        if (!el) return;
        const open = el.getAttribute('data-open') === 'true';
        closeHeadPops();
        el.setAttribute('data-open', open ? 'false' : 'true');
    }

    $id('btn-search')?.addEventListener('click', () => {
        togglePop('#search-pop');
        const pop = $id('search-pop');
        if (pop && pop.getAttribute('data-open') === 'true') {
            const inp = $id('search-thread');
            if (inp) {
                inp.focus();
                inp.select();
            }
        }
    });

    $id('btn-close-search')?.addEventListener('click', () => {
        $id('search-pop')?.setAttribute('data-open', 'false');
    });

    const onThreadSearch = debounce(() => {
        searchState.q = String($id('search-thread').value || '');
        rebuildSearchMatches();
        updateSearchMeta();
        renderThread();
        if (searchState.matches.length) jumpToMatch(0);
    }, 160);
    $id('search-thread')?.addEventListener('input', onThreadSearch);

    $id('btn-prev')?.addEventListener('click', () => jumpToMatch(-1));
    $id('btn-next')?.addEventListener('click', () => jumpToMatch(1));

    $id('btn-more')?.addEventListener('click', () => {
        togglePop('#more-pop');
        // sync mute label
        const id = state.activeId;
        const on = !!(id && state.muted && state.muted[id]);
        const s = $id('m-mute-s');
        if (s) s.textContent = on ? '开启' : '关闭';
    });

    // More actions
    $id('m-mute')?.addEventListener('click', () => {
        const id = state.activeId;
        if (!id) return toast('请先选择一个会话');
        state.muted[id] = !state.muted[id];
        const s = $id('m-mute-s');
        if (s) s.textContent = state.muted[id] ? '开启' : '关闭';
        persist();
    });

    // Contact management — old btn-new-chat replaced by new-menu
    // (handled in new-menu section below)

    // Ctrl/Cmd+K handled by global key handler below

    // Context menu on contact list item
    const cctx = $id('cctx');
    function closeCctx() {
        if (!cctx) return;
        cctx.setAttribute('data-open', 'false');
        cctx.removeAttribute('data-id');
        cctx.removeAttribute('data-uid');
        cctx.removeAttribute('data-mode');
    }

    function openCctx(x, y, id) {
        if (!cctx) return;
        const c = state.contacts.find((t) => t.id === id);
        if (!c) return;
        cctx.setAttribute('data-id', id);
        cctx.setAttribute('data-mode', 'contact');
        // Only groups can add members (group has no uid)
        const addBtn = cctx.querySelector('#cctx-add');
        if (addBtn) addBtn.style.display = c.uid ? 'none' : 'flex';
        const pinLabel = cctx.querySelector('#cctx-pin span');
        if (pinLabel) pinLabel.textContent = c.pinned ? '取消置顶' : '置顶';
        const addLabel = cctx.querySelector('#cctx-add span');
        if (addLabel) addLabel.textContent = '添加成员';
        const renameLabel = cctx.querySelector('#cctx-rename span');
        if (renameLabel) renameLabel.textContent = '重命名';
        const delLabel = cctx.querySelector('#cctx-del span');
        if (delLabel) delLabel.textContent = '删除会话';
        cctx.style.left = Math.max(10, Math.min(x, window.innerWidth - 220)) + 'px';
        cctx.style.top = Math.max(10, Math.min(y, window.innerHeight - 180)) + 'px';
        cctx.setAttribute('data-open', 'true');
    }

    function openFriendCctx(x, y, uid) {
        if (!cctx) return;
        cctx.setAttribute('data-mode', 'friend');
        cctx.setAttribute('data-uid', String(uid));
        const addBtn = cctx.querySelector('#cctx-add');
        if (addBtn) addBtn.style.display = 'none';
        const pinLabel = cctx.querySelector('#cctx-pin span');
        if (pinLabel) pinLabel.textContent = '置顶';
        const renameLabel = cctx.querySelector('#cctx-rename span');
        if (renameLabel) renameLabel.textContent = '重命名';
        const addLabel = cctx.querySelector('#cctx-add span');
        if (addLabel) addLabel.textContent = '添加成员';
        const delLabel = cctx.querySelector('#cctx-del span');
        if (delLabel) delLabel.textContent = '删除好友';
        cctx.style.left = Math.max(10, Math.min(x, window.innerWidth - 220)) + 'px';
        cctx.style.top = Math.max(10, Math.min(y, window.innerHeight - 180)) + 'px';
        cctx.setAttribute('data-open', 'true');
    }

    if (userList) {
        userList.addEventListener('contextmenu', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.user') : null;
            if (!item) return;
            e.preventDefault();
            const id = String(item.getAttribute('data-id') || '');
            if (!id) return;
            openCctx(e.clientX, e.clientY, id);
        });
    }

    function buildFriendHover(uid, name) {
        const status = (() => {
            const c = state.contacts.find((x) => Number(x.uid) === Number(uid));
            if (c && c.status) return String(c.status);
            const st = readJson(STATUS_KEY, null);
            return (st && st.status) ? String(st.status) : '在线';
        })();
        const sig = (() => {
            const c = state.contacts.find((x) => Number(x.uid) === Number(uid));
            return (c && c.signature) ? String(c.signature) : '暂无签名';
        })();
        const badge = String((name || 'U')[0]).toUpperCase();
        return `
            <div class="hover-head">
                <div class="hover-badge">${badge}</div>
                <div>
                    <div class="hover-title">${escapeHtml(name || ('UID ' + uid))}</div>
                    <div class="hover-sub">UID ${uid} · ${escapeHtml(status)}</div>
                </div>
            </div>
            <div class="hover-sub">签名：${escapeHtml(sig)}</div>
        `;
    }

    function buildGroupHover(id, name) {
        const map = readGroupMembers();
        const members = Array.isArray(map[id]) ? map[id] : [];
        const badge = String((name || 'G')[0]).toUpperCase();
        const chips = members.length
            ? members.map((u) => `<div class="hover-chip">UID ${u}</div>`).join('')
            : '<div class="hover-sub">暂无成员</div>';
        return `
            <div class="hover-head">
                <div class="hover-badge">${badge}</div>
                <div>
                    <div class="hover-title">${escapeHtml(name || '群聊')}</div>
                    <div class="hover-sub">成员数：${members.length}</div>
                </div>
            </div>
            <div class="hover-list">${chips}</div>
        `;
    }

    function scheduleHover(fn, key, x, y) {
        if (hoverState.timer) window.clearTimeout(hoverState.timer);
        hoverState.timer = window.setTimeout(() => {
            hoverState.timer = 0;
            if (key !== hoverState.contactId && key !== hoverState.uid) return;
            const html = fn();
            showHoverPop(html, x + 12, y + 12);
        }, 1000);
    }

    function clearHover() {
        if (hoverState.timer) window.clearTimeout(hoverState.timer);
        hoverState.timer = 0;
        hoverState.uid = null;
        hoverState.contactId = null;
        hideHoverPop();
    }

    if (userList) {
        userList.addEventListener('mousemove', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.user') : null;
            if (!item) { clearHover(); return; }
            const id = String(item.getAttribute('data-id') || '');
            if (!id) { clearHover(); return; }
            if (hoverState.contactId === id) return;
            clearHover();
            hoverState.contactId = id;
            const c = state.contacts.find((t) => t.id === id);
            if (!c) return;
            if (c.uid) {
                scheduleHover(() => buildFriendHover(c.uid, c.name), id, e.clientX, e.clientY);
            } else {
                scheduleHover(() => buildGroupHover(c.id, c.name), id, e.clientX, e.clientY);
            }
        });
        userList.addEventListener('mouseleave', clearHover);
    }

    if (friendList) {
        friendList.addEventListener('mousemove', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.friend-item') : null;
            if (!item) { clearHover(); return; }
            const uid = Number(item.getAttribute('data-uid') || 0);
            if (!uid) { clearHover(); return; }
            if (hoverState.uid === uid) return;
            clearHover();
            hoverState.uid = uid;
            const nameEl = item.querySelector('.friend-name');
            const name = nameEl ? String(nameEl.textContent || '') : ('UID ' + uid);
            scheduleHover(() => buildFriendHover(uid, name), uid, e.clientX, e.clientY);
        });
        friendList.addEventListener('mouseleave', clearHover);
    }

    if (friendList) {
        friendList.addEventListener('contextmenu', (e) => {
            const item = e.target && e.target.closest ? e.target.closest('.friend-item') : null;
            if (!item) return;
            e.preventDefault();
            const uid = Number(item.getAttribute('data-uid') || 0);
            if (!uid) return;
            openFriendCctx(e.clientX, e.clientY, uid);
        });
    }

    $id('cctx-pin')?.addEventListener('click', () => {
        const mode = cctx ? String(cctx.getAttribute('data-mode') || 'contact') : 'contact';
        if (mode === 'friend') {
            closeCctx();
            toast('好友不支持置顶');
            return;
        }
        const id = cctx ? String(cctx.getAttribute('data-id') || '') : '';
        const c = state.contacts.find((t) => t.id === id);
        closeCctx();
        if (!c) return;
        pinContact(id, !c.pinned);
        toast(c.pinned ? '已取消置顶' : '已置顶');
    });

    $id('cctx-add')?.addEventListener('click', () => {
        const mode = cctx ? String(cctx.getAttribute('data-mode') || 'contact') : 'contact';
        if (mode !== 'contact') {
            closeCctx();
            toast('仅群聊支持添加成员');
            return;
        }
        const id = cctx ? String(cctx.getAttribute('data-id') || '') : '';
        closeCctx();
        if (!id) return;

        const contact = state.contacts.find((t) => t.id === id);
        if (!contact) return;
        if (contact.uid) {
            toast('仅群聊支持添加成员');
            return;
        }

        groupAddState.groupId = id;
        groupAddState.search = '';
        const modal = $id('group-add-modal');
        const input = $id('group-add-search');
        const status = $id('group-add-status');
        if (input) input.value = '';
        if (status) { status.textContent = ''; status.className = 'nm-status'; }
        renderGroupAddList();
        if (modal) modal.setAttribute('data-open', 'true');
        window.setTimeout(() => input && input.focus(), 80);
    });

    $id('cctx-rename')?.addEventListener('click', () => {
        const mode = cctx ? String(cctx.getAttribute('data-mode') || 'contact') : 'contact';
        if (mode === 'friend') {
            closeCctx();
            toast('好友不支持重命名');
            return;
        }
        const id = cctx ? String(cctx.getAttribute('data-id') || '') : '';
        const c = state.contacts.find((t) => t.id === id);
        closeCctx();
        if (!c) return;
        const name = prompt('重命名会话', c.name);
        if (name == null) return;
        c.name = String(name || '').trim() || c.name;
        c.seed = c.name.slice(0, 1).toUpperCase();
        persist();
        scheduleRender();
        toast('已重命名');
    });

    $id('cctx-del')?.addEventListener('click', async () => {
        const mode = cctx ? String(cctx.getAttribute('data-mode') || 'contact') : 'contact';
        const uidAttr = cctx ? String(cctx.getAttribute('data-uid') || '') : '';
        const id = cctx ? String(cctx.getAttribute('data-id') || '') : '';
        closeCctx();

        if (mode === 'friend') {
            const uid = Number(uidAttr) || 0;
            if (!uid) return;
            if (!confirm('确认删除此好友？')) return;

            deleteFriend(uid);

            const c = state.contacts.find((t) => Number(t.uid) === uid);
            if (c) {
                c.removed = true;
                c.unread = 0;
                if (state.activeId === c.id) {
                    state.activeId = state.contacts.find((x) => !x.removed)?.id || null;
                    saveActiveId(state.activeId);
                }
                persist();
                scheduleRender();
            }

            try {
                const s = readJson(SESSION_KEY, null);
                const fromUid = s && s.uid ? Number(s.uid) : 0;
                if (fromUid && uid && fromUid !== uid) {
                    fetch('/api/remove_friend', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ from_uid: String(fromUid), to_uid: String(uid) })
                    }).catch(() => {});
                }
            } catch (_) {}
            toast('已删除好友');
            return;
        }

        if (!id) return;
        if (!confirm('确认删除此会话（本地）？')) return;
        const c = state.contacts.find((t) => t.id === id);
        if (c) {
            if (c.removed) {
                removeContact(id);
                removeGroupMembers(id);
                toast('已彻底删除');
                return;
            }
            c.removed = true;
            c.unread = 0;
            if (state.activeId === id) {
                state.activeId = state.contacts.find((x) => !x.removed)?.id || null;
                saveActiveId(state.activeId);
            }
            persist();
            scheduleRender();
            toast('已移入删除区');
        }
    });

    document.addEventListener('click', (e) => {
        if (cctx && cctx.getAttribute('data-open') === 'true') {
            if (!cctx.contains(e.target)) closeCctx();
        }
    });

    $id('m-clear')?.addEventListener('click', () => {
        const id = state.activeId;
        if (!id) return toast('请先选择一个会话');
        if (!confirm('确认清空当前会话聊天记录？')) return;
        state.threads[id] = [];
        renderThread();
        persist();
        toast('已清空');
    });

    $id('m-export')?.addEventListener('click', () => {
        const id = state.activeId;
        const c = state.contacts.find((x) => x.id === id);
        if (!id || !c) return toast('请先选择一个会话');
        const list = state.threads[id] || [];
        const lines = [];
        lines.push(`QBE Chat Export`);
        lines.push(`Peer: ${c.name} (${c.id})`);
        lines.push(`Time: ${new Date().toISOString()}`);
        lines.push('');
        list.forEach((m) => {
            const who = m.me ? 'ME' : c.name;
            lines.push(`[${m.at || ''}] ${who}: ${String(m.text || '')}`);
        });
        const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `chat_${c.id}_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        toast('已导出');
    });

    $id('m-copy-me')?.addEventListener('click', async () => {
        const s = readJson(SESSION_KEY, null);
        const username = (s && (s.username || s.name)) ? String(s.username || s.name) : '';
        const uid = (s && (s.uid !== undefined && s.uid !== null)) ? String(s.uid) : '';
        const email = (s && s.email) ? String(s.email) : '';
        const text = [username ? ('uname=' + username) : '', uid ? ('uid=' + uid) : '', email ? ('email=' + email) : ''].filter(Boolean).join('\n');
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
            else throw new Error('no clipboard');
            toast('已复制');
        } catch (_) {
            toast(text || '无可复制信息');
        }
    });

    // Group add modal (visual picker)
    const groupAddModal = $id('group-add-modal');
    const groupAddClose = $id('group-add-close');
    const groupAddCancel = $id('group-add-cancel');
    const groupAddSearch = $id('group-add-search');

    function closeGroupAddModal() {
        if (groupAddModal) groupAddModal.setAttribute('data-open', 'false');
        groupAddState.groupId = null;
        groupAddState.search = '';
    }

    groupAddClose && groupAddClose.addEventListener('click', closeGroupAddModal);
    groupAddCancel && groupAddCancel.addEventListener('click', closeGroupAddModal);
    groupAddModal && groupAddModal.addEventListener('click', (e) => {
        if (e.target === groupAddModal) closeGroupAddModal();
    });

    groupAddSearch && groupAddSearch.addEventListener('input', (e) => {
        groupAddState.search = String(e.target.value || '');
        renderGroupAddList();
    });

    $id('group-add-list')?.addEventListener('click', (e) => {
        const item = e.target && e.target.closest ? e.target.closest('.member-item') : null;
        if (!item) return;
        const btn = item.querySelector('.member-action');
        if (!btn || btn.disabled) return;
        const uid = Number(item.getAttribute('data-uid') || 0);
        if (!uid || !groupAddState.groupId) return;

        const map = readGroupMembers();
        const members = Array.isArray(map[groupAddState.groupId]) ? map[groupAddState.groupId] : [];
        if (members.includes(uid)) return;
        if (!isFriend(uid)) return;

        members.push(uid);
        map[groupAddState.groupId] = members;
        writeGroupMembers(map);
        renderGroupAddList();
        const status = $id('group-add-status');
        if (status) { status.textContent = '已添加成员'; status.className = 'nm-status ok'; }
    });

    // Close pops when clicking elsewhere
    document.addEventListener('click', (e) => {
        const searchPop = $id('search-pop');
        const morePop = $id('more-pop');
        const inPop = (searchPop && searchPop.contains(e.target)) || (morePop && morePop.contains(e.target));
        const isBtn = (e.target && (e.target.id === 'btn-search' || e.target.id === 'btn-call' || e.target.id === 'btn-more' || (e.target.closest && e.target.closest('#btn-search,#btn-more'))));
        if (!inPop && !isBtn) closeHeadPops();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeHeadPops();
            closeCtx();
            closeCall();
            closeCctx();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            // Open the new-menu pop (handled by new-menu section)
            const pop = $id('new-menu-pop');
            if (pop) {
                const open = pop.getAttribute('data-open') === 'true';
                pop.setAttribute('data-open', open ? 'false' : 'true');
                const btn = $id('btn-new-menu');
                if (btn) btn.setAttribute('aria-expanded', open ? 'false' : 'true');
            }
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            $id('search-pop')?.setAttribute('data-open', 'true');
            const inp = $id('search-thread');
            if (inp) { inp.focus(); inp.select(); }
        }
    });

    // Call modal (WebRTC)
    function fmt2(n) { return String(n).padStart(2, '0'); }
    function tickCall() {
        const el = $id('call-timer');
        if (!el) return;
        const sec = Math.max(0, Math.floor((Date.now() - runtime.callStart) / 1000));
        el.textContent = `${fmt2(Math.floor(sec / 60))}:${fmt2(sec % 60)}`;
    }
    function getMyUid() {
        const s = readJson(SESSION_KEY, null);
        return s && s.uid ? Number(s.uid) : 0;
    }
    function getIceServers() {
        const list = [{ urls: 'stun:stun.l.google.com:19302' }];
        const cfg = readJson('qbe.turn', null);
        if (!cfg) return list;
        const urls = Array.isArray(cfg.urls) ? cfg.urls : (cfg.urls ? String(cfg.urls).split(',') : []);
        if (!urls.length) return list;
        const turn = { urls: urls.map((s) => String(s).trim()).filter(Boolean) };
        if (cfg.username) turn.username = cfg.username;
        if (cfg.credential) turn.credential = cfg.credential;
        list.push(turn);
        return list;
    }
    function setCallStatus(text) {
        const el = $id('call-status');
        if (el) el.textContent = text;
    }
    function updateDeviceLists(list) {
        const mic = $id('call-mic');
        const cam = $id('call-cam');
        if (!mic || !cam) return;
        const audioInputs = list.filter((d) => d.kind === 'audioinput');
        const videoInputs = list.filter((d) => d.kind === 'videoinput');

        const build = (sel, items, label) => {
            const current = sel.value;
            sel.innerHTML = '';
            if (!items.length) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = label + '不可用';
                sel.appendChild(opt);
                sel.disabled = true;
                return;
            }
            sel.disabled = false;
            items.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || (label + (i + 1));
                sel.appendChild(opt);
            });
            if (current) sel.value = current;
        };

        build(mic, audioInputs, '麦克风');
        build(cam, videoInputs, '摄像头');
    }
    async function refreshDevices() {
        try {
        const list = await navigator.mediaDevices.enumerateDevices();
        updateDeviceLists(list);
    } catch (_) {}
}
    async function switchTracks(audioId, videoId) {
        if (!rtc.pc) return;
        const constraints = {
            audio: audioId ? { deviceId: { exact: audioId } } : true,
            video: videoId ? { deviceId: { exact: videoId } } : true
        };
        // Acquire new stream before stopping old to avoid brief audio/video gap.
        let newStream;
        try {
            newStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch (e) {
            toast('切换设备失败：' + (e.message || e.name));
            return;
        }
        const audioTrack = newStream.getAudioTracks()[0] || null;
        const videoTrack = newStream.getVideoTracks()[0] || null;
        const senders = rtc.pc.getSenders();
        if (audioTrack) { const s = senders.find((x) => x.track && x.track.kind === 'audio'); if (s) s.replaceTrack(audioTrack); }
        if (videoTrack) { const s = senders.find((x) => x.track && x.track.kind === 'video'); if (s) s.replaceTrack(videoTrack); }
        if (rtc.localStream) rtc.localStream.getTracks().forEach((t) => t.stop());
        rtc.localStream = newStream;
        const localEl = $id('call-local');
        if (localEl) { localEl.srcObject = rtc.localStream; localEl.muted = true; localEl.play && localEl.play().catch(() => {}); }
        await refreshDevices();
    }
    // Try audio+video; fall back to audio-only if no camera is available.
    async function getLocalStream() {
        try {
            return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch (e) {
            if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError' || e.name === 'NotReadableError') {
                setCallStatus('无摄像头，仅音频');
                return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            }
            throw e;
        }
    }

    // Flush ICE candidates that arrived before setRemoteDescription was called.
    async function flushPendingCandidates() {
        for (const cand of rtc.pendingCandidates) {
            try { await rtc.pc.addIceCandidate(cand); } catch (_) {}
        }
        rtc.pendingCandidates = [];
    }

    async function setupRtc(targetUid, isCaller) {
        rtc.targetUid = targetUid;
        rtc.isCaller = isCaller;
        rtc.callId = rtc.callId || genCallId();
        rtc.pendingCandidates = [];
        rtc.remoteDescSet = false;
        rtc.retryCount = 0;
        rtc.pc = new RTCPeerConnection({ iceServers: getIceServers() });
        setCallStatus('连接中…');
        rtc.localStream = await getLocalStream();
        rtc.localStream.getTracks().forEach((t) => rtc.pc.addTrack(t, rtc.localStream));
        refreshDevices();
        const localEl = $id('call-local');
        if (localEl) { localEl.srcObject = rtc.localStream; localEl.muted = true; localEl.play && localEl.play().catch(() => {}); }
        rtc.remoteStream = new MediaStream();
        const remoteEl = $id('call-remote');
        if (remoteEl) { remoteEl.srcObject = rtc.remoteStream; remoteEl.play && remoteEl.play().catch(() => {}); }
        rtc.pc.ontrack = (ev) => {
            const track = ev.track;
            // Add track to remote stream immediately so the element has a stream.
            if (!rtc.remoteStream.getTrackById(track.id)) {
                rtc.remoteStream.addTrack(track);
            }
            // Track starts muted (no data yet); play when it unmutes.
            track.onunmute = () => {
                const remoteEl = $id('call-remote');
                if (remoteEl) {
                    if (remoteEl.srcObject !== rtc.remoteStream) remoteEl.srcObject = rtc.remoteStream;
                    remoteEl.play && remoteEl.play().catch(() => {});
                }
            };
            // Also try to play immediately in case track is already unmuted.
            const remoteEl = $id('call-remote');
            if (remoteEl && remoteEl.srcObject !== rtc.remoteStream) remoteEl.srcObject = rtc.remoteStream;
            if (remoteEl && !track.muted) remoteEl.play && remoteEl.play().catch(() => {});
        };
        rtc.pc.onconnectionstatechange = () => {
            if (!rtc.pc) return;
            const s = rtc.pc.connectionState;
            if (s === 'connected') {
                setCallStatus('已连接');
                rtc.retryCount = 0;
                // Re-trigger play on remote element when fully connected.
                const remoteEl = $id('call-remote');
                if (remoteEl) {
                    remoteEl.srcObject = rtc.remoteStream;
                    remoteEl.muted = false;
                    remoteEl.volume = 1.0;
                    remoteEl.play && remoteEl.play().catch(() => {});
                }
            } else if (s === 'connecting') { setCallStatus('连接中…'); }
            else if (s === 'disconnected') { setCallStatus('连接断开，等待恢复…'); }
            else if (s === 'failed') {
                if (rtc.isCaller && rtc.retryCount < 2) {
                    rtc.retryCount++;
                    setCallStatus('重连中… (' + rtc.retryCount + '/2)');
                    rtc.pc.restartIce();
                    rtc.pc.createOffer({ iceRestart: true }).then((offer) => {
                        return rtc.pc.setLocalDescription(offer).then(() => {
                            fetch('/api/rtc_offer', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                                body: JSON.stringify({ from_uid: getMyUid(), to_uid: rtc.targetUid, sdp: offer.sdp, sdp_type: offer.type })
                            }).catch(() => {});
                        });
                    }).catch(() => setCallStatus('连接失败'));
                } else {
                    setCallStatus('连接失败');
                }
            }
        };
        rtc.pc.onicecandidate = (ev) => {
            if (!ev.candidate) return;
            fetch('/api/rtc_ice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({
                    from_uid: getMyUid(),
                    to_uid: targetUid,
                    call_id: rtc.callId,
                    candidate: ev.candidate.candidate,
                    sdpMid: ev.candidate.sdpMid || '',
                    sdpMLineIndex: ev.candidate.sdpMLineIndex || 0
                })
            }).catch(() => {});
        };
    }
    async function startCallOffer(targetUid) {
        rtc.callId = genCallId();
        await setupRtc(targetUid, true);
        const offer = await rtc.pc.createOffer();
        await rtc.pc.setLocalDescription(offer);
        fetch('/api/rtc_offer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
            body: JSON.stringify({ from_uid: getMyUid(), to_uid: targetUid, call_id: rtc.callId, sdp: offer.sdp, sdp_type: offer.type })
        }).catch(() => {});
    }
    function openCall() {
        const id = state.activeId;
        const c = state.contacts.find((x) => x.id === id);
        if (!c || !c.uid) return toast('请先选择一个联系人');
        if (rtc.pc || callState.incoming) return toast('已有通话进行中');
        const modal = $id('call-modal');
        if (!modal) return;
        $id('call-peer').textContent = `正在呼叫：${c.name}`;
        $id('call-title').textContent = '语音/视频通话';
        setCallStatus('连接中…');
        modal.setAttribute('data-open', 'true');
        runtime.callStart = Date.now();
        tickCall();
        window.clearInterval(runtime.callTimer);
        runtime.callTimer = window.setInterval(tickCall, 500);
        startCallOffer(Number(c.uid)).catch((e) => {
            const msg = (e && e.name === 'NotAllowedError') ? '需要麦克风/摄像头权限' : '无法建立通话';
            toast(msg);
            closeCall();
        });
    }
    function closeCall() {
        const modal = $id('call-modal');
        if (!modal) return;
        modal.setAttribute('data-open', 'false');
        setCallStatus('已结束');
        window.clearInterval(runtime.callTimer);
        runtime.callTimer = null;
        if (rtc.pc) rtc.pc.close();
        rtc.pc = null;
        if (rtc.localStream) rtc.localStream.getTracks().forEach((t) => t.stop());
        rtc.localStream = null;
        rtc.remoteStream = null;
        if (rtc.targetUid) {
            fetch('/api/rtc_hangup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({ from_uid: getMyUid(), to_uid: rtc.targetUid, call_id: rtc.callId })
            }).catch(() => {});
        }
        rtc.targetUid = 0;
        rtc.callId = '';
    }
    function resetIncoming() {
        callState.incoming = null;
        callState.pendingOffer = null;
        callState.callId = '';
        if (callState.pendingTimer) {
            window.clearTimeout(callState.pendingTimer);
            callState.pendingTimer = null;
        }
    }
    function closeIncomingModal() {
        $id('incoming-call-modal')?.setAttribute('data-open', 'false');
        resetIncoming();
    }
    async function acceptIncoming() {
        const offer = callState.pendingOffer;
        const fromUid = callState.incoming ? callState.incoming.uid : 0;
        if (!offer || !fromUid) return closeIncomingModal();
        rtc.callId = callState.callId || genCallId();
        closeIncomingModal();
        const modal = $id('call-modal');
        if (modal) {
            modal.setAttribute('data-open', 'true');
            runtime.callStart = Date.now();
            tickCall();
            window.clearInterval(runtime.callTimer);
            runtime.callTimer = window.setInterval(tickCall, 500);
            setCallStatus('连接中…');
        }
        try {
            await setupRtc(fromUid, false);
            await rtc.pc.setRemoteDescription(offer);
            rtc.remoteDescSet = true;
            await flushPendingCandidates();
            const answer = await rtc.pc.createAnswer();
            await rtc.pc.setLocalDescription(answer);
            fetch('/api/rtc_answer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({ from_uid: getMyUid(), to_uid: fromUid, call_id: rtc.callId, sdp: answer.sdp, sdp_type: answer.type })
            }).catch(() => {});
        } catch (e) {
            const msg = (e && e.name === 'NotAllowedError') ? '需要麦克风/摄像头权限' : '无法接通';
            toast(msg);
            closeCall();
        }
    }
    function rejectIncoming() {
        const fromUid = callState.incoming ? callState.incoming.uid : 0;
        closeIncomingModal();
        if (fromUid) {
            fetch('/api/rtc_hangup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                body: JSON.stringify({ from_uid: getMyUid(), to_uid: fromUid, call_id: callState.callId || rtc.callId, reason: 'rejected' })
            }).catch(() => {});
        }
    }
    $id('btn-call')?.addEventListener('click', openCall);
    $id('call-close')?.addEventListener('click', closeCall);
    $id('call-hangup')?.addEventListener('click', closeCall);
    $id('call-mute')?.addEventListener('click', () => {
        if (!rtc.localStream) return;
        const btn = $id('call-mute');
        const tracks = rtc.localStream.getAudioTracks();
        const nowMuted = tracks.length > 0 && tracks[0].enabled;
        tracks.forEach((t) => { t.enabled = !nowMuted; });
        if (btn) btn.classList.toggle('active', nowMuted);
    });
    $id('call-camera')?.addEventListener('click', () => {
        if (!rtc.localStream) return;
        const btn = $id('call-camera');
        const tracks = rtc.localStream.getVideoTracks();
        const nowVisible = tracks.length > 0 && tracks[0].enabled;
        tracks.forEach((t) => { t.enabled = !nowVisible; });
        if (btn) btn.classList.toggle('active', nowVisible);
    });
    $id('call-modal')?.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'call-modal') closeCall();
    });
    $id('incoming-call-close')?.addEventListener('click', rejectIncoming);
    $id('incoming-call-reject')?.addEventListener('click', rejectIncoming);
    $id('incoming-call-accept')?.addEventListener('click', acceptIncoming);
    $id('incoming-call-modal')?.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'incoming-call-modal') rejectIncoming();
    });
    $id('call-mic')?.addEventListener('change', (e) => {
        const micId = e.target.value || '';
        const camId = $id('call-cam')?.value || '';
        switchTracks(micId, camId).catch(() => toast('切换失败'));
    });
    $id('call-cam')?.addEventListener('change', (e) => {
        const camId = e.target.value || '';
        const micId = $id('call-mic')?.value || '';
        switchTracks(micId, camId).catch(() => toast('切换失败'));
    });

    // Context menu on message bubble
    const ctx = $id('ctx');
    function closeCtx() {
        if (!ctx) return;
        ctx.setAttribute('data-open', 'false');
        runtime.ctxMsgId = null;
    }
    function openCtx(x, y, msgId, canDelete) {
        if (!ctx) return;
        runtime.ctxMsgId = msgId;
        const del = $id('ctx-del');
        if (del) del.style.display = canDelete ? 'flex' : 'none';
        ctx.style.left = Math.max(10, Math.min(x, window.innerWidth - 220)) + 'px';
        ctx.style.top = Math.max(10, Math.min(y, window.innerHeight - 160)) + 'px';
        ctx.setAttribute('data-open', 'true');
    }

    $id('chat-body')?.addEventListener('contextmenu', (e) => {
        const bubble = e.target && e.target.closest ? e.target.closest('.bubble') : null;
        if (!bubble) return;
        e.preventDefault();
        const row = bubble.closest('.msg-row');
        const msgId = row ? String(row.getAttribute('data-msgid') || '') : '';
        if (!msgId) return;
        const id = state.activeId;
        const list = (id && state.threads[id]) ? state.threads[id] : [];
        const m = list.find((x) => String(x.id || '') === msgId);
        openCtx(e.clientX, e.clientY, msgId, !!(m && m.me));
    });

    $id('chat-body')?.addEventListener('scroll', () => {
        const body = $id('chat-body');
        runtimeView.autoScroll = isNearBottom(body, 28);
        updateChatBodyPadding();
    }, { passive: true });

    $id('ctx-copy')?.addEventListener('click', async () => {
        const id = state.activeId;
        const list = (id && state.threads[id]) ? state.threads[id] : [];
        const m = list.find((x) => String(x.id || '') === String(runtime.ctxMsgId || ''));
        const text = m ? String(m.text || '') : '';
        closeCtx();
        if (!text) return toast('无内容');
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
            else throw new Error('no clipboard');
            toast('已复制');
        } catch (_) {
            toast(text);
        }
    });

    $id('ctx-del')?.addEventListener('click', () => {
        const id = state.activeId;
        const list = (id && state.threads[id]) ? state.threads[id] : [];
        const idx = list.findIndex((x) => String(x.id || '') === String(runtime.ctxMsgId || ''));
        closeCtx();
        if (idx < 0) return;
        if (!confirm('删除这条消息？')) return;
        list.splice(idx, 1);
        state.threads[id] = list;
        renderThread();
        persist();
    });

    document.addEventListener('click', (e) => {
        if (ctx && ctx.getAttribute('data-open') === 'true') {
            if (!ctx.contains(e.target)) closeCtx();
        }
    });
}

function setMobileOpen(open) {
    const drawer = $id('drawer');
    if (drawer) drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.classList.toggle('sidebar-open', !!open);
    const side = $id('sidebar');
    if (side && isMobile()) {
        side.setAttribute('data-collapsed', open ? 'false' : 'true');
    }
}

function openDrawer() {
    setMobileOpen(true);
    syncCollapseIcon();
}
function closeDrawer() {
    setMobileOpen(false);
    syncCollapseIcon();
    const btn = $id('btn-drawer');
    if (btn) btn.focus();
}

function initMobileDrawer() {
    if (isMobile()) {
        const side = $id('sidebar');
        if (side) side.setAttribute('data-collapsed', 'true');
        setMobileOpen(false);
    }
    $id('btn-drawer')?.addEventListener('click', () => {
        if (document.body.classList.contains('sidebar-open')) closeDrawer();
        else openDrawer();
    });
    $id('drawer-backdrop')?.addEventListener('click', closeDrawer);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDrawer();
    });

    const onResize = rafThrottle(() => {
        if (!isMobile()) {
            const side = $id('sidebar');
            if (side) side.setAttribute('data-collapsed', state.collapsed ? 'true' : 'false');
            closeDrawer();
        }
        syncCollapseIcon();
    });
    window.addEventListener('resize', onResize);
}

// Boot
wire(document);
const initialActive = loadActiveId();
const initialContact = (initialActive && state.contacts.some((c) => c.id === initialActive))
    ? initialActive
    : (state.contacts[0] ? state.contacts[0].id : null);
state.activeId = initialContact;
state.settings = loadSettings();
hydrateFromStorage();

// Require login session (needed for polling + RTC signaling)
(function ensureLoggedIn() {
    const s = readJson(SESSION_KEY, null);
    const uid = (s && s.uid !== undefined && s.uid !== null) ? Number(s.uid) : 0;
    if (!uid) {
        toast('请先登录后再使用聊天/通话');
        window.setTimeout(() => {
            // Keep hash so login page opens on the login tab.
            window.location.href = 'login.html#login';
        }, 600);
    }
})();

setCollapsed(loadCollapsed());
scheduleRender();
renderFriendList();
bumpComposerHeight();
initMobileDrawer();
syncCollapseIcon();
updateSearchMeta();
syncTitle();

// Fetch TURN config if available
loadTurnConfig();

    // Session identity from login page (optional)
    try {
        const session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        const username = (session && (session.username || session.name)) ? String(session.username || session.name) : '';
        const uid = (session && (session.uid !== undefined && session.uid !== null)) ? String(session.uid) : '';

    const elName = $id('me-name');
    if (elName && username) elName.textContent = username;

        const profile = (() => {
            try { return JSON.parse(localStorage.getItem('qbe.profile') || 'null'); } catch (_) { return null; }
        })();
        const status = profile && profile.status ? String(profile.status) : '在线';
        const emo = profile && profile.status_emoji ? String(profile.status_emoji) : '🟢';

    const settings = loadSettings();
    const showUid = !(settings && (settings.privacy || settings.hide_uid));
    const showStatus = !(settings && settings.privacy);

        const elSub = qs('.me-sub', document);
        const statusLine = showStatus ? (status + ' ' + emo) : ('隐身 🕶️');
        if (elSub) {
            const idLine = (showUid && uid) ? ('UID ' + uid) : '';
            elSub.textContent = idLine ? (statusLine + ' · ' + idLine) : (statusLine + ' · QBE Connect');
        }

        // Persist and push my status to server
        const meUid = uid ? Number(uid) : 0;
        const localStatus = statusLine ? statusLine : status;
        writeJson(STATUS_KEY, { uid: meUid, status: localStatus });
        if (meUid) updateStatusRemote(meUid, localStatus);
    } catch (_) {}

// ---------------------------------------------------------------
// New-menu floating panel (+ button → Add contact / Create group)
// ---------------------------------------------------------------
(function () {
    const btnToggle = $id('btn-new-menu');
    const pop       = $id('new-menu-pop');
    const btnFriend = $id('nm-add-friend');
    const btnGroup  = $id('nm-create-group');

    function openPop() {
        if (!pop) return;
        pop.setAttribute('data-open', 'true');
        btnToggle && btnToggle.setAttribute('aria-expanded', 'true');
    }
    function closePop() {
        if (!pop) return;
        pop.setAttribute('data-open', 'false');
        btnToggle && btnToggle.setAttribute('aria-expanded', 'false');
    }
    function togglePop() {
        pop && pop.getAttribute('data-open') === 'true' ? closePop() : openPop();
    }

    btnToggle && btnToggle.addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });

    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!pop || pop.getAttribute('data-open') !== 'true') return;
        if (!pop.contains(e.target) && e.target !== btnToggle && !btnToggle.contains(e.target)) closePop();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });

    // ---- Add-friend sub-modal ----
    const afModal  = $id('add-friend-modal');
    const afInput  = $id('add-friend-uid');
    const afStatus = $id('add-friend-status');
    const afSend   = $id('add-friend-send');
    const afClose  = $id('add-friend-close');
    const afCancel = $id('add-friend-cancel');

        function openAfModal() {
            closePop();
            openAddFriendModal();
        }
    function closeAfModal() { afModal && afModal.setAttribute('data-open', 'false'); }

    function setNmStatus(el, msg, type) {
        if (!el) return;
        el.textContent = msg;
        el.className = 'nm-status' + (type ? ' ' + type : '');
    }

    btnFriend && btnFriend.addEventListener('click', openAfModal);
    afClose   && afClose.addEventListener('click', closeAfModal);
    afCancel  && afCancel.addEventListener('click', closeAfModal);
    afModal   && afModal.addEventListener('click', (e) => { if (e.target === afModal) closeAfModal(); });

    // Delegated click fallback for menu items (covers dynamic or missed bindings)
    document.addEventListener('click', (e) => {
        const addBtn = e.target && e.target.closest ? e.target.closest('#nm-add-friend') : null;
        const groupBtn = e.target && e.target.closest ? e.target.closest('#nm-create-group') : null;
        if (addBtn) {
            e.preventDefault();
            openAddFriendModal();
        } else if (groupBtn) {
            e.preventDefault();
            openCreateGroupModal();
        }
    });

    afSend && afSend.addEventListener('click', async () => {
        const toUid = parseInt(afInput.value, 10);
        if (!toUid || toUid <= 0) { setNmStatus(afStatus, '请输入有效的 UID', 'err'); return; }

        const session = readJson(SESSION_KEY, null);
        const fromUid  = session && session.uid ? Number(session.uid) : 0;
        const fromName = (session && (session.username || session.name)) ? String(session.username || session.name) : '未知';

        if (fromUid === toUid) { setNmStatus(afStatus, '不能添加自己', 'err'); return; }

        setNmStatus(afStatus, '发送中…', '');
        afSend.disabled = true;
        try {
            const payload = { from_uid: String(fromUid), to_uid: String(toUid), from_name: fromName };
            const res  = await fetch('/api/add_friend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const json = await res.json().catch(() => ({}));
            if (json.ok) {
                setNmStatus(afStatus, '✓ 请求已发送，等待对方同意', 'ok');
                window.setTimeout(closeAfModal, 1600);
            } else {
                setNmStatus(afStatus, '失败：' + (json.error || '未知错误'), 'err');
            }
        } catch (e) {
            setNmStatus(afStatus, '网络错误：' + String(e), 'err');
        } finally {
            afSend.disabled = false;
        }
    });
    afInput && afInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); afSend && afSend.click(); }
    });

    // ---- Create-group sub-modal ----
    const cgModal    = $id('create-group-modal');
    const cgNameIn   = $id('group-name-input');
    const cgUidIn    = $id('group-uid-input');
    const cgAddBtn   = $id('group-add-uid');
    const cgChips    = $id('group-member-chips');
    const cgStatus   = $id('create-group-status');
    const cgConfirm  = $id('create-group-confirm');
    const cgClose    = $id('create-group-close');
    const cgCancel   = $id('create-group-cancel');

    // cgMembers defined globally for modal helpers

    function renderChips() {
        if (!cgChips) return;
        if (!cgMembers.length) {
            cgChips.innerHTML = '<span class="muted-hint">暂无成员，请添加</span>';
            return;
        }
        cgChips.innerHTML = '';
        cgMembers.forEach((m, i) => {
            const chip = document.createElement('div');
            chip.className = 'member-chip';
            chip.innerHTML = `<i class="fa-solid fa-user u-chip-icon"></i>${escapeHtml(m.label)}<button type="button" title="移除" aria-label="移除"><i class="fa-solid fa-xmark u-chip-x"></i></button>`;
            chip.querySelector('button').addEventListener('click', () => {
                cgMembers.splice(i, 1);
                renderChips();
            });
            cgChips.appendChild(chip);
        });
    }

        function openCgModal() {
            closePop();
            openCreateGroupModal();
        }
    function closeCgModal() { cgModal && cgModal.setAttribute('data-open', 'false'); }

    btnGroup  && btnGroup.addEventListener('click', openCgModal);
    cgClose   && cgClose.addEventListener('click', closeCgModal);
    cgCancel  && cgCancel.addEventListener('click', closeCgModal);
    cgModal   && cgModal.addEventListener('click', (e) => { if (e.target === cgModal) closeCgModal(); });

    function addGroupMember() {
        const uid = parseInt(cgUidIn && cgUidIn.value, 10);
        if (!uid || uid <= 0) { setNmStatus(cgStatus, '请输入有效的成员 UID', 'err'); return; }
        if (!isFriend(uid)) { setNmStatus(cgStatus, '只能邀请好友加入群聊', 'err'); return; }
        if (cgMembers.some((m) => m.uid === uid)) { setNmStatus(cgStatus, 'UID ' + uid + ' 已在列表中', 'err'); return; }
        cgMembers.push({ uid, label: 'UID ' + uid });
        cgUidIn.value = '';
        setNmStatus(cgStatus, '', '');
        renderChips();
        cgUidIn.focus();
    }

    cgAddBtn && cgAddBtn.addEventListener('click', addGroupMember);
    cgUidIn  && cgUidIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addGroupMember(); }
    });

    cgConfirm && cgConfirm.addEventListener('click', () => {
        const groupName = (cgNameIn && cgNameIn.value || '').trim();
        if (!groupName) { setNmStatus(cgStatus, '请输入群聊名称', 'err'); cgNameIn && cgNameIn.focus(); return; }
        if (!cgMembers.length) { setNmStatus(cgStatus, '请至少添加一名成员', 'err'); return; }
        // Create group via server and broadcast to members
        const session = readJson(SESSION_KEY, null);
        const fromUid  = session && session.uid ? Number(session.uid) : 0;
        const fromName = (session && (session.username || session.name)) ? String(session.username || session.name) : '';
        const members = cgMembers.map((m) => m.uid);
        if (!fromUid) {
            setNmStatus(cgStatus, '登录后可创建群聊', 'err');
            return;
        }
        fetch('/api/create_group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from_uid: fromUid, group_name: groupName, members })
        }).then((r) => r.json()).then((j) => {
            if (j && j.ok && j.group_id) {
                // Local create to show immediately
                const contact = { id: String(j.group_id), uid: 0, name: groupName, online: true, unread: 0, last: '群聊已创建', time: '刚刚', seed: groupName.slice(0, 1).toUpperCase() };
                state.contacts.unshift(contact);
                if (!state.threads[contact.id]) state.threads[contact.id] = [];
                const map = readGroupMembers();
                map[contact.id] = members.slice();
                writeGroupMembers(map);
                persist();
                renderUserList(document);
                setActive(contact.id);
                setNmStatus(cgStatus, '✓ 群聊已创建', 'ok');
                window.setTimeout(closeCgModal, 800);
            } else {
                setNmStatus(cgStatus, '创建失败：' + ((j && j.error) || '未知错误'), 'err');
            }
        }).catch(() => {
            setNmStatus(cgStatus, '网络错误，稍后再试', 'err');
        });
    });
})();

// ---------------------------------------------------------------
// Add-friend modal — handled above in new-menu section
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// Incoming friend request + response modals
// Poll /api/poll_events for events (friend requests, responses, messages)
// ---------------------------------------------------------------
(function () {
    const reqModal  = $id('friend-req-modal');
    const reqText   = $id('friend-req-text');
    const btnAccept = $id('friend-req-accept');
    const btnReject = $id('friend-req-reject');
    const respModal = $id('friend-resp-modal');
    const respText  = $id('friend-resp-text');
    const btnRespOk = $id('friend-resp-ok');
    const btnRespClose = $id('friend-resp-close');

    let pendingReq = null;

    function openReqModal(req) {
        // Normalize request with explicit target uid
        const session = readJson(SESSION_KEY, null);
        const myUid = session && session.uid ? Number(session.uid) : 0;
        pendingReq = {
            from_uid: Number(req.from_uid || 0),
            from_name: req.from_name || '',
            to_uid: myUid
        };
        if (reqText) reqText.textContent = `UID ${req.from_uid}（${req.from_name || '未知'}）想添加你为联系人`;
        reqModal && reqModal.setAttribute('data-open', 'true');
    }
    function closeReqModal() { reqModal && reqModal.setAttribute('data-open', 'false'); pendingReq = null; }

    function openRespModal(msg) {
        if (respText) respText.textContent = msg;
        respModal && respModal.setAttribute('data-open', 'true');
    }
    function closeRespModal() { respModal && respModal.setAttribute('data-open', 'false'); }

    btnRespOk    && btnRespOk.addEventListener('click', closeRespModal);
    btnRespClose && btnRespClose.addEventListener('click', closeRespModal);

    async function sendFriendResponse(accept) {
        if (!pendingReq) return;
        const req = pendingReq;
        closeReqModal();
        try {
            const res = await fetch('/api/friend_response', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from_uid: req.from_uid, to_uid: req.to_uid, accept: (accept ? 'true' : 'false') })
            });
            const json = await res.json().catch(() => ({}));
            if (!json.ok) toast('回复失败：' + (json.error || ''));
        } catch (_) { toast('网络错误'); }

        if (accept) {
            addContact(req.from_name || ('UID ' + req.from_uid), req.from_uid);
            addFriend(req.from_uid, req.from_name);
        }
    }

    btnAccept && btnAccept.addEventListener('click', () => sendFriendResponse(true));
    btnReject && btnReject.addEventListener('click', () => sendFriendResponse(false));

    // Poll events
    let pollActive = true;
    async function pollEvents() {
        while (pollActive) {
            try {
                const myUid = (() => {
                    const s = readJson(SESSION_KEY, null);
                    return s && s.uid ? Number(s.uid) : 0;
                })();
                if (myUid) {
                    const res = await fetch('/api/poll_events', {
                        method: 'POST',
                        // ngrok free plan may inject a browser warning page; this header skips it.
                        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                        body: JSON.stringify({ uid: myUid })
                    });
                    if (res.ok) {
                        const json = await res.json().catch(() => ({}));
                        if (json.events && Array.isArray(json.events)) {
                            for (const ev of json.events) {
                                if (ev.type === 'friend_request') {
                                    const incomingUid = Number(ev.from_uid || 0);
                                    const already = incomingUid && state.friends && state.friends.some((f) => Number(f.uid) === incomingUid && !f.removed);
                                    if (already) {
                                        // Already friends: auto-ack and inform locally
                                        fetch('/api/friend_response', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ from_uid: ev.from_uid, to_uid: ev.to_uid, accept: 'true' })
                                        }).catch(() => {});
                                        openRespModal('已是好友，无需重复添加');
                                    } else {
                                        openReqModal(ev);
                                    }
                                } else if (ev.type === 'friend_response') {
                                    const key = String(ev.from_uid) + '->' + String(ev.to_uid) + ':' + String(ev.accept);
                                    const now = Date.now();
                                    const last = state.pendingRequests[key] || 0;
                                    if (now - last < 1500) continue;
                                    state.pendingRequests[key] = now;
                                    const peerUid = Number(ev.to_uid || 0);
                                    const alreadyFriend = peerUid && state.friends && state.friends.some((f) => Number(f.uid) === peerUid && !f.removed);
                                    const msg = ev.accept
                                        ? (alreadyFriend
                                            ? `UID ${ev.to_uid}（${ev.to_name || '对方'}）已是好友`
                                            : `UID ${ev.to_uid}（${ev.to_name || '对方'}）已同意你的好友请求`)
                                        : `UID ${ev.to_uid}（${ev.to_name || '对方'}）拒绝了你的好友请求`;
                                    openRespModal(msg);
                                    if (ev.accept) {
                                        addContact(ev.to_name || ('UID ' + ev.to_uid), ev.to_uid);
                                        addFriend(ev.to_uid, ev.to_name);
                                    }
                                } else if (ev.type === 'group_created') {
                                    const gid = String(ev.group_id || '');
                                    const gname = ev.group_name || '群聊';
                                    if (gid) {
                                        let contact = state.contacts.find((c) => c.id === gid);
                                        if (!contact) {
                                            contact = { id: gid, uid: 0, name: gname, online: true, unread: 0, last: '群聊已创建', time: '刚刚', seed: gname.slice(0, 1).toUpperCase() };
                                            state.contacts.unshift(contact);
                                        }
                                        if (!state.threads[gid]) state.threads[gid] = [];
                                        const members = Array.isArray(ev.members) ? ev.members.map((u) => Number(u) || 0).filter((u) => u) : [];
                                        const map = readGroupMembers();
                                        map[gid] = members;
                                        writeGroupMembers(map);
                                        persist();
                                        renderUserList(document);
                                        scheduleRender();
                                    }
                                } else if (ev.type === 'group_message') {
                                    const myUid = (() => {
                                        const s = readJson(SESSION_KEY, null);
                                        return s && s.uid ? Number(s.uid) : 0;
                                    })();
                                    if (myUid && Number(ev.from_uid) === myUid) continue;
                                    const gid = String(ev.group_id || '');
                                    if (!gid) continue;
                                    let contact = state.contacts.find((c) => c.id === gid);
                                    if (!contact) {
                                        const gname = ev.group_name || '群聊';
                                        contact = { id: gid, uid: 0, name: gname, online: true, unread: 0, last: '', time: '刚刚', seed: gname.slice(0, 1).toUpperCase() };
                                        state.contacts.unshift(contact);
                                        if (!state.threads[gid]) state.threads[gid] = [];
                                    }
                                    const now = new Date();
                                    const at = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
                                    state.threads[gid].push({ id: ev.msg_id || (String(Date.now()) + '-g'), me: false, text: ev.text || '', at });
                                    contact.last = ev.text || '';
                                    contact.time = at;
                                    if (state.activeId !== gid) contact.unread = (contact.unread || 0) + 1;
                                    persist();
                                    scheduleRender();
                                    maybeNotifyIncoming(contact, ev.text || '');
                                } else if (ev.type === 'rtc_offer') {
                                    const fromUid = Number(ev.from_uid || 0);
                                    if (fromUid) {
                                        const evCallId = ev.call_id ? String(ev.call_id) : '';
                                        // If we already have a pending incoming call, only replace it if the new call_id is newer.
                                        if (callState.incoming && callState.callId) {
                                            if (evCallId && evCallId !== callState.callId) {
                                                // New call attempt: silently replace the old pending offer (send no response).
                                            } else {
                                                // Same call_id duplicate: ignore.
                                                continue;
                                            }
                                        }
                                        if (rtc.pc) {
                                            fetch('/api/rtc_hangup', {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                                                body: JSON.stringify({ from_uid: getMyUid(), to_uid: fromUid })
                                            }).catch(() => {});
                                        }
                                        const c = state.contacts.find((x) => Number(x.uid) === fromUid);
                                        callState.incoming = { uid: fromUid, name: c ? c.name : ('UID ' + fromUid) };
                                        callState.callId = evCallId;
                                        callState.pendingOffer = new RTCSessionDescription({ type: ev.sdp_type || 'offer', sdp: ev.sdp || '' });
                                        $id('incoming-call-name').textContent = callState.incoming.name;
                                        $id('incoming-call-title').textContent = '来电';
                                        $id('incoming-call-modal')?.setAttribute('data-open', 'true');
                                        if (callState.pendingTimer) window.clearTimeout(callState.pendingTimer);
                                        callState.pendingTimer = window.setTimeout(() => {
                                            if (callState.incoming) rejectIncoming();
                                        }, 30000);
                                    }
                                } else if (ev.type === 'rtc_answer') {
                                    if (rtc.pc && ev.sdp) {
                                        if (ev.call_id && rtc.callId && String(ev.call_id) !== String(rtc.callId)) continue;
                                        const ans = new RTCSessionDescription({ type: ev.sdp_type || 'answer', sdp: ev.sdp || '' });
                                        rtc.pc.setRemoteDescription(ans).then(() => {
                                            rtc.remoteDescSet = true;
                                            return flushPendingCandidates();
                                        }).catch((e) => console.error('rtc_answer err', e));
                                        refreshDevices();
                                    }
                                } else if (ev.type === 'rtc_ice') {
                                    if (rtc.pc && ev.candidate) {
                                        if (ev.call_id && rtc.callId && String(ev.call_id) !== String(rtc.callId)) continue;
                                        const cand = new RTCIceCandidate({
                                            candidate: ev.candidate || '',
                                            sdpMid: ev.sdpMid || '',
                                            sdpMLineIndex: Number(ev.sdpMLineIndex) || 0
                                        });
                                        if (rtc.remoteDescSet) {
                                            rtc.pc.addIceCandidate(cand).catch((e) => console.error('rtc_ice err', e));
                                        } else {
                                            rtc.pendingCandidates.push(cand);
                                        }
                                    }
                                } else if (ev.type === 'rtc_hangup') {
                                    if (ev.call_id && rtc.callId && String(ev.call_id) !== String(rtc.callId)) continue;
                                    const wasIncoming = !!callState.incoming;
                                    closeCall();
                                    closeIncomingModal();
                                    if (wasIncoming || ev.reason === 'rejected') toast('对方已拒绝接听');
                                    else toast('对方已挂断');
                                } else if (ev.type === 'friend_removed') {
                                    const targetUid = ev.from_uid;
                                    const contact = state.contacts.find((c) => String(c.uid) === String(targetUid));
                                    if (contact) {
                                        contact.removed = true;
                                        contact.unread = 0;
                                        persist();
                                        scheduleRender();
                                    }
                                    removeFriend(targetUid);
                                } else if (ev.type === 'message') {
                                    // Incoming message from another client via server relay
                                    const fromUid  = ev.from_uid;
                                    const fromName = ev.from_name || ('UID ' + fromUid);
                                    const text     = ev.text || '';
                                    const msgId    = ev.msg_id || (String(Date.now()) + '-r');

                                    // Find or create contact by uid
                                    let contact = state.contacts.find((c) => String(c.uid) === String(fromUid));
                                    if (!contact) {
                                        // Auto-create if not found
                                        const cid = createContactId(fromName);
                                        contact = { id: cid, uid: fromUid, name: fromName, online: true, unread: 0, last: '', time: '刚刚', seed: fromName.slice(0, 1).toUpperCase() };
                                        state.contacts.unshift(contact);
                                        if (!state.threads[cid]) state.threads[cid] = [];
                                    }

                                    // Refresh status from server when message arrives
                                    fetch('/api/get_user', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ uid: String(fromUid) })
                                    }).then((r) => r.json()).then((j) => {
                                        if (j && j.ok && contact) {
                                            contact.status = j.status || contact.status;
                                            persist();
                                            renderThread();
                                        }
                                    }).catch(() => {});

                                    const now = new Date();
                                    const at  = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
                                    state.threads[contact.id].push({ id: msgId, me: false, text, at });
                                    contact.last = text;
                                    contact.time = at;

                                    if (state.activeId !== contact.id) {
                                        contact.unread = (contact.unread || 0) + 1;
                                        syncTitle();
                                        playPing();
                                        maybeNotifyIncoming(contact, text);
                                    }

                                    scheduleRender();
                                    persist();
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Network error (e.g. ngrok idle timeout): retry after short delay.
                if (e.name === 'TypeError') {
                    await new Promise((r) => window.setTimeout(r, 200));
                    continue;
                }
            }
            // Faster polling improves RTC signaling over unstable tunnels.
            await new Promise((r) => window.setTimeout(r, 1000));
        }
    }
    pollEvents();
    window.addEventListener('beforeunload', () => { pollActive = false; });
})();
