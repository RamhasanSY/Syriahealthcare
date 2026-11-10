// Video call of a video appointment (src/video.js), browser to browser (WebRTC).
// Order: both say "hello"; the doctor sends an offer when the patient is there; the patient answers. Every offer has a
// new session id (sid), so candidates and answers of an older attempt are ignored after a reload.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError} = Shc;
    const id = new URLSearchParams(window.location.search).get('id') || '';
    const TZ = 'Asia/Damascus';
    let info = null, stream = null, pc = null, sid = null, after = 0, ended = false, queued = [];
    const say = (en, ar) => { $('status').dataset.en = en; $('status').dataset.ar = ar; $('status').textContent = tr(en, ar); };
    const send = (type, data = null) => api(`/api/video/${encodeURIComponent(id)}/signal`, {type, data});

    async function loadInfo() {
        const res = await api(`/api/video/${encodeURIComponent(id)}`);
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/login?next=' + encodeURIComponent('/video?id=' + id)), null;
        if (res.data.error === 'second_factor_required') return window.location.assign('/confirm?next=' + encodeURIComponent('/video?id=' + id)), null;
        if (!res.ok) return showError('pageError', res.data), null;
        return res.data;
    }

    info = await loadInfo();
    if (!info) return;
    const doctor = info.role === 'doctor';
    $('backLink').href = doctor ? '/dashboard' : '/appointments';
    $('who').textContent = doctor ? tr(`With ${info.peer_name}`, `مع ${info.peer_name}`) : tr(`With ${info.peer_name}`, `مع ${info.peer_name}`);
    if (!info.open) {
        const time = new Date(info.opens_at).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ});
        if (info.status !== 'confirmed') say('This appointment is not confirmed, so there is no call.', 'هذا الموعد غير مؤكد، لذلك لا توجد مكالمة.');
        else if (Date.now() < Date.parse(info.opens_at)) say(`The call opens on ${time}. Keep this page open; it starts by itself.`, `تُفتح المكالمة ${time}. أبقِ هذه الصفحة مفتوحة، وستبدأ تلقائياً.`);
        else say('The time for this call is over.', 'انتهى وقت هذه المكالمة.');
        $('back').hidden = false;
        if (info.status === 'confirmed' && Date.now() < Date.parse(info.opens_at)) setTimeout(() => window.location.reload(), Math.min(Date.parse(info.opens_at) - Date.now() + 2000, 10 * 60_000));
        return;
    }

    // Camera and microphone; sound only if there is no camera.
    say('Allow the camera and microphone when the browser asks.', 'اسمح باستخدام الكاميرا والميكروفون عندما يسألك المتصفح.');
    try {
        stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}, video: {facingMode: 'user', width: {ideal: 640}, height: {ideal: 480}}});
    } catch (_) {
        try {
            stream = await navigator.mediaDevices.getUserMedia({audio: true});
        } catch (error) {
            return showError('pageError', {error: 'media', message: tr('The camera and microphone could not be used. Allow them for this site in the browser settings, then reload.',
                'تعذر استخدام الكاميرا والميكروفون. اسمح بهما لهذا الموقع من إعدادات المتصفح ثم أعد تحميل الصفحة.')});
        }
    }
    $('local').srcObject = stream;
    $('call').hidden = false;
    $('cam').disabled = !stream.getVideoTracks().length;

    function newConnection() {
        pc?.close();
        queued = [];
        pc = new RTCPeerConnection({iceServers: info.ice_servers});
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        const mine = sid;
        // Candidates wait until the offer or answer is on the server, so the other side never gets them first.
        const outgoing = [];
        let described = false;
        pc.onicecandidate = event => {
            if (!event.candidate || mine !== sid) return;
            const c = {sid: mine, candidate: event.candidate.toJSON()};
            described ? send('candidate', c) : outgoing.push(c);
        };
        pc.described = async () => {
            described = true;
            for (const c of outgoing.splice(0)) await send('candidate', c);
        };
        pc.ontrack = event => { $('remote').srcObject = event.streams[0]; };
        pc.onconnectionstatechange = () => {
            if (mine !== sid) return;
            const state = pc.connectionState;
            if (state === 'connected') say('Connected.', 'متصل.');
            else if (state === 'disconnected') say('The connection is weak. Waiting…', 'الاتصال ضعيف. ننتظر…');
            else if (state === 'failed') {
                say('The connection was lost. Trying again…', 'انقطع الاتصال. نحاول مجدداً…');
                if (doctor) call();
            }
        };
        return pc;
    }

    async function call() {
        sid = Math.random().toString(36).slice(2, 12);
        newConnection();
        await pc.setLocalDescription(await pc.createOffer());
        await send('offer', {sid, sdp: pc.localDescription.toJSON()});
        await pc.described();
        say('Calling…', 'جارٍ الاتصال…');
    }

    async function flush() {
        for (const candidate of queued.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    }

    async function handle(m) {
        const data = m.data || {};
        if (m.type === 'hello') {
            if (doctor) await call();
            else say('The doctor joined. Connecting…', 'انضم الطبيب. جارٍ الاتصال…');
        } else if (m.type === 'offer' && !doctor) {
            sid = data.sid;
            newConnection();
            await pc.setRemoteDescription(data.sdp);
            await flush();
            await pc.setLocalDescription(await pc.createAnswer());
            await send('answer', {sid, sdp: pc.localDescription.toJSON()});
            await pc.described();
        } else if (m.type === 'answer' && doctor && data.sid === sid) {
            await pc.setRemoteDescription(data.sdp);
            await flush();
        } else if (m.type === 'candidate' && data.sid === sid && pc) {
            if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
            else queued.push(data.candidate);
        } else if (m.type === 'bye') {
            pc?.close();
            pc = null;
            $('remote').srcObject = null;
            say(doctor ? 'The patient left the call. You can wait here if they come back.' : 'The doctor left the call.',
                doctor ? 'غادر المريض المكالمة. يمكنك الانتظار هنا إن عاد.' : 'غادر الطبيب المكالمة.');
        }
    }

    // Long polling: the server holds the request until the other side sends something (up to 25 seconds).
    async function listen() {
        while (!ended) {
            const res = await api(`/api/video/${encodeURIComponent(id)}/signal?after=${after}`);
            if (ended) return;
            if (!res.ok) {
                if (res.data.error === 'video_not_open') {
                    say('The time for this call is over.', 'انتهى وقت هذه المكالمة.');
                    return hangup(false);
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            for (const m of res.data.messages) {
                after = Math.max(after, m.n);
                try { await handle(m); } catch (_) { /* a broken message from an older attempt: the next offer replaces it */ }
            }
        }
    }

    async function hangup(tell = true) {
        ended = true;
        if (tell) await send('bye').catch(() => {});
        pc?.close();
        stream?.getTracks().forEach(t => t.stop());
        $('call').hidden = true;
        $('back').hidden = false;
        if (tell) say('The call has ended.', 'انتهت المكالمة.');
        $('heading').focus();
    }

    const toggle = (button, tracks, onEn, onAr, offEn, offAr) => {
        const off = button.getAttribute('aria-pressed') !== 'true';
        tracks().forEach(t => { t.enabled = !off; });
        button.setAttribute('aria-pressed', String(off));
        button.dataset.en = off ? offEn : onEn;
        button.dataset.ar = off ? offAr : onAr;
        button.textContent = tr(button.dataset.en, button.dataset.ar);
    };
    $('mic').addEventListener('click', () => toggle($('mic'), () => stream.getAudioTracks(), 'Mute microphone', 'كتم الميكروفون', 'Unmute microphone', 'تشغيل الميكروفون'));
    $('cam').addEventListener('click', () => toggle($('cam'), () => stream.getVideoTracks(), 'Turn camera off', 'إيقاف الكاميرا', 'Turn camera on', 'تشغيل الكاميرا'));
    $('hangup').addEventListener('click', () => hangup(true));

    const hello = await send('hello');
    if (!hello.ok) return showError('pageError', hello.data);
    after = hello.data.n;
    say(doctor ? 'Waiting for the patient…' : 'Waiting for the doctor…', doctor ? 'بانتظار المريض…' : 'بانتظار الطبيب…');
    if (doctor && hello.data.peer_present) await call();
    listen();
});
