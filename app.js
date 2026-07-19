(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const config = window.WATCH_TOGETHER_CONFIG || {};
  const state = {
    roomId: null,
    role: "guest",
    name: "Азизашка",
    streamUrl: "",
    channel: null,
    peer: null,
    connection: null,
    playerKind: null,
    hls: null,
    youtube: null,
    localFile: null,
    localObjectUrl: null,
    sourceMode: "link",
    suppressSync: false,
    connectedPeers: new Set(),
    unread: 0
  };

  const els = {
    home: $("#homeView"), invite: $("#inviteView"), room: $("#roomView"),
    form: $("#createForm"), streamUrl: $("#streamUrl"), enter: $("#enterRoomButton"),
    linkPanel: $("#linkSourcePanel"), filePanel: $("#fileSourcePanel"), createFile: $("#createFileInput"),
    chooseCreateFile: $("#chooseCreateFile"), createFileName: $("#createFileName"),
    empty: $("#playerEmpty"), video: $("#videoPlayer"), youtube: $("#youtubePlayer"), iframe: $("#iframePlayer"),
    localFilePlayer: $("#localFilePlayer"), roomFile: $("#roomFileInput"), selectRoomFile: $("#selectRoomFile"), localFileHint: $("#localFileHint"),
    unsupported: $("#unsupportedPlayer"), openStream: $("#openStreamLink"),
    sharePanel: $("#sharePanel"), share: $("#shareButton"), copy: $("#copyButton"),
    presence: $("#presence"), chatStatus: $("#chatStatus"), messages: $("#messages"),
    chatForm: $("#chatForm"), message: $("#messageInput"), sync: $("#syncButton"),
    chat: $(".chat-card"), mobileChat: $("#mobileChatButton"), closeChat: $("#closeChatButton"),
    unread: $("#unreadBadge"), reactionStage: $("#reactionStage"), toast: $("#toast")
  };

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18);
  }

  function roomFromHash() {
    const match = location.hash.match(/^#\/room\/([a-z0-9_-]{8,40})$/i);
    return match ? match[1] : null;
  }

  function showView(view) {
    [els.home, els.invite, els.room].forEach((el) => el.classList.add("hidden"));
    view.classList.remove("hidden");
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function inviteUrl() {
    const source = encodeSource(state.streamUrl);
    return `${location.origin}${location.pathname}?source=${encodeURIComponent(source)}#/room/${state.roomId}`;
  }

  function encodeSource(url) {
    if (url === "https://stream.listopad.tj/football/index.m3u8") return "ftv";
    if (url === "local") return "local";
    return `url-${btoa(unescape(encodeURIComponent(url)))}`;
  }

  function sourceFromUrl() {
    const source = new URLSearchParams(location.search).get("source");
    if (source === "ftv") return "https://stream.listopad.tj/football/index.m3u8";
    if (source === "local") return "local";
    if (source?.startsWith("url-")) {
      try { return decodeURIComponent(escape(atob(source.slice(4)))); }
      catch { return ""; }
    }
    return "";
  }

  function saveHostRoom() {
    localStorage.setItem(`watch-room-${state.roomId}`, JSON.stringify({ streamUrl: state.streamUrl, createdAt: Date.now() }));
  }

  function loadHostRoom(roomId) {
    try { return JSON.parse(localStorage.getItem(`watch-room-${roomId}`) || "null"); }
    catch { return null; }
  }

  function realtimeConfigured() {
    return Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
  }

  async function joinRealtime() {
    if (!realtimeConfigured()) {
      return joinPeer();
    }

    const client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    state.channel = client.channel(`watch-room:${state.roomId}`, {
      config: { presence: { key: `${state.role}-${randomId()}` } }
    });

    state.channel
      .on("broadcast", { event: "room" }, ({ payload }) => receive(payload))
      .on("presence", { event: "sync" }, () => updatePresence())
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        await state.channel.track({ role: state.role, name: state.name, joinedAt: Date.now() });
        els.chatStatus.textContent = "вы вместе";
        if (state.role === "guest") send({ type: "request-state" });
        else sendState();
      });
  }

  function joinPeer() {
    if (!window.Peer) {
      els.chatStatus.textContent = "нет соединения";
      toast("Не удалось загрузить модуль чата");
      return;
    }

    const hostPeerId = `watch-${state.roomId}`;
    const ownPeerId = state.role === "host" ? hostPeerId : undefined;
    state.peer = ownPeerId ? new window.Peer(ownPeerId) : new window.Peer();

    state.peer.on("open", () => {
      els.chatStatus.textContent = state.role === "host" ? "ожидаем Азизашку…" : "ищем Хусрава…";
      if (state.role === "guest") connectToHost(hostPeerId);
    });

    state.peer.on("connection", (connection) => {
      if (state.role === "host") attachPeerConnection(connection);
    });

    state.peer.on("error", (error) => {
      if (state.role === "guest" && error.type === "peer-unavailable") {
        els.chatStatus.textContent = "Хусрав ещё не подключился";
        return;
      }
      els.chatStatus.textContent = "соединение прервано";
    });
  }

  function connectToHost(hostPeerId) {
    const connection = state.peer.connect(hostPeerId, { reliable: true });
    attachPeerConnection(connection);
  }

  function attachPeerConnection(connection) {
    if (state.connection?.open) state.connection.close();
    state.connection = connection;
    connection.on("open", () => {
      els.chatStatus.textContent = "вы вместе";
      els.presence.classList.add("connected");
      els.presence.querySelector("b").textContent = "Вы вместе";
      if (state.role === "guest") send({ type: "request-state" });
      else sendState();
    });
    connection.on("data", receive);
    connection.on("close", () => {
      els.chatStatus.textContent = "соединение прервано";
      els.presence.classList.remove("connected");
      els.presence.querySelector("b").textContent = state.role === "host" ? "Ожидаем Азизашку…" : "Хусрав отключился";
    });
  }

  function send(payload) {
    const message = { ...payload, sender: state.role, sentAt: Date.now() };
    if (state.channel) {
      state.channel.send({ type: "broadcast", event: "room", payload: message });
    } else if (state.connection?.open) {
      state.connection.send(message);
    }
  }

  function updatePresence() {
    if (!state.channel) return;
    const people = Object.values(state.channel.presenceState()).flat();
    const together = people.length >= 2;
    els.presence.classList.toggle("connected", together);
    els.presence.querySelector("b").textContent = together ? "Вы вместе" : (state.role === "host" ? "Ожидаем Азизашку…" : "Хусрав уже рядом");
  }

  function receive(payload) {
    if (!payload || payload.sender === state.role) return;
    if (payload.type === "request-state" && state.role === "host") return sendState();
    if (payload.type === "state" && state.role === "guest") {
      if (!state.streamUrl && payload.streamUrl) {
        state.streamUrl = payload.streamUrl;
        setupPlayer(state.streamUrl);
      }
      if (payload.fileName && state.streamUrl === "local" && !state.localFile) {
        els.localFileHint.textContent = `Выберите у себя тот же файл: ${payload.fileName}`;
      }
      applyPlayback(payload.playback);
    }
    if (payload.type === "playback") applyPlayback(payload.playback);
    if (payload.type === "chat") addMessage(payload.text, false, payload.sentAt);
    if (payload.type === "reaction") showReaction(payload.emoji);
  }

  function getPlayback() {
    if (state.playerKind === "video") return { action: els.video.paused ? "pause" : "play", time: els.video.currentTime || 0 };
    if (state.playerKind === "youtube" && state.youtube?.getCurrentTime) {
      const ytState = state.youtube.getPlayerState();
      return { action: ytState === 1 ? "play" : "pause", time: state.youtube.getCurrentTime() || 0 };
    }
    return null;
  }

  function sendState() {
    send({ type: "state", streamUrl: state.streamUrl, fileName: state.localFile?.name || "", playback: getPlayback() });
  }

  async function applyPlayback(playback) {
    if (!playback) return;
    state.suppressSync = true;
    try {
      if (state.playerKind === "video") {
        if (Number.isFinite(playback.time) && Math.abs(els.video.currentTime - playback.time) > 1.5) els.video.currentTime = playback.time;
        if (playback.action === "play") await els.video.play().catch(() => toast("Нажмите Play, чтобы разрешить звук"));
        else els.video.pause();
      } else if (state.playerKind === "youtube" && state.youtube?.seekTo) {
        if (Math.abs(state.youtube.getCurrentTime() - playback.time) > 1.5) state.youtube.seekTo(playback.time, true);
        playback.action === "play" ? state.youtube.playVideo() : state.youtube.pauseVideo();
      }
    } finally { setTimeout(() => { state.suppressSync = false; }, 350); }
  }

  function youtubeId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname.includes("youtu.be")) return parsed.pathname.slice(1).split("/")[0];
      if (parsed.hostname.includes("youtube.com")) return parsed.searchParams.get("v") || parsed.pathname.match(/\/(?:embed|live|shorts)\/([^/?]+)/)?.[1];
    } catch {}
    return null;
  }

  function normalizeStreamUrl(url) {
    try {
      const parsed = new URL(url);
      if (["ftv.tj", "www.ftv.tj"].includes(parsed.hostname) && parsed.pathname === "/live.html") {
        return "https://stream.listopad.tj/football/index.m3u8";
      }
    } catch {}
    return url;
  }

  function setupPlayer(url) {
    els.empty.classList.add("hidden");
    [els.video, els.youtube, els.iframe, els.unsupported, els.localFilePlayer].forEach((el) => el.classList.add("hidden"));
    if (url === "local") return setupLocalChoice();
    const ytId = youtubeId(url);
    if (ytId) return setupYouTube(ytId);
    if (/\.m3u8(?:$|\?)/i.test(url) || /\.(?:mp4|webm|ogg|mov)(?:$|\?)/i.test(url)) return setupVideo(url);
    setupIframe(url);
  }

  function setupLocalChoice() {
    if (state.localFile) return setupLocalFile(state.localFile);
    state.playerKind = "local-pending";
    els.localFilePlayer.classList.remove("hidden");
  }

  function setupLocalFile(file) {
    if (state.localObjectUrl) URL.revokeObjectURL(state.localObjectUrl);
    state.localFile = file;
    state.localObjectUrl = URL.createObjectURL(file);
    els.localFilePlayer.classList.add("hidden");
    setupVideo(state.localObjectUrl);
    toast("Фильм готов к совместному просмотру 🎬");
    if (state.role === "host") sendState();
    else send({ type: "request-state" });
  }

  function setupIframe(url) {
    state.playerKind = "iframe";
    els.iframe.src = url;
    els.iframe.classList.remove("hidden");
    els.openStream.href = url;
    toast("Источник встроен; управление зависит от его сайта");
  }

  function setupVideo(url) {
    state.playerKind = "video";
    els.video.classList.remove("hidden");
    if (/\.m3u8(?:$|\?)/i.test(url) && window.Hls?.isSupported()) {
      state.hls?.destroy();
      state.hls = new window.Hls({ lowLatencyMode: true });
      state.hls.loadSource(url);
      state.hls.attachMedia(els.video);
      state.hls.on(window.Hls.Events.ERROR, (_, data) => {
        if (data.fatal) toast("Источник не разрешил загрузить трансляцию");
      });
    } else {
      els.video.src = url;
    }
  }

  function setupYouTube(videoId) {
    state.playerKind = "youtube";
    els.youtube.classList.remove("hidden");
    loadYouTubeApi().then(() => {
      state.youtube = new YT.Player("youtubePlayer", {
        videoId,
        playerVars: { playsinline: 1, rel: 0 },
        events: { onStateChange: (event) => {
          if (!state.suppressSync && [YT.PlayerState.PLAYING, YT.PlayerState.PAUSED].includes(event.data)) send({ type: "playback", playback: getPlayback() });
        }}
      });
    });
  }

  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (loadYouTubeApi.promise) return loadYouTubeApi.promise;
    loadYouTubeApi.promise = new Promise((resolve) => {
      const oldReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { oldReady?.(); resolve(); };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    });
    return loadYouTubeApi.promise;
  }

  function addMessage(text, mine, sentAt = Date.now()) {
    const wrapper = document.createElement("div");
    wrapper.className = `message${mine ? " mine" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    const time = document.createElement("small");
    time.textContent = `${mine ? state.name : (state.role === "host" ? "Азизашка" : "Хусрав")} · ${new Date(sentAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" })}`;
    wrapper.append(bubble, time);
    els.messages.appendChild(wrapper);
    els.messages.scrollTop = els.messages.scrollHeight;
    if (!mine && matchMedia("(max-width: 800px)").matches && !els.chat.classList.contains("open")) {
      state.unread += 1;
      els.unread.textContent = state.unread;
      els.unread.classList.remove("hidden");
    }
  }

  function showReaction(emoji) {
    const item = document.createElement("span");
    item.className = "floating-reaction";
    item.textContent = emoji;
    item.style.left = `${12 + Math.random() * 72}%`;
    els.reactionStage.appendChild(item);
    item.addEventListener("animationend", () => item.remove());
    if (emoji === "🌹") petals(8);
  }

  function petals(count = 14) {
    const stage = $("#petals");
    for (let i = 0; i < count; i += 1) {
      const petal = document.createElement("span");
      petal.className = "petal";
      petal.textContent = i % 3 ? "🌹" : "❤️";
      petal.style.left = `${Math.random() * 100}%`;
      petal.style.setProperty("--drift", `${-90 + Math.random() * 180}px`);
      petal.style.animationDelay = `${Math.random() * 1.2}s`;
      petal.style.fontSize = `${12 + Math.random() * 13}px`;
      stage.appendChild(petal);
      petal.addEventListener("animationend", () => petal.remove());
    }
  }

  function enterRoom() {
    showView(els.room);
    petals();
    setupPlayer(state.streamUrl);
    joinRealtime();
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.sourceMode === "file" && !state.localFile) return toast("Сначала выберите фильм");
    if (state.sourceMode === "link" && !els.streamUrl.value.trim()) return toast("Вставьте ссылку для просмотра");
    state.roomId = randomId();
    state.role = "host";
    state.name = "Хусрав";
    state.streamUrl = state.sourceMode === "file" ? "local" : normalizeStreamUrl(els.streamUrl.value.trim());
    saveHostRoom();
    history.pushState({}, "", `#/room/${state.roomId}`);
    els.sharePanel.classList.remove("hidden");
    enterRoom();
  });

  document.querySelectorAll("[data-source-tab]").forEach((button) => button.addEventListener("click", () => {
    state.sourceMode = button.dataset.sourceTab;
    document.querySelectorAll("[data-source-tab]").forEach((item) => item.classList.toggle("active", item === button));
    els.linkPanel.classList.toggle("hidden", state.sourceMode !== "link");
    els.filePanel.classList.toggle("hidden", state.sourceMode !== "file");
  }));
  els.chooseCreateFile.addEventListener("click", () => els.createFile.click());
  els.createFile.addEventListener("change", () => {
    const file = els.createFile.files?.[0];
    if (!file) return;
    state.localFile = file;
    els.createFileName.textContent = `Выбран фильм: ${file.name}`;
    els.createFileName.classList.remove("hidden");
  });
  els.selectRoomFile.addEventListener("click", () => els.roomFile.click());
  els.roomFile.addEventListener("change", () => {
    const file = els.roomFile.files?.[0];
    if (file) setupLocalFile(file);
  });

  els.enter.addEventListener("click", enterRoom);
  els.copy.addEventListener("click", async () => { await navigator.clipboard.writeText(inviteUrl()); toast("Ссылка скопирована для Азизашки ❤️"); });
  els.share.addEventListener("click", async () => {
    const data = { title: "Наш вечер ❤️", text: "Азизашка, я жду тебя в нашей комнате ❤️", url: inviteUrl() };
    if (navigator.share) await navigator.share(data).catch(() => {});
    else { await navigator.clipboard.writeText(inviteUrl()); toast("Ссылка скопирована ❤️"); }
  });
  els.chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = els.message.value.trim();
    if (!text) return;
    addMessage(text, true);
    send({ type: "chat", text });
    els.message.value = "";
  });
  document.querySelectorAll("[data-reaction]").forEach((button) => button.addEventListener("click", () => {
    const emoji = button.dataset.reaction;
    showReaction(emoji);
    send({ type: "reaction", emoji });
  }));
  els.video.addEventListener("play", () => { if (!state.suppressSync) send({ type: "playback", playback: getPlayback() }); });
  els.video.addEventListener("pause", () => { if (!state.suppressSync) send({ type: "playback", playback: getPlayback() }); });
  els.video.addEventListener("seeked", () => { if (!state.suppressSync) send({ type: "playback", playback: getPlayback() }); });
  els.sync.addEventListener("click", () => { state.role === "host" ? sendState() : send({ type: "request-state" }); toast("Синхронизируем вас ♡"); });
  els.mobileChat.addEventListener("click", () => { els.chat.classList.add("open"); state.unread = 0; els.unread.classList.add("hidden"); });
  els.closeChat.addEventListener("click", () => els.chat.classList.remove("open"));

  const initialRoom = roomFromHash();
  if (initialRoom) {
    state.roomId = initialRoom;
    const hosted = loadHostRoom(initialRoom);
    if (hosted?.streamUrl) {
      state.role = "host";
      state.name = "Хусрав";
      state.streamUrl = hosted.streamUrl;
      els.sharePanel.classList.remove("hidden");
      enterRoom();
    } else {
      state.role = "guest";
      state.name = "Азизашка";
      state.streamUrl = sourceFromUrl();
      showView(els.invite);
    }
  }
})();
