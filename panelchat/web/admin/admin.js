// Panelchat admin console. Single-page vanilla JS.

(() => {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const loginPane = $('#login-pane');
    const appPane = $('#app-pane');
    const logoutBtn = $('#logout-btn');
    const statePill = $('#state-pill');
    const activeLabel = $('#active-session-label');
    const audioStatus = $('#audio-status');
    const devAudioSelect = $('#dev-audio-file');
    const profileCards = $('#profile-cards');
    const deliberationCapDisplay = $('#deliberation-cap-display');
    const sessionsList = $('#sessions-list');
    const adminFeed = $('#admin-feed');
    const probeCharacterSelect = $('#probe-character');
    const probeResult = $('#probe-result');
    const transcriptLive = $('#transcript-live');
    const transcriptHistory = $('#transcript-history');
    const audienceToggle = $('#audience-toggle');
    const audienceMeta = $('#audience-meta');
    const audienceQueueEl = $('#audience-queue');

    let liveDeltaBuf = '';
    const renderLive = () => {
        if (!liveDeltaBuf) {
            transcriptLive.innerHTML = '<span class="placeholder">awaiting audio…</span>';
            return;
        }
        transcriptLive.textContent = liveDeltaBuf;
    };
    const pushTranscriptSegment = ({ text, at, source }) => {
        transcriptHistory.querySelector('.transcript-history-empty')?.remove();
        const div = document.createElement('div');
        div.className = 'seg' + (source === 'injected' ? ' injected' : '');
        const ts = at ? new Date(at).toLocaleTimeString([], { hour12: false }) : '';
        div.innerHTML = `<div class="ts">${escape(ts)}</div><div class="text">${escape(text)}</div>`;
        transcriptHistory.appendChild(div);
        while (transcriptHistory.children.length > 100) transcriptHistory.firstElementChild?.remove();
    };
    const refreshAudienceQueue = async () => {
        try {
            const data = await api('/admin/audience-queue');
            audienceToggle.checked = !!data.enabled;
            audienceMeta.textContent = data.enabled
                ? `Enabled · ${data.items.length} in queue`
                : `Disabled · ${data.items.length} in queue (frozen)`;
            audienceQueueEl.innerHTML = '';
            if (!data.items.length) {
                const empty = document.createElement('div');
                empty.className = 'audience-queue-empty';
                empty.textContent = 'No questions waiting.';
                audienceQueueEl.appendChild(empty);
                return;
            }
            for (const item of data.items) {
                const row = document.createElement('div');
                row.className = 'item';
                const ts = item.queuedAtMs ? new Date(item.queuedAtMs).toLocaleTimeString([], { hour12: false }) : '';
                row.innerHTML = `
                    <div class="ts">${escape(ts)}<br/><span style="opacity:0.7">${escape(item.ipMask || '')}</span></div>
                    <div class="q">${escape(item.question)}</div>
                    <button class="ghost small" data-dismiss="${escape(item.id)}">Dismiss</button>
                `;
                audienceQueueEl.appendChild(row);
            }
            audienceQueueEl.querySelectorAll('[data-dismiss]').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    await api(`/admin/audience-queue/dismiss/${encodeURIComponent(btn.dataset.dismiss)}`, { method: 'POST' });
                    refreshAudienceQueue();
                });
            });
        } catch (err) {
            audienceMeta.textContent = `error: ${err.message}`;
        }
    };

    const resetTranscriptUI = () => {
        liveDeltaBuf = '';
        renderLive();
        transcriptHistory.innerHTML = '<div class="transcript-history-empty">No transcript yet.</div>';
    };

    let state = { state: 'idle', profiles: [], settings: {}, posts: [], session: null };
    let recentPostsCache = [];
    let micCtx = null;
    let micStream = null;
    let micWs = null;

    const api = async (path, opts = {}) => {
        const res = await fetch(`/panelchat-api${path}`, {
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
            ...opts,
        });
        if (!res.ok) {
            const msg = await safeText(res);
            throw new Error(`${res.status} ${msg}`);
        }
        return res.json();
    };
    const safeText = async (r) => {
        try { const j = await r.json(); return j.error || JSON.stringify(j); }
        catch { return r.statusText; }
    };

    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Brief visual confirmation next to the save trigger. `anchor` is the
    // button (or form) that was just submitted. Inserts/updates a small
    // .save-status badge after the anchor, then clears it after ~2s. ok=false
    // surfaces the error message in red instead of the green "Saved" pill.
    const flashSaved = (anchor, { ok = true, message } = {}) => {
        if (!anchor) return;
        // For form submits, anchor to the form's submit button if present.
        const target = anchor.tagName === 'FORM'
            ? anchor.querySelector('button[type="submit"]') || anchor
            : anchor;
        let badge = target.parentNode?.querySelector(':scope > .save-status');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'save-status';
            target.insertAdjacentElement('afterend', badge);
        }
        badge.classList.toggle('err', !ok);
        badge.textContent = ok ? '✓ Saved' : `✗ ${message || 'Save failed'}`;
        badge.dataset.shownAt = String(Date.now());
        clearTimeout(badge._fadeT);
        badge._fadeT = setTimeout(() => {
            if (badge.dataset.shownAt && Date.now() - Number(badge.dataset.shownAt) >= 1900) {
                badge.remove();
            }
        }, 2000);
    };

    // Safe markdown-link renderer for the admin live feed. Same allowlist
    // as the visitor: only [text](http(s)://...) is rendered as a link;
    // everything else stays as plain text.
    const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const renderTextWithLinksInto = (text, container) => {
        const s = String(text || '');
        let lastIdx = 0;
        let m;
        LINK_RE.lastIndex = 0;
        while ((m = LINK_RE.exec(s)) !== null) {
            if (m.index > lastIdx) {
                container.appendChild(document.createTextNode(s.slice(lastIdx, m.index)));
            }
            const a = document.createElement('a');
            a.href = m[2];
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = m[1];
            container.appendChild(a);
            lastIdx = m.index + m[0].length;
        }
        if (lastIdx < s.length) {
            container.appendChild(document.createTextNode(s.slice(lastIdx)));
        }
    };

    const setState = (next) => {
        state.state = next;
        statePill.textContent = next;
        statePill.className = `pill ${next}`;
        applyLifecycleButtonStates(next);
    };

    // Toggle the lifecycle action buttons (Start/Pause/Resume/Restart/End/Podcast)
    // based on the current state, so the operator can't click something that
    // would just 400. Ended sessions are terminal — every lifecycle button
    // is disabled and a notice appears beside them pointing at New Session.
    const applyLifecycleButtonStates = (s) => {
        const map = {
            start: s === 'idle',
            pause: s === 'running' || s === 'opening' || s === 'question',
            resume: s === 'paused',
            restart: s !== 'ended',
            end: s !== 'ended',
        };
        for (const [action, enabled] of Object.entries(map)) {
            const btn = document.querySelector(`button[data-action="${action}"]`);
            if (btn) btn.disabled = !enabled;
        }
        const notice = document.getElementById('state-ended-notice');
        if (notice) notice.hidden = s !== 'ended';
    };

    const setActiveLabel = (session) => {
        if (!session) { activeLabel.textContent = '—'; return; }
        activeLabel.textContent = `${session.label || session.id}${session.kind ? ' · ' + session.kind : ''}`;
        const dl = document.getElementById('active-transcript-dl');
        if (dl) dl.href = `/panelchat-api/admin/transcript${session.id ? `?sessionId=${encodeURIComponent(session.id)}` : ''}`;
    };

    // ---------- Sessions ----------

    const refreshSessions = async () => {
        try {
            const { sessions, activeId } = await api('/admin/sessions');
            renderSessions(sessions, activeId);
        } catch (err) {
            sessionsList.innerHTML = `<div class="err">${err.message}</div>`;
        }
    };

    const renderSessions = (sessions, activeId) => {
        sessionsList.innerHTML = '';
        if (!sessions.length) {
            sessionsList.innerHTML = '<div class="hint">No sessions yet.</div>';
            return;
        }
        for (const s of sessions) {
            const row = document.createElement('div');
            row.className = 'session-row' + (s.id === activeId ? ' active' : '');
            const created = s.createdAtMs ? new Date(s.createdAtMs).toLocaleString() : '—';
            const ended = s.endedAtMs ? new Date(s.endedAtMs).toLocaleString() : '';
            row.innerHTML = `
                <div>
                  <div class="label">${escape(s.label || s.id)}</div>
                  <div class="meta">id=${escape(s.id)} · created ${escape(created)}${ended ? ' · ended ' + escape(ended) : ''}</div>
                </div>
                <div class="pills">
                  <span class="pill ${escape(s.kind)}">${escape(s.kind)}</span>
                  <span class="pill ${escape(s.state)}">${escape(s.state)}</span>
                  ${s.id === activeId ? '<span class="pill running">active</span>' : ''}
                </div>
                <div class="row-actions">
                  ${s.id !== activeId ? `<button class="small ghost" data-activate="${escape(s.id)}">Activate</button>` : ''}
                  <a class="small ghost" target="_blank" href="/panelchat/sessions/${encodeURIComponent(s.id)}/" style="display:inline-block;padding:5px 8px;text-decoration:none;border:1px solid #111;color:#111;background:#fff;border-radius:8px;font-size:12px;">Open</a>
                  <a class="small ghost" target="_blank" rel="noopener" download href="/panelchat-api/admin/transcript?sessionId=${encodeURIComponent(s.id)}" style="display:inline-block;padding:5px 8px;text-decoration:none;border:1px solid #111;color:#111;background:#fff;border-radius:8px;font-size:12px;">Transcript</a>
                  <button class="small ghost" data-podcast="${escape(s.id)}" data-podcast-label="${escape(s.label || s.id)}">Podcast</button>
                  ${s.state !== 'ended' ? `<button class="small danger" data-end="${escape(s.id)}">End</button>` : ''}
                  ${s.id !== activeId ? `<button class="small danger" data-delete="${escape(s.id)}" data-delete-label="${escape(s.label || s.id)}" title="Permanently delete this session and all its data">Delete</button>` : '<span class="small hint" title="Activate another session first">Delete</span>'}
                </div>
            `;
            sessionsList.appendChild(row);
        }
        sessionsList.querySelectorAll('[data-activate]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                try {
                    await api(`/admin/sessions/${encodeURIComponent(btn.dataset.activate)}/activate`, { method: 'POST' });
                    await loadAll();
                } catch (err) { alert(err.message); }
            });
        });
        sessionsList.querySelectorAll('[data-end]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!confirm('End this session? Ended sessions are terminal.')) return;
                try {
                    await api(`/admin/sessions/${encodeURIComponent(btn.dataset.end)}/end`, { method: 'POST' });
                    await refreshSessions();
                    if (btn.dataset.end === state.session?.id) await loadAll();
                } catch (err) { alert(err.message); }
            });
        });
        sessionsList.querySelectorAll('[data-podcast]').forEach((btn) => {
            btn.addEventListener('click', () => {
                openPodcastModal({
                    sessionId: btn.dataset.podcast,
                    sessionLabel: btn.dataset.podcastLabel || btn.dataset.podcast,
                });
            });
        });
        sessionsList.querySelectorAll('[data-delete]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.delete;
                const label = btn.dataset.deleteLabel || id;
                const msg =
                    `Permanently delete "${label}"?\n\n` +
                    `This wipes the session and all its posts, transcript, log, ` +
                    `character profiles, and podcasts. The session itself is removed ` +
                    `from Firestore. Cannot be undone.`;
                if (!confirm(msg)) return;
                btn.disabled = true;
                btn.textContent = 'deleting…';
                try {
                    await api(`/admin/sessions/${encodeURIComponent(id)}/delete`, { method: 'POST' });
                    await refreshSessions();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                    btn.textContent = 'Delete';
                }
            });
        });
    };

    // ---------- Podcast modal ----------

    const podcastModal = document.getElementById('podcast-modal');
    const podcastSubtitle = document.getElementById('podcast-modal-subtitle');
    const podcastCreateForm = document.getElementById('podcast-create-form');
    const podcastCreateFeedback = document.getElementById('podcast-create-feedback');
    const podcastListEl = document.getElementById('podcast-list');

    let podcastModalSession = null;
    let podcastPollHandle = null;

    const openPodcastModal = ({ sessionId, sessionLabel }) => {
        podcastModalSession = { id: sessionId, label: sessionLabel };
        podcastSubtitle.textContent = `${sessionLabel} · session id ${sessionId}`;
        podcastCreateForm.reset();
        podcastCreateForm.elements['title'].value = `${sessionLabel} — podcast`;
        podcastCreateForm.elements['length'].value = 'SHORT';
        podcastCreateFeedback.textContent = '';
        podcastCreateFeedback.className = 'hint';
        podcastModal.hidden = false;
        refreshPodcastList();
        startPodcastPoll();
    };

    const closePodcastModal = () => {
        podcastModal.hidden = true;
        podcastModalSession = null;
        stopPodcastPoll();
    };

    const startPodcastPoll = () => {
        stopPodcastPoll();
        podcastPollHandle = setInterval(() => {
            if (!podcastModalSession) return stopPodcastPoll();
            const hasPending = podcastListEl.querySelector('[data-status="generating"], [data-status="queued"]');
            if (hasPending) refreshPodcastList();
        }, 15000);
    };

    const stopPodcastPoll = () => {
        if (podcastPollHandle) { clearInterval(podcastPollHandle); podcastPollHandle = null; }
    };

    const refreshPodcastList = async () => {
        if (!podcastModalSession) return;
        const { id: sessionId } = podcastModalSession;
        try {
            const { podcasts } = await api(`/admin/podcasts?sessionId=${encodeURIComponent(sessionId)}`);
            const pending = (podcasts || []).filter((p) => p.status === 'generating' || p.status === 'queued');
            for (const p of pending) {
                try {
                    const { podcast } = await api(`/admin/podcasts/${encodeURIComponent(p.id)}/refresh?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' });
                    Object.assign(p, podcast);
                } catch {}
            }
            renderPodcastList(podcasts || []);
        } catch (err) {
            podcastListEl.innerHTML = `<div class="err">${escape(err.message)}</div>`;
        }
    };

    const renderPodcastList = (podcasts) => {
        podcastListEl.innerHTML = '';
        if (!podcasts.length) {
            podcastListEl.innerHTML = '<div class="hint">none yet.</div>';
            return;
        }
        for (const p of podcasts) {
            const created = p.createdAtMs ? new Date(p.createdAtMs).toLocaleString() : '—';
            const lengthLabel = p.length === 'STANDARD' ? 'Standard ~10 min' : 'Short 4–5 min';
            const includesChat = p.includeBotPosts ? ' · incl. bot chat' : '';
            const errBlock = p.errorMessage ? `<div class="err">${escape(p.errorMessage)}</div>` : '';
            const downloadBtn = p.status === 'ready'
                ? `<a class="small ghost" target="_blank" rel="noopener" download href="/panelchat-api/admin/podcasts/${encodeURIComponent(p.id)}/audio?sessionId=${encodeURIComponent(podcastModalSession.id)}" style="display:inline-block;padding:5px 8px;text-decoration:none;border:1px solid #111;color:#111;background:#fff;border-radius:8px;font-size:12px;">Download MP3</a>`
                : '';
            const refreshBtn = (p.status === 'generating' || p.status === 'queued')
                ? `<button class="small ghost" data-refresh="${escape(p.id)}">Refresh</button>`
                : '';
            const row = document.createElement('div');
            row.className = 'podcast-row';
            row.dataset.status = p.status;
            row.innerHTML = `
                <div>
                  <div class="pri">${escape(p.title || '(untitled)')}</div>
                  <div class="meta">${escape(lengthLabel)}${escape(includesChat)} · ${escape(created)}</div>
                  ${p.focus ? `<div class="meta">focus: ${escape(p.focus)}</div>` : ''}
                  ${errBlock}
                </div>
                <div class="row-actions">
                  <span class="pill ${escape(p.status)}">${escape(p.status)}</span>
                  ${refreshBtn}
                  ${downloadBtn}
                </div>
            `;
            podcastListEl.appendChild(row);
        }
        podcastListEl.querySelectorAll('[data-refresh]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'refreshing…';
                try {
                    await api(`/admin/podcasts/${encodeURIComponent(btn.dataset.refresh)}/refresh?sessionId=${encodeURIComponent(podcastModalSession.id)}`, { method: 'POST' });
                    await refreshPodcastList();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                    btn.textContent = 'Refresh';
                }
            });
        });
    };

    podcastModal.addEventListener('click', (e) => {
        if (e.target.matches('[data-modal-close]')) closePodcastModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !podcastModal.hidden) closePodcastModal();
    });

    document.getElementById('active-podcast-btn')?.addEventListener('click', () => {
        const sess = state?.session;
        if (!sess) return alert('No active session.');
        openPodcastModal({ sessionId: sess.id, sessionLabel: sess.label || sess.id });
    });

    podcastCreateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!podcastModalSession) return;
        const fd = new FormData(podcastCreateForm);
        const payload = {
            sessionId: podcastModalSession.id,
            title: (fd.get('title') || '').toString().trim(),
            description: (fd.get('description') || '').toString().trim(),
            focus: (fd.get('focus') || '').toString().trim(),
            length: fd.get('length') === 'STANDARD' ? 'STANDARD' : 'SHORT',
            includeBotPosts: !!fd.get('includeBotPosts'),
        };
        const submitBtn = podcastCreateForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        podcastCreateFeedback.textContent = 'kicking off…';
        podcastCreateFeedback.className = 'hint';
        try {
            await api('/admin/podcasts', { method: 'POST', body: JSON.stringify(payload) });
            podcastCreateFeedback.textContent = 'queued — generation can take a few minutes.';
            podcastCreateFeedback.className = 'hint';
            podcastCreateForm.elements['focus'].value = '';
            await refreshPodcastList();
        } catch (err) {
            podcastCreateFeedback.textContent = err.message;
            podcastCreateFeedback.className = 'hint err';
        } finally {
            submitBtn.disabled = false;
        }
    });

    // ---------- Audio ----------

    const refreshAudio = async () => {
        try {
            const { status, devFiles } = await api('/admin/audio');
            audioStatus.textContent = status.mode
                ? `${status.mode} · listeners ${status.liveListeners}`
                : 'inactive';
            devAudioSelect.innerHTML = '';
            for (const f of devFiles) {
                const opt = document.createElement('option');
                opt.value = f.filename;
                opt.textContent = f.supported ? f.filename : `${f.filename} (WAV only for now)`;
                if (!f.supported) opt.disabled = true;
                devAudioSelect.appendChild(opt);
            }
            if (!devFiles.length) {
                const opt = document.createElement('option');
                opt.textContent = '(drop a .wav into dev-audio/)';
                opt.disabled = true;
                devAudioSelect.appendChild(opt);
            }
        } catch (err) {
            audioStatus.textContent = `error: ${err.message}`;
        }
    };

    // ---------- Profiles ----------

    const renderProfile = (p) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = p.id;
        const av = p.avatarUrl ? `<div class="avatar"><img src="${escape(p.avatarUrl)}" alt="" /></div>` : '<div class="avatar"></div>';
        const searchPill = p.webResearchEnabled
            ? '<span class="pill ready" title="Web research enabled — this bot can search and cite sources">search on</span>'
            : '<span class="pill" title="Web research disabled — this bot writes from training data only">search off</span>';
        card.innerHTML = `
            <h3>${av}<span>${escape(p.displayName)}${p.nickname ? ` <span style="color:#888;font-weight:400">“${escape(p.nickname)}”</span>` : ''}</span> <span class="pill">${escape(p.modelLabel || p.model)}</span> ${searchPill}</h3>
            <div class="grid">
              <label>Display name<input data-field="displayName" value="${escape(p.displayName)}" /></label>
              <label>Nickname<input data-field="nickname" value="${escape(p.nickname || '')}" /></label>
              <label>Provider
                <select data-field="provider">
                  <option value="anthropic"${p.provider === 'anthropic' ? ' selected' : ''}>anthropic</option>
                  <option value="openai"${p.provider === 'openai' ? ' selected' : ''}>openai</option>
                  <option value="gemini"${p.provider === 'gemini' ? ' selected' : ''}>gemini</option>
                </select>
              </label>
              <label>Model<input data-field="model" value="${escape(p.model || '')}" placeholder="e.g. claude-haiku-4-5-20251001" /></label>
              <label>Model label<input data-field="modelLabel" value="${escape(p.modelLabel || '')}" /></label>
              <label>Max post chars<input type="number" data-field="maxPostChars" value="${p.maxPostChars}" /></label>
              <label>Response delay (seconds)<input type="number" step="0.5" min="0" data-field="responseDelayMs" data-unit="seconds" value="${((p.responseDelayMs || 0) / 1000)}" /></label>
              <label class="inline-check wide">
                <input type="checkbox" data-field="webResearchEnabled" data-bool="true" ${p.webResearchEnabled ? 'checked' : ''} />
                <span>Web research enabled<br/><span class="hint inline">When on, this bot can use its provider's native web-search tool and cite sources as <code>[title](url)</code>. Bump max post chars if you expect citations — URLs eat ~80 chars.</span></span>
              </label>
              <label class="wide">Avatar URL<input data-field="avatarUrl" value="${escape(p.avatarUrl || '')}" /></label>
              <label class="wide">Model badge URL<input data-field="modelBadgeUrl" value="${escape(p.modelBadgeUrl || '')}" /></label>
              <label class="wide">System prompt<textarea data-field="systemPrompt">${escape(p.systemPrompt || '')}</textarea></label>
              <label class="wide">Trigger keywords (comma-separated)<input data-field="triggers.keywords" value="${escape((p.triggers?.keywords || []).join(', '))}" /></label>
              <label>Trigger threshold<input type="number" step="0.05" data-field="triggers.threshold" value="${p.triggers?.threshold ?? 1.0}" /></label>
              <label>Weight: keyword<input type="number" step="0.05" data-field="triggers.weights.keyword" value="${p.triggers?.weights?.keyword ?? 1}" /></label>
              <label>Weight: recency<input type="number" step="0.05" data-field="triggers.weights.recency" value="${p.triggers?.weights?.recency ?? 0.4}" /></label>
              <label>Weight: randomness<input type="number" step="0.05" data-field="triggers.weights.randomness" value="${p.triggers?.weights?.randomness ?? 0.15}" /></label>
            </div>
            <div class="row">
              <button data-save>Save ${escape(p.displayName)}</button>
              <span class="hint" data-feedback></span>
            </div>
        `;
        card.querySelector('[data-save]').addEventListener('click', () => saveProfile(card, p.id));
        return card;
    };

    const saveProfile = async (card, id) => {
        const patch = {};
        for (const el of card.querySelectorAll('[data-field]')) {
            const field = el.dataset.field;
            let val;
            if (el.type === 'checkbox') {
                val = !!el.checked;
            } else {
                val = el.value;
                if (el.type === 'number') val = Number(val);
                if (el.dataset.unit === 'seconds') val = Math.round(Number(val) * 1000);
                if (field === 'triggers.keywords') val = val.split(',').map((s) => s.trim()).filter(Boolean);
            }
            setDotted(patch, field, val);
        }
        const fb = card.querySelector('[data-feedback]');
        fb.textContent = 'saving…';
        try {
            await api(`/admin/profiles/${id}`, { method: 'POST', body: JSON.stringify(patch) });
            fb.textContent = 'saved';
            setTimeout(() => (fb.textContent = ''), 1800);
        } catch (err) {
            fb.textContent = err.message;
        }
    };

    const setDotted = (obj, path, value) => {
        const parts = path.split('.');
        let cur = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            cur[parts[i]] = cur[parts[i]] || {};
            cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
    };

    const renderProfiles = (profiles) => {
        profileCards.innerHTML = '';
        for (const p of profiles) profileCards.appendChild(renderProfile(p));
        probeCharacterSelect.innerHTML = '';
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.displayName} (${p.modelLabel || p.model})`;
            probeCharacterSelect.appendChild(opt);
        }
    };

    const renderSettings = (settings) => {
        for (const [k, v] of Object.entries(settings)) {
            for (const el of document.querySelectorAll(`form input[name="${k}"]`)) {
                el.value = el.dataset.unit === 'seconds' ? v / 1000 : v;
            }
        }
        deliberationCapDisplay.textContent = settings.deliberationCap;
        $('#feed-cadence-hint').textContent =
            `≤ ${settings.targetPostsPerMinute}/min · cooldowns global=${(settings.globalCooldownMs / 1000).toFixed(1)}s / per-char=${(settings.perCharacterCooldownMs / 1000).toFixed(1)}s`;
    };

    // ---------- Admin feed ----------

    const renderAdminFeed = (posts) => {
        adminFeed.innerHTML = '';
        if (!posts.length) {
            const empty = document.createElement('div');
            empty.className = 'admin-feed-empty';
            empty.textContent = 'No posts yet.';
            adminFeed.appendChild(empty);
            return;
        }
        const shown = posts.slice(-20);
        for (const p of shown) adminFeed.appendChild(adminPostEl(p));
    };

    const appendAdminPost = (post) => {
        adminFeed.querySelector('.admin-feed-empty')?.remove();
        const el = adminPostEl(post);
        adminFeed.appendChild(el);
        while (adminFeed.children.length > 20) adminFeed.firstElementChild?.remove();
    };

    const adminPostEl = (post) => {
        const wrap = document.createElement('div');
        wrap.className = 'admin-post';
        const av = post.avatarUrl
            ? `<div class="avatar"><img src="${escape(post.avatarUrl)}" alt=""></div>`
            : `<div class="avatar empty">${escape((post.displayName || '?').slice(0, 1).toUpperCase())}</div>`;
        const latency = typeof post.genMs === 'number'
            ? `<span class="latency">${Math.round(post.genMs)} ms</span>`
            : '';
        const kindTag = post.kind && post.kind !== 'live'
            ? `<span class="kind-tag">${escape(post.kind)}</span>`
            : '';
        wrap.innerHTML = `
            ${av}
            <div>
              <div class="row1">
                <span class="name">${escape(post.displayName)}</span>
                ${post.nickname ? `<span class="nick">“${escape(post.nickname)}”</span>` : ''}
                ${kindTag}
                ${latency}
              </div>
              <div class="text"></div>
            </div>
        `;
        // Render the post body separately so [text](url) markdown links
        // become safe <a> elements without us doing innerHTML on user data.
        renderTextWithLinksInto(post.body, wrap.querySelector('.text'));
        return wrap;
    };

    // ---------- Live mic ----------

    const startMic = async () => {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
        } catch (err) {
            alert('Mic access denied: ' + err.message);
            return;
        }
        micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        await micCtx.audioWorklet.addModule('/panelchat/admin/pcm-worklet.js');
        const source = micCtx.createMediaStreamSource(micStream);
        const node = new AudioWorkletNode(micCtx, 'pcm-worklet');

        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        micWs = new WebSocket(`${wsProto}//${location.host}/panelchat-api/ws/audio`);
        micWs.binaryType = 'arraybuffer';

        node.port.onmessage = (e) => {
            if (micWs?.readyState !== WebSocket.OPEN) return;
            const buf = e.data;
            const b64 = arrayBufferToBase64(buf);
            micWs.send(JSON.stringify({ type: 'audio', data: b64 }));
        };

        source.connect(node);

        micWs.onopen = () => {
            document.getElementById('mic-btn').hidden = true;
            const stopBtn = document.getElementById('mic-stop-btn');
            stopBtn.hidden = false;
            stopBtn.innerHTML = '<span class="live-dot"></span>Stop mic';
        };
        micWs.onclose = () => stopMic({ wsClosed: true });
        micWs.onerror = () => {};
    };

    const stopMic = async ({ wsClosed = false } = {}) => {
        try { if (!wsClosed && micWs && micWs.readyState === WebSocket.OPEN) micWs.close(); } catch {}
        try { micStream?.getTracks().forEach((t) => t.stop()); } catch {}
        try { await micCtx?.close(); } catch {}
        micStream = micCtx = micWs = null;
        document.getElementById('mic-btn').hidden = false;
        document.getElementById('mic-stop-btn').hidden = true;
        refreshAudio();
    };

    const arrayBufferToBase64 = (buf) => {
        const bytes = new Uint8Array(buf);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(bin);
    };

    // ---------- Boot ----------

    const checkAuth = async () => {
        const { authenticated } = await api('/admin/status');
        if (authenticated) {
            loginPane.hidden = true;
            appPane.hidden = false;
            logoutBtn.hidden = false;
            await loadAll();
        } else {
            loginPane.hidden = false;
            appPane.hidden = true;
            logoutBtn.hidden = true;
        }
    };

    const loadAll = async () => {
        const initial = await api('/feed/initial');
        state = initial;
        recentPostsCache = initial.posts || [];
        setState(initial.state);
        setActiveLabel(initial.session);
        renderProfiles(initial.profiles);
        renderSettings(initial.settings);
        renderAdminFeed(recentPostsCache);
        resetTranscriptUI();
        await refreshSessions();
        await refreshAudio();
        await refreshAudienceQueue();
    };

    const connectSse = () => {
        const es = new EventSource('/panelchat-api/feed/stream');
        es.onmessage = (e) => {
            try {
                const env = JSON.parse(e.data);
                if (env.type === 'state') setState(env.state);
                else if (env.type === 'profiles') renderProfiles(env.profiles);
                else if (env.type === 'settings') renderSettings(env.settings);
                else if (env.type === 'post') {
                    recentPostsCache.push(env.post);
                    appendAdminPost(env.post);
                } else if (env.type === 'transcript_delta') {
                    liveDeltaBuf += env.text;
                    renderLive();
                } else if (env.type === 'transcript_completed') {
                    liveDeltaBuf = '';
                    renderLive();
                    pushTranscriptSegment({ text: env.text, at: env.at, source: env.source });
                } else if (env.type === 'audience_queue') {
                    refreshAudienceQueue();
                } else if (env.type === 'session_restarted') {
                    resetTranscriptUI();
                    recentPostsCache = [];
                    renderAdminFeed([]);
                    refreshSessions();
                    refreshAudienceQueue();
                } else if (env.type === 'session_changed' || env.type === 'session_loaded' || env.type === 'session_deleted') {
                    loadAll();
                } else if (env.type === 'hello' && env.state) {
                    state = env.state;
                    setState(env.state.state);
                    setActiveLabel(env.state.session);
                    renderProfiles(env.state.profiles);
                    renderSettings(env.state.settings);
                    recentPostsCache = env.state.posts || [];
                    renderAdminFeed(recentPostsCache);
                    resetTranscriptUI();
                }
            } catch {}
        };
    };

    // ---------- Form handlers ----------

    $('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = $('#login-err');
        errEl.textContent = '';
        const password = e.target.password.value;
        try {
            await api('/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
            await checkAuth();
            connectSse();
        } catch (err) {
            errEl.textContent = err.message;
        }
    });

    logoutBtn.addEventListener('click', async () => {
        await api('/admin/logout', { method: 'POST' });
        location.reload();
    });

    $$('[data-action]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const confirmMsg = btn.dataset.confirm;
            if (confirmMsg && !confirm(confirmMsg)) return;
            try {
                await api(`/admin/${btn.dataset.action}`, { method: 'POST' });
            } catch (err) {
                alert(err.message);
            }
        });
    });

    $('#new-session-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const label = e.target.label.value.trim();
        const kind = e.target.kind.value;
        if (!label) return;
        try {
            await api('/admin/sessions', { method: 'POST', body: JSON.stringify({ label, kind }) });
            e.target.reset();
            await loadAll();
        } catch (err) { alert(err.message); }
    });

    $('#settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {};
        for (const el of e.target.querySelectorAll('input[name]')) {
            const raw = Number(el.value);
            payload[el.name] = el.dataset.unit === 'seconds' ? Math.round(raw * 1000) : raw;
        }
        try {
            await api('/admin/settings', { method: 'POST', body: JSON.stringify(payload) });
            flashSaved(e.target);
        } catch (err) {
            flashSaved(e.target, { ok: false, message: err.message });
        }
    });

    $('#operator-ask-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = $('#operator-question').value.trim();
        if (!q) return;
        try {
            await api('/admin/ask', { method: 'POST', body: JSON.stringify({ question: q }) });
            $('#operator-question').value = '';
            flashSaved(e.target, { ok: true });
            const badge = e.target.querySelector('.save-status');
            if (badge) badge.textContent = '✓ Sent';
        } catch (err) {
            flashSaved(e.target, { ok: false, message: err.message });
        }
    });

    $('#inject-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = $('#inject-text').value.trim();
        if (!text) return;
        try {
            await api('/admin/transcript-inject', { method: 'POST', body: JSON.stringify({ text }) });
            $('#inject-text').value = '';
            flashSaved(e.target, { ok: true });
            const badge = e.target.querySelector('.save-status');
            if (badge) badge.textContent = '✓ Injected';
        } catch (err) {
            flashSaved(e.target, { ok: false, message: err.message });
        }
    });

    $('#probe-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const characterId = probeCharacterSelect.value;
        const message = $('#probe-message').value.trim();
        const includeContext = $('#probe-include-context').checked;
        if (!characterId || !message) return;
        const btn = e.target.querySelector('button');
        btn.disabled = true;
        probeResult.hidden = false;
        probeResult.innerHTML = '<div class="meta">probing…</div>';
        try {
            const r = await api('/admin/probe', {
                method: 'POST',
                body: JSON.stringify({ characterId, message, includeContext }),
            });
            const ctxBadge = r.includedContext
                ? ` · ctx: ${r.transcriptCharCount} transcript chars / ${r.recentChatCount} chat posts`
                : ' · no context';
            probeResult.innerHTML = `
                <div class="meta">${escape(r.modelLabel || r.model)} · ${escape(r.provider)} · ${Math.round(r.genMs)} ms${escape(ctxBadge)}</div>
                <div class="text">${escape(r.text)}</div>
                <details>
                  <summary>Show exactly what the model received</summary>
                  <pre>SYSTEM PROMPT
${escape(r.systemPrompt || '')}

USER MESSAGE
${escape(r.userMessage || '')}</pre>
                </details>
            `;
        } catch (err) {
            probeResult.innerHTML = `<div class="err">${err.message}</div>`;
        } finally {
            btn.disabled = false;
        }
    });

    $('#audience-toggle').addEventListener('change', async (e) => {
        try {
            await api('/admin/settings', { method: 'POST', body: JSON.stringify({ audienceAsksEnabled: e.target.checked }) });
            refreshAudienceQueue();
            flashSaved(e.target.parentNode);
        } catch (err) {
            flashSaved(e.target.parentNode, { ok: false, message: err.message });
        }
    });

    $('#audience-settings-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {};
        for (const el of e.target.querySelectorAll('input[name]')) {
            const raw = Number(el.value);
            payload[el.name] = el.dataset.unit === 'seconds' ? Math.round(raw * 1000) : raw;
        }
        try {
            await api('/admin/settings', { method: 'POST', body: JSON.stringify(payload) });
            flashSaved(e.target);
        } catch (err) {
            flashSaved(e.target, { ok: false, message: err.message });
        }
    });

    $('#audience-clear').addEventListener('click', async () => {
        if (!confirm('Clear the entire queue?')) return;
        await api('/admin/audience-queue/clear', { method: 'POST' });
        refreshAudienceQueue();
    });

    document.getElementById('reset-profiles-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const msg =
            'Reset every character on this session to the seed defaults?\n\n' +
            'This wipes any admin edits — display names, system prompts, ' +
            'provider/model, triggers, avatars. The session itself, posts, ' +
            'and transcript are untouched.';
        if (!confirm(msg)) return;
        btn.disabled = true;
        btn.textContent = 'resetting…';
        try {
            await api('/admin/profiles/reset', { method: 'POST' });
            await loadAll();
        } catch (err) {
            alert(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Reset to defaults';
        }
    });

    document.getElementById('mic-btn').addEventListener('click', startMic);
    document.getElementById('mic-stop-btn').addEventListener('click', () => stopMic());
    document.getElementById('audio-stop-btn').addEventListener('click', async () => {
        await api('/admin/audio/stop', { method: 'POST' });
        refreshAudio();
    });
    document.getElementById('play-file-btn').addEventListener('click', async () => {
        const filename = devAudioSelect.value;
        if (!filename) return;
        try {
            await api('/admin/audio/file', { method: 'POST', body: JSON.stringify({ filename }) });
            refreshAudio();
        } catch (err) { alert(err.message); }
    });

    checkAuth().then(() => { if (!appPane.hidden) connectSse(); });
})();
