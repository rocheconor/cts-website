// Panelchat visitor page. Talks to /panelchat-api/feed/* (SSE) and
// /panelchat-api/audience/question.

(() => {
    const feedEl = document.getElementById('feed');
    const urlEl = document.getElementById('page-url');
    const archiveBanner = document.getElementById('archive-banner');
    const askPane = document.getElementById('ask-panel');
    const askForm = document.getElementById('ask-form');
    const askText = document.getElementById('ask-text');
    const askCounter = document.getElementById('ask-counter');
    const askSubmit = document.getElementById('ask-submit');
    const askFeedback = document.getElementById('ask-feedback');
    const askForPanel = document.getElementById('ask-for-panel');

    let currentSettings = {};
    let currentState = null;

    const archiveMatch = location.pathname.match(/^\/panelchat\/sessions\/([^/]+)\/?$/);
    const archiveSessionId = archiveMatch ? decodeURIComponent(archiveMatch[1]) : null;
    const isArchive = !!archiveSessionId;

    const visibleUrl = location.host + location.pathname.replace(/\/+$/, '');
    urlEl.textContent = visibleUrl;

    let renderedIds = new Set();
    let currentSessionId = null;
    let typingEl = null;

    const isQuestionPost = (p) =>
        p && (p.kind === 'audience_question' || p.kind === 'operator_question' || p.kind === 'panel_question');

    const refreshAskVisibility = () => {
        let visible = true;
        if (isArchive) visible = false;
        else {
            const enabled = !!currentSettings.audienceAsksEnabled;
            const usable = ['opening', 'running', 'paused', 'question'].includes(currentState);
            visible = enabled && usable;
        }
        askPane.hidden = !visible;
        document.body.classList.toggle('has-composer', visible);
        if (visible) syncAskCap();
    };

    const audienceMaxChars = () => Number(currentSettings.audienceMaxChars) || 200;

    const syncAskCap = () => {
        const cap = audienceMaxChars();
        askText.maxLength = cap;
        askCounter.textContent = `${askText.value.length} / ${cap}`;
    };

    askText?.addEventListener('input', () => {
        askCounter.textContent = `${askText.value.length} / ${audienceMaxChars()}`;
    });

    askForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const question = askText.value.trim();
        if (!question) return;
        const forPanel = !!askForPanel?.checked;
        askSubmit.disabled = true;
        askFeedback.className = 'ask-feedback';
        askFeedback.textContent = 'sending…';
        try {
            const res = await fetch('/panelchat-api/audience/question', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question, forPanel }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                askFeedback.className = 'ask-feedback err';
                askFeedback.textContent = humanizeQueueError(data.error || res.statusText);
            } else {
                askFeedback.className = 'ask-feedback ok';
                if (data.forPanel) {
                    askFeedback.textContent = 'Sent to the panel — the host will read it out.';
                } else {
                    askFeedback.textContent =
                        data.position > 1
                            ? `Sent to the AI — ${data.position} of ${data.queueLength} ahead of yours`
                            : 'Sent to the AI — yours is next.';
                }
                askText.value = '';
                askCounter.textContent = `0 / ${audienceMaxChars()}`;
                if (askForPanel) askForPanel.checked = false;
            }
        } catch (err) {
            askFeedback.className = 'ask-feedback err';
            askFeedback.textContent = 'Network error — try again.';
        } finally {
            askSubmit.disabled = false;
        }
    });

    const humanizeQueueError = (raw) => {
        if (!raw) return 'Could not send. Try again shortly.';
        if (raw.startsWith('rate_limited_retry_in_')) {
            const s = raw.replace('rate_limited_retry_in_', '').replace('s', '');
            return `Too quick — wait ${s}s before sending another.`;
        }
        if (raw === 'audience_asks_disabled') return 'Audience questions are closed right now.';
        if (raw === 'queue_full') return 'Queue is full — try again in a moment.';
        if (raw === 'empty_question') return 'Type a question first.';
        if (raw.startsWith('question_too_long_max_')) return 'Too long — keep it under 200 characters.';
        return raw;
    };

    const showEmpty = (msg = 'Waiting…') => {
        if (!feedEl.querySelector('.empty-state')) {
            const div = document.createElement('div');
            div.className = 'empty-state';
            div.textContent = msg;
            feedEl.appendChild(div);
        }
    };
    const clearEmpty = () => feedEl.querySelector('.empty-state')?.remove();

    const initialEl = (post) => {
        const div = document.createElement('div');
        div.className = 'avatar empty';
        div.textContent = (post.displayName || '?').slice(0, 1).toUpperCase();
        return div;
    };

    const hideTyping = () => {
        if (typingEl) {
            typingEl.remove();
            typingEl = null;
        }
    };

    const showTyping = (info) => {
        if (!info) return hideTyping();
        if (typingEl) typingEl.remove();
        clearEmpty();
        typingEl = document.createElement('article');
        typingEl.className = 'post typing-post';
        let avatarHtml;
        if (info.avatarUrl) {
            avatarHtml = `<div class="avatar"><img src="${info.avatarUrl}" alt=""></div>`;
        } else {
            const letter = (info.displayName || '?').slice(0, 1).toUpperCase();
            avatarHtml = `<div class="avatar empty">${letter}</div>`;
        }
        typingEl.innerHTML = `
            ${avatarHtml}
            <div class="body">
              <div class="row1">
                <span class="name">${escape(info.displayName)}</span>
                ${info.nickname ? `<span class="nick">"${escape(info.nickname)}"</span>` : ''}
                ${info.modelLabel ? `<span class="badge">${info.modelBadgeUrl ? `<img src="${info.modelBadgeUrl}" alt="">` : ''}<span>${escape(info.modelLabel)}</span></span>` : ''}
              </div>
              <div class="text"><span class="typing-dots"><span></span><span></span><span></span></span></div>
            </div>
        `;
        feedEl.appendChild(typingEl);
        if (window.scrollY < 120) window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const renderPost = (post) => {
        if (!post?.id || renderedIds.has(post.id)) return;
        // Operator questions never appear on the public feed. They still
        // commit to Firestore and the admin sees them in the admin feed,
        // but visitors only see audience questions and bot posts.
        if (post.kind === 'operator_question') return;
        renderedIds.add(post.id);
        clearEmpty();
        hideTyping();

        const wrapper = document.createElement('article');
        wrapper.className = 'post';
        if (post.kind === 'panel_question') {
            wrapper.classList.add('audience-question', 'for-panel');
        } else if (isQuestionPost(post)) {
            wrapper.classList.add('audience-question');
        }

        let avatar;
        if (post.avatarUrl) {
            avatar = document.createElement('div');
            avatar.className = 'avatar';
            const img = document.createElement('img');
            img.src = post.avatarUrl;
            img.alt = '';
            avatar.appendChild(img);
        } else {
            avatar = initialEl(post);
        }
        wrapper.appendChild(avatar);

        const body = document.createElement('div');
        body.className = 'body';

        const row1 = document.createElement('div');
        row1.className = 'row1';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = post.displayName || (isQuestionPost(post) ? 'Audience' : '');
        row1.appendChild(name);
        if (post.nickname && !isQuestionPost(post)) {
            const nick = document.createElement('span');
            nick.className = 'nick';
            nick.textContent = `“${post.nickname}”`;
            row1.appendChild(nick);
        }
        if (post.kind === 'panel_question') {
            // Clear visual cue that this question is for the human panel.
            const tag = document.createElement('span');
            tag.className = 'badge for-panel-tag';
            tag.textContent = 'For panel';
            row1.appendChild(tag);
        } else if (post.modelLabel && !isQuestionPost(post)) {
            const badge = document.createElement('span');
            badge.className = 'badge';
            if (post.modelBadgeUrl) {
                const img = document.createElement('img');
                img.src = post.modelBadgeUrl;
                img.alt = '';
                badge.appendChild(img);
            }
            const label = document.createElement('span');
            label.textContent = post.modelLabel;
            badge.appendChild(label);
            row1.appendChild(badge);
        }
        body.appendChild(row1);

        const text = document.createElement('div');
        text.className = 'text';
        renderTextWithLinks(post.body, text);
        body.appendChild(text);

        wrapper.appendChild(body);
        feedEl.appendChild(wrapper);
        if (window.scrollY < 120) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    };

    const applyInitial = (data) => {
        renderedIds = new Set();
        feedEl.innerHTML = '';
        typingEl = null;
        currentSessionId = data.sessionId;
        currentSettings = data.settings || {};
        currentState = data.state;
        archiveBanner.hidden = !data.isArchive;
        if (data.isArchive && data.session) {
            const label = data.session.label || data.sessionId;
            const ended = data.session.endedAtMs ? new Date(data.session.endedAtMs) : null;
            const when = ended ? ended.toLocaleString() : '';
            archiveBanner.innerHTML = `<div><span class="label">Archive · ${escape(label)}</span></div><div class="when">${when ? 'ended ' + when : ''}</div>`;
        }
        const posts = data.posts || [];
        for (const p of posts) renderPost(p);
        if (!posts.length) showEmpty(data.isArchive ? 'Empty session.' : 'Waiting…');
        if (!data.isArchive && data.typing) showTyping(data.typing);
        refreshAskVisibility();
    };

    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Safe markdown-link renderer. ONLY recognises [text](url) where url
    // starts with http:// or https://. Everything else stays as plain text
    // (created with createTextNode, so HTML can't slip through). javascript:,
    // data:, file:, etc. schemes are rejected by the regex.
    const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const renderTextWithLinks = (text, container) => {
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

    const hydrate = async () => {
        const url = isArchive
            ? `/panelchat-api/feed/initial?sessionId=${encodeURIComponent(archiveSessionId)}`
            : '/panelchat-api/feed/initial';
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`initial ${res.status}`);
            const data = await res.json();
            applyInitial(data);
        } catch (err) {
            console.warn('hydrate failed', err);
            showEmpty('Could not load session.');
        }
    };

    const connect = () => {
        if (isArchive) return;
        const es = new EventSource('/panelchat-api/feed/stream');
        es.onmessage = (e) => {
            try {
                const env = JSON.parse(e.data);
                if (env.type === 'post') {
                    if (env.post.sessionId && env.post.sessionId !== currentSessionId) return;
                    renderPost(env.post);
                } else if (env.type === 'typing') {
                    showTyping(env.typing);
                } else if (env.type === 'typing_end') {
                    hideTyping();
                } else if (env.type === 'state') {
                    currentState = env.state;
                    refreshAskVisibility();
                } else if (env.type === 'settings') {
                    currentSettings = env.settings || currentSettings;
                    refreshAskVisibility();
                } else if (env.type === 'hello' && env.state) {
                    applyInitial(env.state);
                } else if (env.type === 'session_changed' || env.type === 'session_loaded') {
                    hydrate();
                }
            } catch {}
        };
        es.onerror = () => { /* EventSource auto-reconnects */ };
    };

    hydrate().then(connect);
})();
