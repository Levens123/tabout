/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/* ----------------------------------------------------------------
   DAILY VERSE — bucketed pool + context-aware picker

   Buckets contain hand-picked Chinese classical poetry. Each bucket
   covers a context (festival / solar term / time-of-day / season /
   romantic fallback). The picker chooses by priority:

     festival > solar term > time-of-day > season > romantic

   Within the chosen bucket, a date-based hash deterministically
   picks one line, so the same calendar day always shows the same
   verse no matter how many times you open a new tab.
   ---------------------------------------------------------------- */

// ---- Romantic & wanyue (婉约) — main flavor (~50%) ----
const VERSES_ROMANTIC = [
  { line: '山有木兮木有枝，心悦君兮君不知。',                           source: '《越人歌》',                   mood: '婉约' },
  { line: '愿我如星君如月，夜夜流光相皎洁。',                           source: '范成大《车遥遥篇》',           mood: '婉约' },
  { line: '只愿君心似我心，定不负相思意。',                             source: '李之仪《卜算子》',             mood: '婉约' },
  { line: '玲珑骰子安红豆，入骨相思知不知。',                           source: '温庭筠《南歌子》',             mood: '婉约' },
  { line: '月上柳梢头，人约黄昏后。',                                   source: '欧阳修《生查子》',             mood: '婉约' },
  { line: '愿得一心人，白头不相离。',                                   source: '卓文君《白头吟》',             mood: '婉约' },
  { line: '夜月一帘幽梦，春风十里柔情。',                               source: '秦观《八六子》',               mood: '婉约' },
  { line: '身无彩凤双飞翼，心有灵犀一点通。',                           source: '李商隐《无题》',               mood: '婉约' },
  { line: '若似月轮终皎洁，不辞冰雪为卿热。',                           source: '纳兰性德《蝶恋花》',           mood: '婉约' },
  { line: '一往情深深几许？深山夕照深秋雨。',                           source: '纳兰性德《蝶恋花》',           mood: '婉约' },
  { line: '何当共剪西窗烛，却话巴山夜雨时。',                           source: '李商隐《夜雨寄北》',           mood: '婉约' },
  { line: '众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。',           source: '辛弃疾《青玉案》',             mood: '婉约' },
  { line: '人生若只如初见，何事秋风悲画扇。',                           source: '纳兰性德《木兰花令》',         mood: '婉约' },
  { line: '当时只道是寻常。',                                           source: '纳兰性德《浣溪沙》',           mood: '婉约' },
  { line: '此情可待成追忆，只是当时已惘然。',                           source: '李商隐《锦瑟》',               mood: '婉约' },
  { line: '红豆生南国，春来发几枝。愿君多采撷，此物最相思。',           source: '王维《相思》',                 mood: '婉约' },
  { line: '在天愿作比翼鸟，在地愿为连理枝。',                           source: '白居易《长恨歌》',             mood: '婉约' },
  { line: '两情若是久长时，又岂在朝朝暮暮。',                           source: '秦观《鹊桥仙》',               mood: '婉约' },
  { line: '衣带渐宽终不悔，为伊消得人憔悴。',                           source: '柳永《蝶恋花》',               mood: '婉约' },
  { line: '十年生死两茫茫，不思量，自难忘。',                           source: '苏轼《江城子》',               mood: '婉约' },
  { line: '相见时难别亦难，东风无力百花残。',                           source: '李商隐《无题》',               mood: '婉约' },
  { line: '春蚕到死丝方尽，蜡炬成灰泪始干。',                           source: '李商隐《无题》',               mood: '婉约' },
  { line: '思君如满月，夜夜减清辉。',                                   source: '张九龄《赋得自君之出矣》',     mood: '婉约' },
  { line: '换我心，为你心，始知相忆深。',                               source: '顾敻《诉衷情》',               mood: '婉约' },
  { line: '有美人兮，见之不忘。一日不见兮，思之如狂。',                 source: '司马相如《凤求凰》',           mood: '婉约' },
  { line: '此去经年，应是良辰好景虚设。',                               source: '柳永《雨霖铃》',               mood: '婉约' },
  { line: '执手相看泪眼，竟无语凝噎。',                                 source: '柳永《雨霖铃》',               mood: '婉约' },
  { line: '记得绿罗裙，处处怜芳草。',                                   source: '牛希济《生查子》',             mood: '婉约' },
  { line: '我住长江头，君住长江尾。日日思君不见君，共饮长江水。',       source: '李之仪《卜算子》',             mood: '婉约' },
  { line: '问世间，情是何物，直教生死相许。',                           source: '元好问《摸鱼儿·雁丘词》',      mood: '婉约' },
  { line: '此情无计可消除，才下眉头，却上心头。',                       source: '李清照《一剪梅》',             mood: '婉约' },
  { line: '凄凄惨惨戚戚，乍暖还寒时候，最难将息。',                     source: '李清照《声声慢》',             mood: '婉约' },
  { line: '花自飘零水自流。一种相思，两处闲愁。',                       source: '李清照《一剪梅》',             mood: '婉约' },
  { line: '蓦然回首处，无悔亦无忧。',                                   source: '宋词',                         mood: '婉约' },
  { line: '从此无心爱良夜，任他明月下西楼。',                           source: '李益《写情》',                 mood: '婉约' },
  { line: '落花人独立，微雨燕双飞。',                                   source: '晏几道《临江仙》',             mood: '婉约' },
  { line: '记得小苹初见，两重心字罗衣。',                               source: '晏几道《临江仙》',             mood: '婉约' },
  { line: '当时明月在，曾照彩云归。',                                   source: '晏几道《临江仙》',             mood: '婉约' },
  { line: '昔我往矣，杨柳依依。今我来思，雨雪霏霏。',                   source: '《诗经·小雅·采薇》',           mood: '婉约' },
  { line: '蒹葭苍苍，白露为霜。所谓伊人，在水一方。',                   source: '《诗经·秦风·蒹葭》',           mood: '婉约' },
];

// ---- Spring (立春至立夏) ----
const VERSES_SPRING = [
  { line: '春水碧于天，画船听雨眠。',                                   source: '韦庄《菩萨蛮》',               mood: '春日' },
  { line: '小楼一夜听春雨，深巷明朝卖杏花。',                           source: '陆游《临安春雨初霁》',         mood: '春日' },
  { line: '沾衣欲湿杏花雨，吹面不寒杨柳风。',                           source: '志南《绝句》',                 mood: '春日' },
  { line: '春日游，杏花吹满头。',                                       source: '韦庄《思帝乡》',               mood: '春日' },
  { line: '等闲识得东风面，万紫千红总是春。',                           source: '朱熹《春日》',                 mood: '春日' },
  { line: '人间四月芳菲尽，山寺桃花始盛开。',                           source: '白居易《大林寺桃花》',         mood: '春日' },
  { line: '碧玉妆成一树高，万条垂下绿丝绦。',                           source: '贺知章《咏柳》',               mood: '春日' },
  { line: '迟日江山丽，春风花草香。',                                   source: '杜甫《绝句》',                 mood: '春日' },
  { line: '好雨知时节，当春乃发生。',                                   source: '杜甫《春夜喜雨》',             mood: '春日' },
  { line: '随风潜入夜，润物细无声。',                                   source: '杜甫《春夜喜雨》',             mood: '春日' },
  { line: '春风又绿江南岸，明月何时照我还。',                           source: '王安石《泊船瓜洲》',           mood: '春日' },
  { line: '竹外桃花三两枝，春江水暖鸭先知。',                           source: '苏轼《惠崇春江晚景》',         mood: '春日' },
  { line: '春色满园关不住，一枝红杏出墙来。',                           source: '叶绍翁《游园不值》',           mood: '春日' },
  { line: '桃之夭夭，灼灼其华。',                                       source: '《诗经·桃夭》',                mood: '春日' },
  { line: '春眠不觉晓，处处闻啼鸟。',                                   source: '孟浩然《春晓》',               mood: '春日' },
  { line: '夜来风雨声，花落知多少。',                                   source: '孟浩然《春晓》',               mood: '春日' },
  { line: '燕子来时新社，梨花落后清明。',                               source: '晏殊《破阵子》',               mood: '春日' },
  { line: '梨花院落溶溶月，柳絮池塘淡淡风。',                           source: '晏殊《寓意》',                 mood: '春日' },
  { line: '池塘生春草，园柳变鸣禽。',                                   source: '谢灵运《登池上楼》',           mood: '春日' },
  { line: '春潮带雨晚来急，野渡无人舟自横。',                           source: '韦应物《滁州西涧》',           mood: '春日' },
  { line: '红杏枝头春意闹。',                                           source: '宋祁《玉楼春》',               mood: '春日' },
  { line: '草长莺飞二月天，拂堤杨柳醉春烟。',                           source: '高鼎《村居》',                 mood: '春日' },
  { line: '黄四娘家花满蹊，千朵万朵压枝低。',                           source: '杜甫《江畔独步寻花》',         mood: '春日' },
  { line: '云破月来花弄影。',                                           source: '张先《天仙子》',               mood: '春日' },
  { line: '试问卷帘人，却道海棠依旧。知否，知否？应是绿肥红瘦。',       source: '李清照《如梦令》',             mood: '春日' },
  { line: '一夜雨声花有泪，万家灯火月无情。',                           source: '清·查慎行',                    mood: '春日' },
  { line: '林花谢了春红，太匆匆。',                                     source: '李煜《相见欢》',               mood: '春日' },
  { line: '芳草萋萋鹦鹉洲。',                                           source: '崔颢《黄鹤楼》',               mood: '春日' },
  { line: '杨柳青青着地垂，杨花漫漫搅天飞。',                           source: '隋·无名氏',                    mood: '春日' },
  { line: '春风桃李花开日，秋雨梧桐叶落时。',                           source: '白居易《长恨歌》',             mood: '春日' },
];

// ---- Summer (立夏至立秋) ----
const VERSES_SUMMER = [
  { line: '接天莲叶无穷碧，映日荷花别样红。',                           source: '杨万里《晓出净慈寺送林子方》', mood: '夏日' },
  { line: '小荷才露尖尖角，早有蜻蜓立上头。',                           source: '杨万里《小池》',               mood: '夏日' },
  { line: '泉眼无声惜细流，树阴照水爱晴柔。',                           source: '杨万里《小池》',               mood: '夏日' },
  { line: '绿树阴浓夏日长，楼台倒影入池塘。',                           source: '高骈《山亭夏日》',             mood: '夏日' },
  { line: '水晶帘动微风起，满架蔷薇一院香。',                           source: '高骈《山亭夏日》',             mood: '夏日' },
  { line: '黑云翻墨未遮山，白雨跳珠乱入船。',                           source: '苏轼《六月二十七日望湖楼醉书》', mood: '夏日' },
  { line: '荷风送香气，竹露滴清响。',                                   source: '孟浩然《夏日南亭怀辛大》',     mood: '夏日' },
  { line: '深居俯夹城，春去夏犹清。',                                   source: '李商隐《晚晴》',               mood: '夏日' },
  { line: '小扇引微凉，悠悠夏日长。',                                   source: '清·顾太清',                    mood: '夏日' },
  { line: '梅子留酸软齿牙，芭蕉分绿与窗纱。',                           source: '杨万里《闲居初夏午睡起》',     mood: '夏日' },
  { line: '日长篱落无人过，惟有蜻蜓蛱蝶飞。',                           source: '范成大《四时田园杂兴》',       mood: '夏日' },
  { line: '稻花香里说丰年，听取蛙声一片。',                             source: '辛弃疾《西江月·夜行黄沙道中》', mood: '夏日' },
  { line: '七八个星天外，两三点雨山前。',                               source: '辛弃疾《西江月·夜行黄沙道中》', mood: '夏日' },
  { line: '明月别枝惊鹊，清风半夜鸣蝉。',                               source: '辛弃疾《西江月·夜行黄沙道中》', mood: '夏日' },
  { line: '过雨荷花满院香，沉李浮瓜冰雪凉。',                           source: '李重元《忆王孙·夏词》',        mood: '夏日' },
  { line: '荷叶罗裙一色裁，芙蓉向脸两边开。',                           source: '王昌龄《采莲曲》',             mood: '夏日' },
  { line: '懒摇白羽扇，裸袒青林中。',                                   source: '李白《夏日山中》',             mood: '夏日' },
  { line: '柳条百尺拂银塘，且莫深青只浅黄。',                           source: '韩偓《夏日》',                 mood: '夏日' },
  { line: '相见无杂言，但道桑麻长。',                                   source: '陶渊明《归园田居》',           mood: '夏日' },
  { line: '采菊东篱下，悠然见南山。',                                   source: '陶渊明《饮酒》',               mood: '夏日' },
  { line: '清风明月本无价，近水远山皆有情。',                           source: '梁章钜联',                     mood: '夏日' },
  { line: '残云收夏暑，新雨带秋岚。',                                   source: '岑参《水亭送华阴王少府还县》', mood: '夏日' },
  { line: '清江一曲抱村流，长夏江村事事幽。',                           source: '杜甫《江村》',                 mood: '夏日' },
  { line: '昼出耘田夜绩麻，村庄儿女各当家。',                           source: '范成大《四时田园杂兴》',       mood: '夏日' },
  { line: '更深月色半人家，北斗阑干南斗斜。',                           source: '刘方平《月夜》',               mood: '夏日' },
  { line: '今夜偏知春气暖，虫声新透绿窗纱。',                           source: '刘方平《月夜》',               mood: '夏日' },
  { line: '风蒲猎猎小池塘，过雨荷花满院香。',                           source: '李重元《忆王孙》',             mood: '夏日' },
  { line: '一夕轻雷落万丝，霁光浮瓦碧参差。',                           source: '秦观《春日》',                 mood: '夏日' },
  { line: '夜热依然午热同，开门小立月明中。',                           source: '杨万里《夏夜追凉》',           mood: '夏日' },
  { line: '竹深树密虫鸣处，时有微凉不是风。',                           source: '杨万里《夏夜追凉》',           mood: '夏日' },
];

// ---- Autumn (立秋至立冬) ----
const VERSES_AUTUMN = [
  { line: '落霞与孤鹜齐飞，秋水共长天一色。',                           source: '王勃《滕王阁序》',             mood: '秋日' },
  { line: '晴空一鹤排云上，便引诗情到碧霄。',                           source: '刘禹锡《秋词》',               mood: '秋日' },
  { line: '自古逢秋悲寂寥，我言秋日胜春朝。',                           source: '刘禹锡《秋词》',               mood: '秋日' },
  { line: '空山新雨后，天气晚来秋。',                                   source: '王维《山居秋暝》',             mood: '秋日' },
  { line: '明月松间照，清泉石上流。',                                   source: '王维《山居秋暝》',             mood: '秋日' },
  { line: '银烛秋光冷画屏，轻罗小扇扑流萤。',                           source: '杜牧《秋夕》',                 mood: '秋日' },
  { line: '天阶夜色凉如水，卧看牵牛织女星。',                           source: '杜牧《秋夕》',                 mood: '秋日' },
  { line: '停车坐爱枫林晚，霜叶红于二月花。',                           source: '杜牧《山行》',                 mood: '秋日' },
  { line: '远上寒山石径斜，白云生处有人家。',                           source: '杜牧《山行》',                 mood: '秋日' },
  { line: '一叶落而知天下秋。',                                         source: '《淮南子》',                   mood: '秋日' },
  { line: '欲说还休，却道天凉好个秋。',                                 source: '辛弃疾《丑奴儿》',             mood: '秋日' },
  { line: '寒山转苍翠，秋水日潺湲。',                                   source: '王维《辋川闲居》',             mood: '秋日' },
  { line: '荷尽已无擎雨盖，菊残犹有傲霜枝。',                           source: '苏轼《赠刘景文》',             mood: '秋日' },
  { line: '一年好景君须记，最是橙黄橘绿时。',                           source: '苏轼《赠刘景文》',             mood: '秋日' },
  { line: '昨夜西风凋碧树，独上高楼，望尽天涯路。',                     source: '晏殊《蝶恋花》',               mood: '秋日' },
  { line: '梧桐更兼细雨，到黄昏，点点滴滴。',                           source: '李清照《声声慢》',             mood: '秋日' },
  { line: '秋风秋雨愁煞人。',                                           source: '秋瑾',                         mood: '秋日' },
  { line: '万里悲秋常作客，百年多病独登台。',                           source: '杜甫《登高》',                 mood: '秋日' },
  { line: '无边落木萧萧下，不尽长江滚滚来。',                           source: '杜甫《登高》',                 mood: '秋日' },
  { line: '塞下秋来风景异，衡阳雁去无留意。',                           source: '范仲淹《渔家傲》',             mood: '秋日' },
  { line: '蒹葭苍苍，白露为霜。',                                       source: '《诗经·秦风·蒹葭》',           mood: '秋日' },
  { line: '秋阴不散霜飞晚，留得枯荷听雨声。',                           source: '李商隐《宿骆氏亭寄怀崔雍崔衮》', mood: '秋日' },
  { line: '红藕香残玉簟秋。',                                           source: '李清照《一剪梅》',             mood: '秋日' },
  { line: '人生若只如初见，何事秋风悲画扇。',                           source: '纳兰性德《木兰花令》',         mood: '秋日' },
  { line: '碧云天，黄叶地，秋色连波，波上寒烟翠。',                     source: '范仲淹《苏幕遮》',             mood: '秋日' },
  { line: '山明水净夜来霜，数树深红出浅黄。',                           source: '刘禹锡《秋词》',               mood: '秋日' },
  { line: '空山松子落，幽人应未眠。',                                   source: '韦应物《秋夜寄丘员外》',       mood: '秋日' },
  { line: '风急天高猿啸哀，渚清沙白鸟飞回。',                           source: '杜甫《登高》',                 mood: '秋日' },
  { line: '寒蝉凄切，对长亭晚，骤雨初歇。',                             source: '柳永《雨霖铃》',               mood: '秋日' },
  { line: '一年一度秋风劲，不似春光，胜似春光。',                       source: '毛泽东《采桑子·重阳》',        mood: '秋日' },
];

// ---- Winter (立冬至立春) ----
const VERSES_WINTER = [
  { line: '晚来天欲雪，能饮一杯无。',                                   source: '白居易《问刘十九》',           mood: '冬日' },
  { line: '绿蚁新醅酒，红泥小火炉。',                                   source: '白居易《问刘十九》',           mood: '冬日' },
  { line: '墙角数枝梅，凌寒独自开。',                                   source: '王安石《梅花》',               mood: '冬日' },
  { line: '遥知不是雪，为有暗香来。',                                   source: '王安石《梅花》',               mood: '冬日' },
  { line: '疏影横斜水清浅，暗香浮动月黄昏。',                           source: '林逋《山园小梅》',             mood: '冬日' },
  { line: '千山鸟飞绝，万径人踪灭。',                                   source: '柳宗元《江雪》',               mood: '冬日' },
  { line: '孤舟蓑笠翁，独钓寒江雪。',                                   source: '柳宗元《江雪》',               mood: '冬日' },
  { line: '柴门闻犬吠，风雪夜归人。',                                   source: '刘长卿《逢雪宿芙蓉山主人》',   mood: '冬日' },
  { line: '日暮苍山远，天寒白屋贫。',                                   source: '刘长卿《逢雪宿芙蓉山主人》',   mood: '冬日' },
  { line: '北风卷地白草折，胡天八月即飞雪。',                           source: '岑参《白雪歌送武判官归京》',   mood: '冬日' },
  { line: '忽如一夜春风来，千树万树梨花开。',                           source: '岑参《白雪歌送武判官归京》',   mood: '冬日' },
  { line: '山舞银蛇，原驰蜡象，欲与天公试比高。',                       source: '毛泽东《沁园春·雪》',          mood: '冬日' },
  { line: '北国风光，千里冰封，万里雪飘。',                             source: '毛泽东《沁园春·雪》',          mood: '冬日' },
  { line: '不知庭霰今朝落，疑是林花昨夜开。',                           source: '宋之问《苑中遇雪应制》',       mood: '冬日' },
  { line: '寒雨连江夜入吴，平明送客楚山孤。',                           source: '王昌龄《芙蓉楼送辛渐》',       mood: '冬日' },
  { line: '梅须逊雪三分白，雪却输梅一段香。',                           source: '卢梅坡《雪梅》',               mood: '冬日' },
  { line: '已是悬崖百丈冰，犹有花枝俏。',                               source: '毛泽东《卜算子·咏梅》',        mood: '冬日' },
  { line: '风雨送春归，飞雪迎春到。',                                   source: '毛泽东《卜算子·咏梅》',        mood: '冬日' },
  { line: '俏也不争春，只把春来报。',                                   source: '毛泽东《卜算子·咏梅》',        mood: '冬日' },
  { line: '冬尽今宵促，年开明日长。',                                   source: '董思恭《除夜》',               mood: '冬日' },
  { line: '寒夜客来茶当酒，竹炉汤沸火初红。',                           source: '杜耒《寻隐者不遇》',           mood: '冬日' },
  { line: '寻常一样窗前月，才有梅花便不同。',                           source: '杜耒《寒夜》',                 mood: '冬日' },
  { line: '欲渡黄河冰塞川，将登太行雪满山。',                           source: '李白《行路难》',               mood: '冬日' },
  { line: '燕山雪花大如席，片片吹落轩辕台。',                           source: '李白《北风行》',               mood: '冬日' },
  { line: '夜深知雪重，时闻折竹声。',                                   source: '白居易《夜雪》',               mood: '冬日' },
  { line: '已讶衾枕冷，复见窗户明。',                                   source: '白居易《夜雪》',               mood: '冬日' },
  { line: '冰雪林中著此身，不同桃李混芳尘。',                           source: '王冕《白梅》',                 mood: '冬日' },
  { line: '云横秦岭家何在？雪拥蓝关马不前。',                           source: '韩愈《左迁至蓝关示侄孙湘》',   mood: '冬日' },
  { line: '溪深难受雪，山冻不流云。',                                   source: '洪升《雪望》',                 mood: '冬日' },
  { line: '岁暮阴阳催短景，天涯霜雪霁寒宵。',                           source: '杜甫《阁夜》',                 mood: '冬日' },
];

// ---- Morning (5:00 ~ 10:00) ----
const VERSES_MORNING = [
  { line: '春眠不觉晓，处处闻啼鸟。',                                   source: '孟浩然《春晓》',               mood: '清晨' },
  { line: '朝辞白帝彩云间，千里江陵一日还。',                           source: '李白《早发白帝城》',           mood: '清晨' },
  { line: '东边日出西边雨，道是无晴却有晴。',                           source: '刘禹锡《竹枝词》',             mood: '清晨' },
  { line: '日出江花红胜火，春来江水绿如蓝。',                           source: '白居易《忆江南》',             mood: '清晨' },
  { line: '清晨入古寺，初日照高林。',                                   source: '常建《题破山寺后禅院》',       mood: '清晨' },
  { line: '曲径通幽处，禅房花木深。',                                   source: '常建《题破山寺后禅院》',       mood: '清晨' },
  { line: '山光悦鸟性，潭影空人心。',                                   source: '常建《题破山寺后禅院》',       mood: '清晨' },
  { line: '渭城朝雨浥轻尘，客舍青青柳色新。',                           source: '王维《送元二使安西》',         mood: '清晨' },
  { line: '鸡声茅店月，人迹板桥霜。',                                   source: '温庭筠《商山早行》',           mood: '清晨' },
  { line: '晨兴理荒秽，带月荷锄归。',                                   source: '陶渊明《归园田居》',           mood: '清晨' },
  { line: '一年之计在于春，一日之计在于晨。',                           source: '南朝·萧绎',                    mood: '清晨' },
  { line: '雨后烟景绿，晴天散馀霞。',                                   source: '李白《落日忆山中》',           mood: '清晨' },
  { line: '朝看水东流，暮看日西坠。',                                   source: '《增广贤文》',                 mood: '清晨' },
  { line: '日日新，又日新。',                                           source: '《大学》',                     mood: '清晨' },
  { line: '今朝有酒今朝醉，明日愁来明日愁。',                           source: '罗隐《自遣》',                 mood: '清晨' },
];

// ---- Evening / dusk (15:00 ~ 19:00) ----
const VERSES_DUSK = [
  { line: '夕阳无限好，只是近黄昏。',                                   source: '李商隐《登乐游原》',           mood: '黄昏' },
  { line: '向晚意不适，驱车登古原。',                                   source: '李商隐《登乐游原》',           mood: '黄昏' },
  { line: '长河落日圆，大漠孤烟直。',                                   source: '王维《使至塞上》',             mood: '黄昏' },
  { line: '日暮乡关何处是？烟波江上使人愁。',                           source: '崔颢《黄鹤楼》',               mood: '黄昏' },
  { line: '众鸟高飞尽，孤云独去闲。',                                   source: '李白《独坐敬亭山》',           mood: '黄昏' },
  { line: '相看两不厌，只有敬亭山。',                                   source: '李白《独坐敬亭山》',           mood: '黄昏' },
  { line: '渡头余落日，墟里上孤烟。',                                   source: '王维《辋川闲居赠裴秀才迪》',   mood: '黄昏' },
  { line: '荷笠带斜阳，青山独归远。',                                   source: '刘长卿《送灵澈上人》',         mood: '黄昏' },
  { line: '苍山如海，残阳如血。',                                       source: '毛泽东《忆秦娥·娄山关》',      mood: '黄昏' },
  { line: '山映斜阳天接水，芳草无情，更在斜阳外。',                     source: '范仲淹《苏幕遮》',             mood: '黄昏' },
  { line: '夕阳楼上山重叠，未抵闲愁一倍多。',                           source: '李商隐《夕阳楼》',             mood: '黄昏' },
  { line: '夕阳箫鼓几船归？',                                           source: '春江花月夜',                   mood: '黄昏' },
  { line: '残阳如血，半江瑟瑟半江红。',                                 source: '白居易《暮江吟》',             mood: '黄昏' },
  { line: '一道残阳铺水中，半江瑟瑟半江红。',                           source: '白居易《暮江吟》',             mood: '黄昏' },
  { line: '可怜九月初三夜，露似真珠月似弓。',                           source: '白居易《暮江吟》',             mood: '黄昏' },
  { line: '青山依旧在，几度夕阳红。',                                   source: '杨慎《临江仙》',               mood: '黄昏' },
  { line: '落日熔金，暮云合璧，人在何处？',                             source: '李清照《永遇乐》',             mood: '黄昏' },
  { line: '微雨过，小荷翻，榴花开欲然。',                               source: '苏轼《阮郎归》',               mood: '黄昏' },
  { line: '池上碧苔三四点，叶底黄鹂一两声。日长飞絮轻。',               source: '晏殊《破阵子》',               mood: '黄昏' },
];

// ---- Night (19:00 ~ next 5:00) ----
const VERSES_NIGHT = [
  { line: '海上生明月，天涯共此时。',                                   source: '张九龄《望月怀远》',           mood: '夜色' },
  { line: '人闲桂花落，夜静春山空。',                                   source: '王维《鸟鸣涧》',               mood: '夜色' },
  { line: '醉后不知天在水，满船清梦压星河。',                           source: '唐温如《题龙阳县青草湖》',     mood: '夜色' },
  { line: '掬水月在手，弄花香满衣。',                                   source: '于良史《春山夜月》',           mood: '夜色' },
  { line: '床前明月光，疑是地上霜。',                                   source: '李白《静夜思》',               mood: '夜色' },
  { line: '举头望明月，低头思故乡。',                                   source: '李白《静夜思》',               mood: '夜色' },
  { line: '今人不见古时月，今月曾经照古人。',                           source: '李白《把酒问月》',             mood: '夜色' },
  { line: '月落乌啼霜满天，江枫渔火对愁眠。',                           source: '张继《枫桥夜泊》',             mood: '夜色' },
  { line: '姑苏城外寒山寺，夜半钟声到客船。',                           source: '张继《枫桥夜泊》',             mood: '夜色' },
  { line: '春江潮水连海平，海上明月共潮生。',                           source: '张若虚《春江花月夜》',         mood: '夜色' },
  { line: '江畔何人初见月？江月何年初照人？',                           source: '张若虚《春江花月夜》',         mood: '夜色' },
  { line: '人生代代无穷已，江月年年望相似。',                           source: '张若虚《春江花月夜》',         mood: '夜色' },
  { line: '人有悲欢离合，月有阴晴圆缺，此事古难全。',                   source: '苏轼《水调歌头》',             mood: '夜色' },
  { line: '但愿人长久，千里共婵娟。',                                   source: '苏轼《水调歌头》',             mood: '夜色' },
  { line: '明月几时有？把酒问青天。',                                   source: '苏轼《水调歌头》',             mood: '夜色' },
  { line: '深林人不知，明月来相照。',                                   source: '王维《竹里馆》',               mood: '夜色' },
  { line: '独坐幽篁里，弹琴复长啸。',                                   source: '王维《竹里馆》',               mood: '夜色' },
  { line: '银烛秋光冷画屏，轻罗小扇扑流萤。',                           source: '杜牧《秋夕》',                 mood: '夜色' },
  { line: '今夜月明人尽望，不知秋思落谁家。',                           source: '王建《十五夜望月》',           mood: '夜色' },
  { line: '何夜无月？何处无竹柏？但少闲人如吾两人者耳。',               source: '苏轼《记承天寺夜游》',         mood: '夜色' },
  { line: '庭下如积水空明，水中藻、荇交横，盖竹柏影也。',               source: '苏轼《记承天寺夜游》',         mood: '夜色' },
  { line: '星垂平野阔，月涌大江流。',                                   source: '杜甫《旅夜书怀》',             mood: '夜色' },
  { line: '今夜鄜州月，闺中只独看。',                                   source: '杜甫《月夜》',                 mood: '夜色' },
  { line: '凉风起天末，君子意如何。',                                   source: '杜甫《天末怀李白》',           mood: '夜色' },
  { line: '银汉迢迢暗度。',                                             source: '秦观《鹊桥仙》',               mood: '夜色' },
  { line: '寒蝉凄切，对长亭晚。',                                       source: '柳永《雨霖铃》',               mood: '夜色' },
  { line: '今宵酒醒何处？杨柳岸，晓风残月。',                           source: '柳永《雨霖铃》',               mood: '夜色' },
  { line: '小山重叠金明灭，鬓云欲度香腮雪。',                           source: '温庭筠《菩萨蛮》',             mood: '夜色' },
  { line: '春花秋月何时了？往事知多少。',                               source: '李煜《虞美人》',               mood: '夜色' },
  { line: '问君能有几多愁？恰似一江春水向东流。',                       source: '李煜《虞美人》',               mood: '夜色' },
];

// ---- Festivals (lunar / solar) ----
const VERSES_FESTIVAL = {
  // 春节（农历正月初一前后 — 公历常落在 1月21日 ~ 2月20日，按公历近似匹配）
  springFestival: [
    { line: '爆竹声中一岁除，春风送暖入屠苏。',                         source: '王安石《元日》',               mood: '新春' },
    { line: '千门万户曈曈日，总把新桃换旧符。',                         source: '王安石《元日》',               mood: '新春' },
    { line: '一年滴尽莲花漏，碧井屠苏沉冻酒。',                         source: '毛滂《玉楼春·己卯岁元日》',    mood: '新春' },
  ],
  // 元宵（农历正月十五）
  lantern: [
    { line: '众里寻他千百度，蓦然回首，那人却在，灯火阑珊处。',         source: '辛弃疾《青玉案·元夕》',        mood: '元宵' },
    { line: '东风夜放花千树，更吹落、星如雨。',                         source: '辛弃疾《青玉案·元夕》',        mood: '元宵' },
    { line: '去年元夜时，花市灯如昼。',                                 source: '欧阳修《生查子·元夕》',        mood: '元宵' },
  ],
  // 清明（公历 4月4日 ~ 4月6日）
  qingming: [
    { line: '清明时节雨纷纷，路上行人欲断魂。',                         source: '杜牧《清明》',                 mood: '清明' },
    { line: '借问酒家何处有？牧童遥指杏花村。',                         source: '杜牧《清明》',                 mood: '清明' },
    { line: '梨花风起正清明，游子寻春半出城。',                         source: '吴惟信《苏堤清明即事》',       mood: '清明' },
  ],
  // 端午（农历五月初五）
  dragonBoat: [
    { line: '五月榴花妖艳烘，绿杨带雨垂垂重。',                         source: '欧阳修《渔家傲》',             mood: '端午' },
    { line: '彩线轻缠红玉臂，小符斜挂绿云鬟。',                         source: '苏轼《浣溪沙·端午》',          mood: '端午' },
    { line: '节分端午自谁言，万古传闻为屈原。',                         source: '文秀《端午》',                 mood: '端午' },
  ],
  // 七夕（农历七月初七）
  qixi: [
    { line: '两情若是久长时，又岂在朝朝暮暮。',                         source: '秦观《鹊桥仙》',               mood: '七夕' },
    { line: '纤云弄巧，飞星传恨，银汉迢迢暗度。',                       source: '秦观《鹊桥仙》',               mood: '七夕' },
    { line: '柔情似水，佳期如梦，忍顾鹊桥归路。',                       source: '秦观《鹊桥仙》',               mood: '七夕' },
  ],
  // 中秋（农历八月十五）
  midAutumn: [
    { line: '但愿人长久，千里共婵娟。',                                 source: '苏轼《水调歌头》',             mood: '中秋' },
    { line: '明月几时有？把酒问青天。',                                 source: '苏轼《水调歌头》',             mood: '中秋' },
    { line: '今夜月明人尽望，不知秋思落谁家。',                         source: '王建《十五夜望月》',           mood: '中秋' },
    { line: '海上生明月，天涯共此时。',                                 source: '张九龄《望月怀远》',           mood: '中秋' },
  ],
  // 重阳（农历九月初九）
  doubleNinth: [
    { line: '独在异乡为异客，每逢佳节倍思亲。',                         source: '王维《九月九日忆山东兄弟》',   mood: '重阳' },
    { line: '遥知兄弟登高处，遍插茱萸少一人。',                         source: '王维《九月九日忆山东兄弟》',   mood: '重阳' },
    { line: '人生易老天难老，岁岁重阳。',                               source: '毛泽东《采桑子·重阳》',        mood: '重阳' },
  ],
  // 除夕（农历腊月最后一天 — 公历常落在 1月20日 ~ 2月19日）
  newYearEve: [
    { line: '一年将尽夜，万里未归人。',                                 source: '戴叔伦《除夜宿石头驿》',       mood: '除夕' },
    { line: '今夕为何夕，他乡说故乡。',                                 source: '袁凯《客中除夕》',             mood: '除夕' },
    { line: '故岁今宵尽，新年明旦来。',                                 source: '李世民《除夜》',               mood: '除夕' },
  ],
};

// ---- 24 Solar terms (节气) ----
const VERSES_SOLAR_TERM = {
  lichun:      [{ line: '律回岁晚冰霜少，春到人间草木知。',           source: '张栻《立春偶成》',             mood: '立春' }],
  yushui:      [{ line: '春雨断桥人不度，小舟撑出柳阴来。',           source: '徐俯《春游湖》',               mood: '雨水' }],
  jingzhe:     [{ line: '微雨众卉新，一雷惊蛰始。',                   source: '韦应物《观田家》',             mood: '惊蛰' }],
  chunfen:     [{ line: '仲春初四日，春色正中分。',                   source: '徐铉《春分日》',               mood: '春分' }],
  qingmingTerm:[{ line: '清明时节雨纷纷，路上行人欲断魂。',           source: '杜牧《清明》',                 mood: '清明' }],
  guyu:        [{ line: '谷雨春光晓，山川黛色青。',                   source: '朱槔《谷雨》',                 mood: '谷雨' }],
  lixia:       [{ line: '绿阴铺野换新光，薰风初昼日初长。',           source: '宋·赵友直《立夏》',            mood: '立夏' }],
  xiaoman:     [{ line: '小满气全时，如何靡草衰。',                   source: '元稹《咏廿四气诗·小满》',      mood: '小满' }],
  mangzhong:   [{ line: '时雨及芒种，四野皆插秧。',                   source: '陆游《时雨》',                 mood: '芒种' }],
  xiazhi:      [{ line: '昼晷已云极，宵漏自此长。',                   source: '韦应物《夏至避暑北池》',       mood: '夏至' }],
  xiaoshu:     [{ line: '荷风送香气，竹露滴清响。',                   source: '孟浩然《夏日南亭怀辛大》',     mood: '小暑' }],
  dashu:       [{ line: '何以销烦暑，端居一院中。',                   source: '白居易《销暑》',               mood: '大暑' }],
  liqiu:       [{ line: '一叶惊心绪，新凉感岁华。',                   source: '宋·刘翰《立秋》',              mood: '立秋' }],
  chushu:      [{ line: '处暑无三日，新凉直万金。',                   source: '苏泂《长江二首》',             mood: '处暑' }],
  bailu:       [{ line: '蒹葭苍苍，白露为霜。',                       source: '《诗经·秦风·蒹葭》',           mood: '白露' }],
  qiufen:      [{ line: '秋分雷始收声，蛰虫坯户。',                   source: '《月令七十二候集解》',         mood: '秋分' }],
  hanlu:       [{ line: '寒露惊秋晚，朝看菊渐黄。',                   source: '元稹《咏廿四气诗·寒露》',      mood: '寒露' }],
  shuangjiang: [{ line: '霜降水返壑，风落木归山。',                   source: '白居易《岁晚》',               mood: '霜降' }],
  lidong:      [{ line: '冻笔新诗懒写，寒炉美酒时温。',               source: '李白《立冬》',                 mood: '立冬' }],
  xiaoxue:     [{ line: '夜深知雪重，时闻折竹声。',                   source: '白居易《夜雪》',               mood: '小雪' }],
  daxue:       [{ line: '六出飞花入户时，坐看青竹变琼枝。',           source: '高骈《对雪》',                 mood: '大雪' }],
  dongzhi:     [{ line: '天时人事日相催，冬至阳生春又来。',           source: '杜甫《小至》',                 mood: '冬至' }],
  xiaohan:     [{ line: '小寒连大吕，欢鹊垒新巢。',                   source: '元稹《咏廿四气诗·小寒》',      mood: '小寒' }],
  dahan:       [{ line: '大寒雪未消，闭户不能出。',                   source: '宋·邵雍',                      mood: '大寒' }],
};

// ---- Precise solar term dates (2024–2030) ----
// Each entry: 'YYYY-MM-DD'. Indexed by solar term key.
// Source: National Astronomical Observatory of China (rounded to local CST date).
const SOLAR_TERM_DATES = {
  lichun:      ['2024-02-04', '2025-02-03', '2026-02-04', '2027-02-04', '2028-02-04', '2029-02-03', '2030-02-04'],
  yushui:      ['2024-02-19', '2025-02-18', '2026-02-18', '2027-02-19', '2028-02-19', '2029-02-18', '2030-02-18'],
  jingzhe:     ['2024-03-05', '2025-03-05', '2026-03-05', '2027-03-06', '2028-03-05', '2029-03-05', '2030-03-05'],
  chunfen:     ['2024-03-20', '2025-03-20', '2026-03-20', '2027-03-21', '2028-03-20', '2029-03-20', '2030-03-20'],
  qingmingTerm:['2024-04-04', '2025-04-04', '2026-04-05', '2027-04-05', '2028-04-04', '2029-04-04', '2030-04-05'],
  guyu:        ['2024-04-19', '2025-04-20', '2026-04-20', '2027-04-20', '2028-04-19', '2029-04-20', '2030-04-20'],
  lixia:       ['2024-05-05', '2025-05-05', '2026-05-05', '2027-05-06', '2028-05-05', '2029-05-05', '2030-05-05'],
  xiaoman:     ['2024-05-20', '2025-05-21', '2026-05-21', '2027-05-21', '2028-05-20', '2029-05-20', '2030-05-21'],
  mangzhong:   ['2024-06-05', '2025-06-05', '2026-06-05', '2027-06-06', '2028-06-05', '2029-06-05', '2030-06-05'],
  xiazhi:      ['2024-06-21', '2025-06-21', '2026-06-21', '2027-06-21', '2028-06-21', '2029-06-21', '2030-06-21'],
  xiaoshu:     ['2024-07-06', '2025-07-07', '2026-07-07', '2027-07-07', '2028-07-06', '2029-07-06', '2030-07-07'],
  dashu:       ['2024-07-22', '2025-07-22', '2026-07-23', '2027-07-23', '2028-07-22', '2029-07-22', '2030-07-23'],
  liqiu:       ['2024-08-07', '2025-08-07', '2026-08-07', '2027-08-08', '2028-08-07', '2029-08-07', '2030-08-07'],
  chushu:      ['2024-08-22', '2025-08-23', '2026-08-23', '2027-08-23', '2028-08-22', '2029-08-22', '2030-08-23'],
  bailu:       ['2024-09-07', '2025-09-07', '2026-09-07', '2027-09-08', '2028-09-07', '2029-09-07', '2030-09-07'],
  qiufen:      ['2024-09-22', '2025-09-23', '2026-09-23', '2027-09-23', '2028-09-22', '2029-09-22', '2030-09-23'],
  hanlu:       ['2024-10-08', '2025-10-08', '2026-10-08', '2027-10-08', '2028-10-08', '2029-10-08', '2030-10-08'],
  shuangjiang: ['2024-10-23', '2025-10-23', '2026-10-23', '2027-10-23', '2028-10-23', '2029-10-23', '2030-10-23'],
  lidong:      ['2024-11-07', '2025-11-07', '2026-11-07', '2027-11-08', '2028-11-07', '2029-11-07', '2030-11-07'],
  xiaoxue:     ['2024-11-22', '2025-11-22', '2026-11-22', '2027-11-22', '2028-11-22', '2029-11-22', '2030-11-22'],
  daxue:       ['2024-12-06', '2025-12-07', '2026-12-07', '2027-12-07', '2028-12-06', '2029-12-07', '2030-12-07'],
  dongzhi:     ['2024-12-21', '2025-12-21', '2026-12-22', '2027-12-22', '2028-12-21', '2029-12-21', '2030-12-22'],
  xiaohan:     ['2025-01-05', '2026-01-05', '2027-01-05', '2028-01-06', '2029-01-05', '2030-01-05'],
  dahan:       ['2025-01-20', '2026-01-20', '2027-01-20', '2028-01-20', '2029-01-19', '2030-01-20'],
};

// ---- Lunar festival dates (2024–2030, gregorian) ----
// Source: official lunar calendar conversions.
const LUNAR_FESTIVAL_DATES = {
  springFestival: ['2024-02-10', '2025-01-29', '2026-02-17', '2027-02-06', '2028-01-26', '2029-02-13', '2030-02-03'],
  lantern:        ['2024-02-24', '2025-02-12', '2026-03-03', '2027-02-20', '2028-02-09', '2029-02-27', '2030-02-17'],
  dragonBoat:     ['2024-06-10', '2025-05-31', '2026-06-19', '2027-06-09', '2028-05-28', '2029-06-16', '2030-06-05'],
  qixi:           ['2024-08-10', '2025-08-29', '2026-08-19', '2027-08-08', '2028-08-26', '2029-08-16', '2030-08-05'],
  midAutumn:      ['2024-09-17', '2025-10-06', '2026-09-25', '2027-09-15', '2028-10-03', '2029-09-22', '2030-09-12'],
  doubleNinth:    ['2024-10-11', '2025-10-29', '2026-10-19', '2027-10-08', '2028-10-26', '2029-10-15', '2030-10-05'],
  newYearEve:     ['2024-02-09', '2025-01-28', '2026-02-16', '2027-02-05', '2028-01-25', '2029-02-12', '2030-02-02'],
};

/**
 * formatDateKey() — returns 'YYYY-MM-DD' in local time
 */
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * matchFestival() — returns festival key if today matches a lunar festival
 */
function matchFestival(date) {
  const key = formatDateKey(date);
  for (const fest of Object.keys(LUNAR_FESTIVAL_DATES)) {
    if (LUNAR_FESTIVAL_DATES[fest].includes(key)) return fest;
  }
  return null;
}

/**
 * matchSolarTerm() — returns solar-term key if today is on (or 1 day after) a solar term
 */
function matchSolarTerm(date) {
  const todayKey = formatDateKey(date);
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = formatDateKey(yesterday);

  for (const term of Object.keys(SOLAR_TERM_DATES)) {
    const list = SOLAR_TERM_DATES[term];
    if (list.includes(todayKey) || list.includes(yesterdayKey)) return term;
  }
  return null;
}

/**
 * getSeason() — season by traditional solar terms (24 节气), aligned with classical poetry.
 *   spring: 立春 (lichun) → 立夏 前一日
 *   summer: 立夏 (lixia) → 立秋 前一日
 *   autumn: 立秋 (liqiu) → 立冬 前一日
 *   winter: 立冬 (lidong) → 次年立春 前一日
 *
 * Uses SOLAR_TERM_DATES (2024–2030) for accurate boundaries; falls back to month-based
 * approximation (立春≈2/4, 立夏≈5/5, 立秋≈8/7, 立冬≈11/7) for years outside the table.
 */
function getSeason(date) {
  const year = date.getFullYear();
  const todayKey = formatDateKey(date);

  // Helper: get the term boundary date (yyyy-mm-dd) for a given year, fallback if missing.
  function getTermDate(termKey, y, fallbackMonth, fallbackDay) {
    const list = SOLAR_TERM_DATES[termKey];
    if (list) {
      const hit = list.find(d => d.startsWith(String(y) + '-'));
      if (hit) return hit;
    }
    // Fallback approximation
    const mm = String(fallbackMonth).padStart(2, '0');
    const dd = String(fallbackDay).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  const lichun = getTermDate('lichun', year, 2, 4);
  const lixia  = getTermDate('lixia',  year, 5, 5);
  const liqiu  = getTermDate('liqiu',  year, 8, 7);
  const lidong = getTermDate('lidong', year, 11, 7);

  if (todayKey < lichun) return 'winter';   // 立春前 → 仍属上一年的冬
  if (todayKey < lixia)  return 'spring';   // 立春 ~ 立夏前 → 春
  if (todayKey < liqiu)  return 'summer';   // 立夏 ~ 立秋前 → 夏
  if (todayKey < lidong) return 'autumn';   // 立秋 ~ 立冬前 → 秋
  return 'winter';                          // 立冬之后 → 冬
}

/**
 * getTimeOfDay() — morning / dusk / night (returns null in midday so season picks)
 */
function getTimeOfDay(date) {
  const h = date.getHours();
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 15 && h < 19) return 'dusk';
  if (h >= 19 || h < 5) return 'night';
  return null;
}

/**
 * pickFromBucket() — deterministic pick by date hash
 */
function pickFromBucket(bucket, date) {
  if (!bucket || !bucket.length) return null;
  const key = formatDateKey(date);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return bucket[Math.abs(hash) % bucket.length];
}

/* ----------------------------------------------------------------
   EXTRA CONTEXT BUCKETS — moon phase / tab mood / weekday vibe
   Zero-cost upgrades that read pure-math signals (date, weekday, hour)
   plus the open-tab count (already fetched elsewhere) to surface
   verses that resonate with the user's current moment.
   ---------------------------------------------------------------- */

// ---- Moon phases (8 buckets, ancient poets wrote each phase very differently) ----
const VERSES_MOON = {
  // 新月 — 月初一二，月色几乎不可见，空寂、思念、独立
  newMoon: [
    { line: '缺月挂疏桐，漏断人初静。',                                 source: '苏轼《卜算子·黄州定慧院寓居作》', mood: '新月' },
    { line: '惊鸿一瞥的相逢，是月牙落入心海的开端。',                   source: '宋词意境',                     mood: '新月' },
    { line: '月黑见渔灯，孤光一点萤。',                                 source: '查慎行《舟夜书所见》',         mood: '新月' },
    { line: '初月如弓未上弦，分明挂在碧霄边。',                         source: '李白意境',                     mood: '新月' },
  ],
  // 蛾眉月 — 初三至初七，纤细如眉，常入闺怨与思念
  crescent: [
    { line: '初月如美人，蛾眉淡扫秋。',                                 source: '宋词意境',                     mood: '蛾眉月' },
    { line: '云破月来花弄影。',                                         source: '张先《天仙子》',               mood: '蛾眉月' },
    { line: '梳洗罢，独倚望江楼。',                                     source: '温庭筠《望江南》',             mood: '蛾眉月' },
    { line: '可怜九月初三夜，露似真珠月似弓。',                         source: '白居易《暮江吟》',             mood: '蛾眉月' },
  ],
  // 上弦月 — 初八前后，半月，常入约定、相思、初遇
  firstQuarter: [
    { line: '月上柳梢头，人约黄昏后。',                                 source: '欧阳修《生查子》',             mood: '上弦月' },
    { line: '小山重叠金明灭，鬓云欲度香腮雪。',                         source: '温庭筠《菩萨蛮》',             mood: '上弦月' },
    { line: '半窗残月有谁知。',                                         source: '李清照',                       mood: '上弦月' },
    { line: '今宵剩把银釭照，犹恐相逢是梦中。',                         source: '晏几道《鹧鸪天》',             mood: '上弦月' },
  ],
  // 盈凸月 — 十一二，将圆未圆，期待之意
  waxingGibbous: [
    { line: '今夜偏知春气暖，虫声新透绿窗纱。',                         source: '刘方平《月夜》',               mood: '盈凸月' },
    { line: '更深月色半人家，北斗阑干南斗斜。',                         source: '刘方平《月夜》',               mood: '盈凸月' },
    { line: '深林人不知，明月来相照。',                                 source: '王维《竹里馆》',               mood: '盈凸月' },
    { line: '渐明帘幌，窗下明月正团圆。',                               source: '宋词意境',                     mood: '盈凸月' },
  ],
  // 满月 — 十五前后，团圆、怀远、千古绝唱皆在此
  fullMoon: [
    { line: '海上生明月，天涯共此时。',                                 source: '张九龄《望月怀远》',           mood: '满月' },
    { line: '但愿人长久，千里共婵娟。',                                 source: '苏轼《水调歌头》',             mood: '满月' },
    { line: '明月几时有？把酒问青天。',                                 source: '苏轼《水调歌头》',             mood: '满月' },
    { line: '今夜月明人尽望，不知秋思落谁家。',                         source: '王建《十五夜望月》',           mood: '满月' },
    { line: '春江潮水连海平，海上明月共潮生。',                         source: '张若虚《春江花月夜》',         mood: '满月' },
    { line: '人有悲欢离合，月有阴晴圆缺，此事古难全。',                 source: '苏轼《水调歌头》',             mood: '满月' },
    { line: '今人不见古时月，今月曾经照古人。',                         source: '李白《把酒问月》',             mood: '满月' },
    { line: '床前明月光，疑是地上霜。',                                 source: '李白《静夜思》',               mood: '满月' },
  ],
  // 亏凸月 — 十七十八，月色稍减，余韵悠长
  waningGibbous: [
    { line: '月落乌啼霜满天，江枫渔火对愁眠。',                         source: '张继《枫桥夜泊》',             mood: '亏凸月' },
    { line: '凉风起天末，君子意如何。',                                 source: '杜甫《天末怀李白》',           mood: '亏凸月' },
    { line: '何夜无月？何处无竹柏？但少闲人如吾两人者耳。',             source: '苏轼《记承天寺夜游》',         mood: '亏凸月' },
    { line: '当时明月在，曾照彩云归。',                                 source: '晏几道《临江仙》',             mood: '亏凸月' },
  ],
  // 下弦月 — 廿三前后，下半夜才升，孤清、晚景之感
  lastQuarter: [
    { line: '今宵酒醒何处？杨柳岸，晓风残月。',                         source: '柳永《雨霖铃》',               mood: '下弦月' },
    { line: '残月脸边明，别泪临清晓。',                                 source: '牛希济《生查子》',             mood: '下弦月' },
    { line: '杨柳岸晓风残月，此去经年。',                               source: '柳永《雨霖铃》',               mood: '下弦月' },
    { line: '人散后，一钩淡月天如水。',                                 source: '谢逸《千秋岁》',               mood: '下弦月' },
  ],
  // 残月 — 廿七至月末，月色将尽，仿佛旧梦将醒
  waningCrescent: [
    { line: '无言独上西楼，月如钩。',                                   source: '李煜《相见欢》',               mood: '残月' },
    { line: '寂寞梧桐深院锁清秋。',                                     source: '李煜《相见欢》',               mood: '残月' },
    { line: '残月色不改，高贤德常新。',                                 source: '李白意境',                     mood: '残月' },
    { line: '深院静，小庭空。断续寒砧断续风。',                         source: '李煜《捣练子令》',             mood: '残月' },
  ],
};

// ---- Tab mood (read from current open-tab count) ----
const VERSES_TABS = {
  // 0–3 个标签：极简、清空、出尘
  zen: [
    { line: '行到水穷处，坐看云起时。',                                 source: '王维《终南别业》',             mood: '清简' },
    { line: '心远地自偏。',                                             source: '陶渊明《饮酒》',               mood: '清简' },
    { line: '空山新雨后，天气晚来秋。',                                 source: '王维《山居秋暝》',             mood: '清简' },
    { line: '人闲桂花落，夜静春山空。',                                 source: '王维《鸟鸣涧》',               mood: '清简' },
    { line: '木末芙蓉花，山中发红萼。',                                 source: '王维《辛夷坞》',               mood: '清简' },
    { line: '独坐幽篁里，弹琴复长啸。',                                 source: '王维《竹里馆》',               mood: '清简' },
    { line: '采菊东篱下，悠然见南山。',                                 source: '陶渊明《饮酒》',               mood: '清简' },
    { line: '清风明月本无价，近水远山皆有情。',                         source: '梁章钜联',                     mood: '清简' },
  ],
  // 4–10 个：专注、源头活水之状
  focus: [
    { line: '问渠那得清如许？为有源头活水来。',                         source: '朱熹《观书有感》',             mood: '专注' },
    { line: '业精于勤，荒于嬉；行成于思，毁于随。',                     source: '韩愈《进学解》',               mood: '专注' },
    { line: '少壮不努力，老大徒伤悲。',                                 source: '《长歌行》',                   mood: '专注' },
    { line: '读书破万卷，下笔如有神。',                                 source: '杜甫《奉赠韦左丞丈二十二韵》', mood: '专注' },
    { line: '操千曲而后晓声，观千剑而后识器。',                         source: '刘勰《文心雕龙》',             mood: '专注' },
    { line: '宝剑锋从磨砺出，梅花香自苦寒来。',                         source: '《警世贤文》',                 mood: '专注' },
    { line: '不积跬步，无以至千里。',                                   source: '荀子《劝学》',                 mood: '专注' },
  ],
  // 11–25 个：繁忙，需要从容
  busy: [
    { line: '莫听穿林打叶声，何妨吟啸且徐行。',                         source: '苏轼《定风波》',               mood: '从容' },
    { line: '竹杖芒鞋轻胜马，谁怕？一蓑烟雨任平生。',                   source: '苏轼《定风波》',               mood: '从容' },
    { line: '回首向来萧瑟处，归去，也无风雨也无晴。',                   source: '苏轼《定风波》',               mood: '从容' },
    { line: '世事一场大梦，人生几度秋凉。',                             source: '苏轼《西江月》',               mood: '从容' },
    { line: '宠辱不惊，闲看庭前花开花落。',                             source: '陈继儒《幽窗小记》',           mood: '从容' },
    { line: '去留无意，漫随天外云卷云舒。',                             source: '陈继儒《幽窗小记》',           mood: '从容' },
    { line: '不以物喜，不以己悲。',                                     source: '范仲淹《岳阳楼记》',           mood: '从容' },
  ],
  // 26+ 个：信息焦虑，温柔提醒"返自然"
  overload: [
    { line: '长恨此身非我有，何时忘却营营。',                           source: '苏轼《临江仙》',               mood: '解忧' },
    { line: '久在樊笼里，复得返自然。',                                 source: '陶渊明《归园田居》',           mood: '解忧' },
    { line: '吾生也有涯，而知也无涯。',                                 source: '《庄子·养生主》',              mood: '解忧' },
    { line: '此心安处是吾乡。',                                         source: '苏轼《定风波》',               mood: '解忧' },
    { line: '万事到头都是梦，休休，明日黄花蝶也愁。',                   source: '苏轼《南乡子·重九涵辉楼呈徐君猷》', mood: '解忧' },
    { line: '是非成败转头空。青山依旧在，几度夕阳红。',                 source: '杨慎《临江仙》',               mood: '解忧' },
    { line: '小舟从此逝，江海寄余生。',                                 source: '苏轼《临江仙》',               mood: '解忧' },
    { line: '行到水穷处，坐看云起时。',                                 source: '王维《终南别业》',             mood: '解忧' },
  ],
};

// ---- Weekday vibes (rhythm of the work week) ----
const VERSES_WEEKDAY = {
  // 周一晨：振作、励志、希望
  mondayMorning: [
    { line: '莫道桑榆晚，为霞尚满天。',                                 source: '刘禹锡《酬乐天咏老见示》',     mood: '周一' },
    { line: '会当凌绝顶，一览众山小。',                                 source: '杜甫《望岳》',                 mood: '周一' },
    { line: '长风破浪会有时，直挂云帆济沧海。',                         source: '李白《行路难》',               mood: '周一' },
    { line: '雄关漫道真如铁，而今迈步从头越。',                         source: '毛泽东《忆秦娥·娄山关》',      mood: '周一' },
    { line: '一年之计在于春，一日之计在于晨。',                         source: '南朝·萧绎',                    mood: '周一' },
  ],
  // 周五暮：将休、放松、邀友共饮
  fridayEvening: [
    { line: '举杯邀明月，对影成三人。',                                 source: '李白《月下独酌》',             mood: '周五' },
    { line: '人生得意须尽欢，莫使金樽空对月。',                         source: '李白《将进酒》',               mood: '周五' },
    { line: '晚来天欲雪，能饮一杯无。',                                 source: '白居易《问刘十九》',           mood: '周五' },
    { line: '绿蚁新醅酒，红泥小火炉。',                                 source: '白居易《问刘十九》',           mood: '周五' },
    { line: '寒夜客来茶当酒，竹炉汤沸火初红。',                         source: '杜耒《寒夜》',                 mood: '周五' },
  ],
  // 周末晨：闲适、清晨慢生活
  weekendMorning: [
    { line: '晚年惟好静，万事不关心。',                                 source: '王维《酬张少府》',             mood: '周末' },
    { line: '采菊东篱下，悠然见南山。',                                 source: '陶渊明《饮酒》',               mood: '周末' },
    { line: '小园香径独徘徊。',                                         source: '晏殊《浣溪沙》',               mood: '周末' },
    { line: '偷得浮生半日闲。',                                         source: '李涉《题鹤林寺僧舍》',         mood: '周末' },
    { line: '春有百花秋有月，夏有凉风冬有雪。若无闲事挂心头，便是人间好时节。', source: '无门慧开禅师',          mood: '周末' },
  ],
  // 周日夜：周一焦虑前的告别，温柔抚慰
  sundayNight: [
    { line: '人生如梦，一尊还酹江月。',                                 source: '苏轼《念奴娇·赤壁怀古》',      mood: '周日夜' },
    { line: '夜阑风静縠纹平，小舟从此逝，江海寄余生。',                 source: '苏轼《临江仙》',               mood: '周日夜' },
    { line: '此心安处是吾乡。',                                         source: '苏轼《定风波》',               mood: '周日夜' },
    { line: '明月别枝惊鹊，清风半夜鸣蝉。',                             source: '辛弃疾《西江月》',             mood: '周日夜' },
  ],
};

/**
 * getMoonPhase() — pure-math moon phase from date.
 *
 * Synodic month = 29.5306 days. Reference new moon: 2000-01-06 18:14 UTC.
 * Returns one of 8 phase keys aligned with the VERSES_MOON buckets.
 */
function getMoonPhase(date) {
  // Reference new moon (UTC ms)
  const REF = Date.UTC(2000, 0, 6, 18, 14, 0);
  const SYNODIC = 29.530588853 * 24 * 60 * 60 * 1000;
  const elapsed = date.getTime() - REF;
  let frac = (elapsed % SYNODIC) / SYNODIC;
  if (frac < 0) frac += 1;

  // 8 phase boundaries (each ~3.69 days)
  if (frac < 0.0625 || frac >= 0.9375) return 'newMoon';
  if (frac < 0.1875) return 'crescent';
  if (frac < 0.3125) return 'firstQuarter';
  if (frac < 0.4375) return 'waxingGibbous';
  if (frac < 0.5625) return 'fullMoon';
  if (frac < 0.6875) return 'waningGibbous';
  if (frac < 0.8125) return 'lastQuarter';
  return 'waningCrescent';
}

/**
 * getTabMood() — derive a "mental tempo" key from the open-tab count.
 *   0–3   → zen      （清简）
 *   4–10  → focus    （专注）
 *   11–25 → busy     （从容）
 *   26+   → overload （解忧）
 */
function getTabMood(tabCount) {
  if (typeof tabCount !== 'number' || tabCount < 0) return null;
  if (tabCount <= 3)  return 'zen';
  if (tabCount <= 10) return 'focus';
  if (tabCount <= 25) return 'busy';
  return 'overload';
}

/**
 * getWeekdayVibe() — return a key when this is a "signature moment" of the week.
 *   Mon 5:00–10:00  → mondayMorning
 *   Fri 17:00–22:00 → fridayEvening
 *   Sat/Sun 6:00–11:00 → weekendMorning
 *   Sun 20:00–next 1:00 → sundayNight
 * Otherwise returns null so other dimensions take over.
 */
function getWeekdayVibe(date) {
  const day = date.getDay(); // 0 Sun, 1 Mon, ... 5 Fri, 6 Sat
  const h = date.getHours();
  if (day === 1 && h >= 5 && h < 10)            return 'mondayMorning';
  if (day === 5 && h >= 17 && h < 22)           return 'fridayEvening';
  if ((day === 6 || day === 0) && h >= 6 && h < 11) return 'weekendMorning';
  if (day === 0 && (h >= 20 || h < 1))          return 'sundayNight';
  return null;
}

/**
 * getDailyVerse() — context-aware picker.
 *
 * Priority: festival > solar term > moon phase > tab mood > weekday vibe
 *           > time-of-day > season > romantic fallback.
 *
 * Within the chosen bucket, the date hash makes the pick deterministic
 * (same calendar day → same line, no flicker on re-open).
 *
 * Notes on prioritization:
 *   - Festivals/solar terms are explicit cultural anchors (highest).
 *   - Moon phase changes every ~3–4 days, giving a fresh "celestial mood".
 *   - Tab mood reflects the user's *current* mental state (Tab Out's soul);
 *     it sits above weekday/time so the verse can softly comment on the moment.
 *   - Weekday vibe only triggers in signature windows (Mon morning, Fri evening,
 *     weekend morning, Sun night) so it doesn't dominate the rotation.
 */
function getDailyVerse(date = new Date(), tabCount = null) {
  // 1. Festival
  const fest = matchFestival(date);
  if (fest && VERSES_FESTIVAL[fest]) {
    const v = pickFromBucket(VERSES_FESTIVAL[fest], date);
    if (v) return v;
  }

  // 2. Solar term
  const term = matchSolarTerm(date);
  if (term && VERSES_SOLAR_TERM[term]) {
    const v = pickFromBucket(VERSES_SOLAR_TERM[term], date);
    if (v) return v;
  }

  // 3. Moon phase
  const moon = getMoonPhase(date);
  if (moon && VERSES_MOON[moon]) {
    const v = pickFromBucket(VERSES_MOON[moon], date);
    if (v) return v;
  }

  // 4. Tab mood (only when we have a real count)
  const tabKey = getTabMood(tabCount);
  if (tabKey && VERSES_TABS[tabKey]) {
    const v = pickFromBucket(VERSES_TABS[tabKey], date);
    if (v) return v;
  }

  // 5. Weekday vibe (only in signature windows)
  const vibe = getWeekdayVibe(date);
  if (vibe && VERSES_WEEKDAY[vibe]) {
    const v = pickFromBucket(VERSES_WEEKDAY[vibe], date);
    if (v) return v;
  }

  // 6. Time-of-day
  const tod = getTimeOfDay(date);
  if (tod === 'morning') {
    const v = pickFromBucket(VERSES_MORNING, date);
    if (v) return v;
  } else if (tod === 'dusk') {
    const v = pickFromBucket(VERSES_DUSK, date);
    if (v) return v;
  } else if (tod === 'night') {
    const v = pickFromBucket(VERSES_NIGHT, date);
    if (v) return v;
  }

  // 7. Season
  const season = getSeason(date);
  const seasonBucket = {
    spring: VERSES_SPRING,
    summer: VERSES_SUMMER,
    autumn: VERSES_AUTUMN,
    winter: VERSES_WINTER,
  }[season];
  const seasonVerse = pickFromBucket(seasonBucket, date);
  if (seasonVerse) return seasonVerse;

  // 8. Romantic fallback
  return pickFromBucket(VERSES_ROMANTIC, date) || VERSES_ROMANTIC[0];
}

/**
 * renderDailyVerse() — async because it reads the live tab count to decide
 * which bucket fits the user's current "mental tempo". Falls back gracefully
 * if chrome.tabs.query is unavailable or fails.
 *
 * Also paints the "solar tone" + "circadian mode" attributes on <html>
 * so the page subtly reflects the current 节气 and time of day.
 */
async function renderDailyVerse() {
  const lineEl = document.getElementById('dailyVerseLine');
  const metaEl = document.getElementById('dailyVerseMeta');
  if (!lineEl || !metaEl) return;

  let tabCount = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      const tabs = await chrome.tabs.query({});
      tabCount = Array.isArray(tabs) ? tabs.length : null;
    }
  } catch (_) {
    // Permission missing or query failed — fall through with tabCount=null,
    // and getDailyVerse() will simply skip the tab-mood layer.
    tabCount = null;
  }

  const verse = getDailyVerse(new Date(), tabCount);
  lineEl.textContent = verse.line;
  metaEl.textContent = `${verse.source} · ${verse.mood}`;

  // Whisper-level visual context: tint the page by season + day/night.
  // Best-effort, never throws — if anything fails the page just stays neutral.
  try { applySolarAndCircadian(new Date()); } catch (_) { /* noop */ }
}


/* ================================================================
   SOLAR TONE & CIRCADIAN MODE
   ----------------------------------------------------------------
   Two whisper-level visual layers driven from pure local signals:

   1. Solar tone — derived from the current 节气 (or season fallback),
      paints a faint seasonal hue onto --paper / --card-bg via a
      data-solar attribute on <html>.

   2. Circadian mode — uses the user's IANA time zone to look up an
      approximate latitude/longitude, then computes today's sunrise
      and sunset via the standard NOAA solar position formulas.
      No network, no permission prompt — just math.

   Both layers degrade gracefully:
   - Unknown time zone → fall back to OS prefers-color-scheme + a
     coarse "winter dark by 17:00, summer dark by 19:30" heuristic.
   - Disabled at any time by writing localStorage["tabout.theme.disabled"]
     (left as an escape hatch; not exposed in UI yet).
   ================================================================ */

/**
 * solarToneFromDate(date) — map (节气 → season) into one of:
 *   spring | summer | autumn | winter
 *
 * Uses the existing matchSolarTerm() if it lands on a term, otherwise
 * falls back to getSeason() for dates between named terms.
 */
function solarToneFromDate(date) {
  // 节气 → season buckets. Each Chinese solar term clearly belongs to one season.
  const TERM_TO_SEASON = {
    lichun: 'spring', yushui: 'spring', jingzhe: 'spring', chunfen: 'spring',
    qingming: 'spring', guyu: 'spring',
    lixia: 'summer', xiaoman: 'summer', mangzhong: 'summer', xiazhi: 'summer',
    xiaoshu: 'summer', dashu: 'summer',
    liqiu: 'autumn', chushu: 'autumn', bailu: 'autumn', qiufen: 'autumn',
    hanlu: 'autumn', shuangjiang: 'autumn',
    lidong: 'winter', xiaoxue: 'winter', daxue: 'winter', dongzhi: 'winter',
    xiaohan: 'winter', dahan: 'winter',
  };
  if (typeof matchSolarTerm === 'function') {
    const t = matchSolarTerm(date);
    if (t && TERM_TO_SEASON[t]) return TERM_TO_SEASON[t];
  }
  if (typeof getSeason === 'function') {
    const s = getSeason(date);
    if (['spring', 'summer', 'autumn', 'winter'].includes(s)) return s;
  }
  // Final fallback by month
  const m = date.getMonth();
  if (m >= 2 && m <= 4)  return 'spring';
  if (m >= 5 && m <= 7)  return 'summer';
  if (m >= 8 && m <= 10) return 'autumn';
  return 'winter';
}


/**
 * Time-zone → approximate (lat, lon) lookup table.
 *
 * Why a table? Chrome extensions can't call navigator.geolocation from a
 * newtab override without a user gesture, and we don't want to ask for
 * permission for something this whisper-level. The IANA time zone is
 * always available via Intl.DateTimeFormat, and within a single zone the
 * sunrise/sunset error is typically < 30 minutes — fine for a tint switch.
 *
 * Coordinates target the most populous city of each zone.
 */
const TZ_COORDS = {
  // East Asia
  'Asia/Shanghai':    { lat: 31.23, lon: 121.47 },
  'Asia/Chongqing':   { lat: 29.56, lon: 106.55 },
  'Asia/Hong_Kong':   { lat: 22.30, lon: 114.17 },
  'Asia/Macau':       { lat: 22.20, lon: 113.55 },
  'Asia/Taipei':      { lat: 25.03, lon: 121.57 },
  'Asia/Tokyo':       { lat: 35.68, lon: 139.69 },
  'Asia/Seoul':       { lat: 37.57, lon: 126.98 },
  'Asia/Pyongyang':   { lat: 39.02, lon: 125.75 },
  'Asia/Ulaanbaatar': { lat: 47.92, lon: 106.92 },
  // Southeast Asia
  'Asia/Singapore':   { lat:  1.35, lon: 103.82 },
  'Asia/Kuala_Lumpur':{ lat:  3.14, lon: 101.69 },
  'Asia/Jakarta':     { lat: -6.21, lon: 106.85 },
  'Asia/Bangkok':     { lat: 13.75, lon: 100.50 },
  'Asia/Ho_Chi_Minh': { lat: 10.82, lon: 106.63 },
  'Asia/Manila':      { lat: 14.60, lon: 120.98 },
  // South & West Asia
  'Asia/Kolkata':     { lat: 22.57, lon: 88.36 },
  'Asia/Karachi':     { lat: 24.86, lon: 67.01 },
  'Asia/Dubai':       { lat: 25.20, lon: 55.27 },
  'Asia/Tehran':      { lat: 35.69, lon: 51.42 },
  'Asia/Jerusalem':   { lat: 31.78, lon: 35.22 },
  // Europe
  'Europe/London':    { lat: 51.51, lon:  -0.13 },
  'Europe/Paris':     { lat: 48.86, lon:   2.35 },
  'Europe/Berlin':    { lat: 52.52, lon:  13.40 },
  'Europe/Madrid':    { lat: 40.42, lon:  -3.70 },
  'Europe/Rome':      { lat: 41.90, lon:  12.50 },
  'Europe/Amsterdam': { lat: 52.37, lon:   4.90 },
  'Europe/Moscow':    { lat: 55.76, lon:  37.62 },
  'Europe/Istanbul':  { lat: 41.01, lon:  28.98 },
  // Americas
  'America/New_York':    { lat: 40.71, lon: -74.01 },
  'America/Chicago':     { lat: 41.88, lon: -87.63 },
  'America/Denver':      { lat: 39.74, lon: -104.99 },
  'America/Los_Angeles': { lat: 34.05, lon: -118.24 },
  'America/Vancouver':   { lat: 49.28, lon: -123.12 },
  'America/Toronto':     { lat: 43.65, lon: -79.38 },
  'America/Mexico_City': { lat: 19.43, lon: -99.13 },
  'America/Sao_Paulo':   { lat: -23.55, lon: -46.63 },
  'America/Buenos_Aires':{ lat: -34.61, lon: -58.38 },
  // Oceania
  'Australia/Sydney':   { lat: -33.87, lon: 151.21 },
  'Australia/Melbourne':{ lat: -37.81, lon: 144.96 },
  'Australia/Perth':    { lat: -31.95, lon: 115.86 },
  'Pacific/Auckland':   { lat: -36.85, lon: 174.76 },
  // Africa
  'Africa/Cairo':       { lat: 30.04, lon: 31.24 },
  'Africa/Johannesburg':{ lat: -26.20, lon: 28.04 },
  'Africa/Lagos':       { lat:  6.52, lon:  3.38 },
  'Africa/Nairobi':     { lat: -1.29, lon: 36.82 },
};

/** Resolve a coarse (lat, lon) for the user's current IANA zone. */
function resolveCoordsByTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && TZ_COORDS[tz]) return TZ_COORDS[tz];
    // Common alias shortcuts (Asia/Beijing isn't standard but some browsers report it).
    if (tz === 'Asia/Beijing') return TZ_COORDS['Asia/Shanghai'];
    if (tz === 'Asia/Urumqi')  return TZ_COORDS['Asia/Shanghai'];
  } catch (_) { /* noop */ }
  return null;
}


/**
 * NOAA sunrise/sunset for a given date + (lat, lon).
 * Returns { sunriseMs, sunsetMs } in epoch ms, or null on failure
 * (e.g. polar day/night where the sun never crosses the horizon).
 *
 * Reference: NOAA Solar Calculator equations
 * https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 */
function computeSunriseSunset(date, lat, lon) {
  // Day of year (1-based)
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()
  ) - start;
  const N = Math.floor(diff / 86400000);

  // Fractional year (radians)
  const gamma = (2 * Math.PI / 365) * (N - 1);

  // Equation of time (minutes)
  const eqtime = 229.18 * (
    0.000075 +
    0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) -
    0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination (radians)
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.001480 * Math.sin(3 * gamma);

  // Hour angle for sunrise/sunset (zenith = 90.833° accounts for refraction)
  const latRad = lat * Math.PI / 180;
  const cosHA  = (Math.cos(90.833 * Math.PI / 180) /
                  (Math.cos(latRad) * Math.cos(decl))) -
                 Math.tan(latRad) * Math.tan(decl);
  if (cosHA > 1 || cosHA < -1) return null; // polar day/night
  const ha = Math.acos(cosHA) * 180 / Math.PI; // degrees

  // Sunrise/sunset in UTC minutes-from-midnight
  const sunriseMin = 720 - 4 * (lon + ha) - eqtime;
  const sunsetMin  = 720 - 4 * (lon - ha) - eqtime;

  const baseUTC = Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0
  );
  return {
    sunriseMs: baseUTC + sunriseMin * 60 * 1000,
    sunsetMs:  baseUTC + sunsetMin  * 60 * 1000,
  };
}

/**
 * dayNightModeFromDate(date) — return 'day' or 'night'.
 *
 * Strategy:
 *   1. Try to resolve coords from the IANA time zone, then compute
 *      today's sunrise/sunset via NOAA equations.
 *   2. If coords unknown OR computation fails (polar regions),
 *      fall back to a coarse seasonal cutoff:
 *        winter → night before 7:00 / after 17:30
 *        summer → night before 5:30 / after 19:30
 *        spring/autumn → night before 6:30 / after 18:30
 *      And further fall back to OS prefers-color-scheme as a final hint.
 */
function dayNightModeFromDate(date) {
  const coords = resolveCoordsByTimeZone();
  if (coords) {
    const sun = computeSunriseSunset(date, coords.lat, coords.lon);
    if (sun) {
      const t = date.getTime();
      return (t >= sun.sunriseMs && t < sun.sunsetMs) ? 'day' : 'night';
    }
    // Polar fall-through to seasonal heuristic below
  }

  // Seasonal heuristic
  const tone = solarToneFromDate(date);
  const h = date.getHours() + date.getMinutes() / 60;
  let dawn, dusk;
  if (tone === 'winter')      { dawn = 7.0;  dusk = 17.5; }
  else if (tone === 'summer') { dawn = 5.5;  dusk = 19.5; }
  else                        { dawn = 6.5;  dusk = 18.5; }
  if (h >= dawn && h < dusk) return 'day';
  if (h < dawn || h >= dusk) return 'night';

  // Last-resort: OS hint
  try {
    if (window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) return 'night';
  } catch (_) { /* noop */ }
  return 'day';
}

/**
 * applySolarAndCircadian(date)
 *
 * Paints `data-solar` and `data-mode` on <html>. CSS in style.css picks
 * these attributes up to retune the page tokens by ~1–2%. This is the
 * one and only DOM-touching entry point for the theme layer.
 *
 * Honors an escape hatch: if localStorage['tabout.theme.disabled'] === '1',
 * both attributes are removed and the page stays in the default palette.
 */
function applySolarAndCircadian(date = new Date()) {
  const root = document.documentElement;
  if (!root) return;

  let disabled = false;
  try { disabled = localStorage.getItem('tabout.theme.disabled') === '1'; }
  catch (_) { /* private mode — assume enabled */ }
  if (disabled) {
    root.removeAttribute('data-solar');
    root.removeAttribute('data-mode');
    return;
  }

  const solar = solarToneFromDate(date);
  const mode  = dayNightModeFromDate(date);
  if (solar) root.setAttribute('data-solar', solar);
  if (mode)  root.setAttribute('data-mode',  mode);
}


/* ================================================================
   TODAY BOARD — work-day todo list
   ----------------------------------------------------------------
   A whisper-light task tracker designed for the working day:
     • Quick-add via ⌘K (Cmd/Ctrl+K) or the "+ add" button
     • No projects, tags, or priorities menus — annotate inline with
       "!" (important) or "?" (research) at the end of the text
     • Done items sink to a "done today" zone, archived at midnight
     • Unfinished items carry over with a small "·N" badge so you
       can see how long something has been lingering
     • 7-day heatmap for a one-glance week review
     • "Add to today" button on each open tab → todo with a back-link

   Storage strategy:
     • chrome.storage.sync   ← active todos (cross-device, ~6 KB)
     • chrome.storage.local  ← mirror + 14-day snapshots + archive
     • Every write is double-written. Reads prefer sync, fall back
       to local mirror, then to the most recent snapshot.

   Data shape (under key "todayBoard"):
   {
     version: 1,
     todos: [
       {
         id: "t_<ms>_<rand>",
         text: "Review PR #1234",
         done: false,
         doneAt: null,                     // ISO when checked off
         priority: null | "important" | "research",
         url: null | "https://...",        // when sourced from a tab
         sourceTitle: null | "...",        // original tab title
         createdAt: <ms>,
         carriedDays: 0
       }
     ],
     lastRolloverDate: "YYYY-MM-DD"        // local-time day key
   }

   Archive (under "todoArchive" in chrome.storage.local):
   {
     version: 1,
     items: [ { ...todo, archivedAt: <ms> } ]   // only "done" todos, kept 90d
   }
   ================================================================ */

const TODO_STORAGE_KEY      = 'todayBoard';
const TODO_BACKUP_KEY       = 'todayBoard_backup';
const TODO_ARCHIVE_KEY      = 'todoArchive';
const TODO_SNAPSHOT_PREFIX  = 'todoSnap_';
const TODO_SNAPSHOT_MAX_DAYS = 14;
const TODO_ARCHIVE_MAX_DAYS  = 90;
const TODO_CARRY_STALE_DAYS  = 3;   // visual cue threshold
const TODO_DATA_VERSION      = 1;

// In-memory cache. Single source of truth during a page session.
let _todoState = null;         // { todos, lastRolloverDate }
let _todoCelebrated = false;   // whether we've shimmered for "all done" today

// Collapse state (persisted via chrome.storage.sync so it follows you
// across devices). Loaded once at init and kept in memory thereafter.
const TODO_COLLAPSE_KEY = 'todoBoardCollapse';
const TODO_DONE_AUTO_COLLAPSE_THRESHOLD = 3; // first-render auto-collapse when N+ done
let _todoCollapse = {
  board: false,        // entire Today Board collapsed to a one-line summary
  done:  false,        // "X done today" section collapsed (folded by default)
  doneUserSet: false,  // user has explicitly toggled done section this session
};

/* ---- Date helpers ---- */

/** dateKey(d) — local-time YYYY-MM-DD string (used for rollover/snapshots). */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** daysBetween(a, b) — whole local-day difference (b - a). */
function daysBetween(aKey, bKey) {
  const [ay, am, ad] = aKey.split('-').map(Number);
  const [by, bm, bd] = bKey.split('-').map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((b - a) / 86400000);
}

/** newTodoId() — collision-resistant short id. */
function newTodoId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}


/* ---- Storage layer (sync primary + local mirror + snapshots) ---- */

/**
 * Read the todo state with three-tier fallback:
 *   1) chrome.storage.sync (cross-device source of truth)
 *   2) chrome.storage.local mirror (latest local backup)
 *   3) most recent snapshot (last 14 days)
 *   4) fresh empty state
 */
async function loadTodoState() {
  const empty = { version: TODO_DATA_VERSION, todos: [], lastRolloverDate: dateKey() };

  // 1) sync
  try {
    if (chrome?.storage?.sync) {
      const got = await chrome.storage.sync.get(TODO_STORAGE_KEY);
      const s = got?.[TODO_STORAGE_KEY];
      if (s && Array.isArray(s.todos)) return normalizeTodoState(s);
    }
  } catch (_) { /* fall through to local */ }

  // 2) local mirror
  try {
    if (chrome?.storage?.local) {
      const got = await chrome.storage.local.get(TODO_BACKUP_KEY);
      const s = got?.[TODO_BACKUP_KEY];
      if (s && Array.isArray(s.todos)) return normalizeTodoState(s);
    }
  } catch (_) { /* fall through to snapshots */ }

  // 3) most recent snapshot
  try {
    if (chrome?.storage?.local) {
      const all = await chrome.storage.local.get(null);
      const snapKeys = Object.keys(all)
        .filter(k => k.startsWith(TODO_SNAPSHOT_PREFIX))
        .sort()
        .reverse();
      for (const k of snapKeys) {
        const s = all[k];
        if (s && Array.isArray(s.todos)) return normalizeTodoState(s);
      }
    }
  } catch (_) { /* fall through to empty */ }

  return empty;
}

function normalizeTodoState(s) {
  // Defensive: fill any missing fields so render code never crashes.
  return {
    version: s.version || TODO_DATA_VERSION,
    lastRolloverDate: s.lastRolloverDate || dateKey(),
    todos: (s.todos || []).map(t => ({
      id:           t.id || newTodoId(),
      text:         typeof t.text === 'string' ? t.text : '',
      done:         !!t.done,
      doneAt:       t.doneAt || null,
      priority:     t.priority === 'important' || t.priority === 'research' ? t.priority : null,
      url:          t.url || null,
      sourceTitle:  t.sourceTitle || null,
      createdAt:    typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      carriedDays:  typeof t.carriedDays === 'number' ? t.carriedDays : 0,
      // Manual sort weight within a priority bucket. Smaller = earlier.
      // Defaults to createdAt so untouched todos preserve insertion order.
      order:        typeof t.order === 'number' ? t.order : (typeof t.createdAt === 'number' ? t.createdAt : Date.now()),
    })),
  };
}

/**
 * Persist the state. Double-writes to sync + local; takes a daily
 * snapshot (only on the first save of each calendar day) and prunes
 * snapshots older than TODO_SNAPSHOT_MAX_DAYS.
 *
 * Never throws — storage failures are logged and swallowed so the UI
 * never wedges. Caller can ignore the returned promise.
 */
async function saveTodoState(state) {
  if (!state) return;
  const payload = { ...state, version: TODO_DATA_VERSION };
  const today = dateKey();

  // Primary: sync
  try {
    if (chrome?.storage?.sync) {
      await chrome.storage.sync.set({ [TODO_STORAGE_KEY]: payload });
    }
  } catch (e) {
    console.warn('[TodayBoard] sync write failed; relying on local mirror.', e);
  }

  // Mirror: local
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ [TODO_BACKUP_KEY]: { ...payload, backedUpAt: Date.now() } });
    }
  } catch (e) {
    console.warn('[TodayBoard] local mirror write failed.', e);
  }

  // Daily snapshot (idempotent — same key per day = overwrite)
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ [`${TODO_SNAPSHOT_PREFIX}${today}`]: payload });
      // Prune old snapshots
      const all = await chrome.storage.local.get(null);
      const expired = Object.keys(all).filter(k => {
        if (!k.startsWith(TODO_SNAPSHOT_PREFIX)) return false;
        const day = k.slice(TODO_SNAPSHOT_PREFIX.length);
        return daysBetween(day, today) > TODO_SNAPSHOT_MAX_DAYS;
      });
      if (expired.length) await chrome.storage.local.remove(expired);
    }
  } catch (e) {
    /* snapshots are best-effort; never raise */
  }
}


/* ---- Archive (done-today items, kept up to 90 days locally) ---- */

async function loadTodoArchive() {
  try {
    if (chrome?.storage?.local) {
      const got = await chrome.storage.local.get(TODO_ARCHIVE_KEY);
      const a = got?.[TODO_ARCHIVE_KEY];
      if (a && Array.isArray(a.items)) return a;
    }
  } catch (_) { /* noop */ }
  return { version: TODO_DATA_VERSION, items: [] };
}

async function saveTodoArchive(archive) {
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({ [TODO_ARCHIVE_KEY]: archive });
    }
  } catch (e) { console.warn('[TodayBoard] archive write failed.', e); }
}

/** Append items into the archive and prune anything older than the limit. */
async function archiveTodoItems(items) {
  if (!items?.length) return;
  const archive = await loadTodoArchive();
  const now = Date.now();
  archive.items.push(...items.map(t => ({ ...t, archivedAt: now })));
  const cutoff = now - TODO_ARCHIVE_MAX_DAYS * 86400000;
  archive.items = archive.items.filter(t => (t.archivedAt || 0) >= cutoff);
  archive.version = TODO_DATA_VERSION;
  await saveTodoArchive(archive);
}


/* ---- Lifecycle: midnight rollover ----
   On each page render we check whether the calendar day has changed
   since lastRolloverDate. If so:
     1) Move all "done" todos into the archive.
     2) For remaining (undone) todos, increment carriedDays.
     3) Drop todos that have carried >= 7 days (auto-let-go).
     4) Update lastRolloverDate.
   This keeps the visible board to today's reality without losing
   anything the user actually completed. */

function rolloverTodoState(state) {
  const today = dateKey();
  if (state.lastRolloverDate === today) return { state, archived: [] };

  const days = daysBetween(state.lastRolloverDate, today);
  if (days <= 0) {
    // Clock skew or future override — just reset the marker quietly.
    state.lastRolloverDate = today;
    return { state, archived: [] };
  }

  const archived = state.todos.filter(t => t.done);
  const surviving = state.todos
    .filter(t => !t.done)
    .map(t => ({ ...t, carriedDays: (t.carriedDays || 0) + days }))
    .filter(t => t.carriedDays < 7); // auto let-go after a week

  state.todos = surviving;
  state.lastRolloverDate = today;
  return { state, archived };
}


/* ---- Public state accessor ---- */

async function ensureTodoState() {
  if (_todoState) return _todoState;
  const loaded = await loadTodoState();
  const { state, archived } = rolloverTodoState(loaded);
  _todoState = state;
  if (archived.length) {
    await archiveTodoItems(archived);
    await saveTodoState(_todoState);
  }
  return _todoState;
}


/* ---- CRUD operations ---- */

/** Parse "Review PR !"  → { text: "Review PR", priority: "important" } */
function parseTodoInput(raw) {
  let text = (raw || '').trim();
  let priority = null;
  // Trailing single-character marker
  if (/[!]$/.test(text))      { priority = 'important'; text = text.replace(/\s*!+$/, '').trim(); }
  else if (/[?]$/.test(text)) { priority = 'research';  text = text.replace(/\s*\?+$/, '').trim(); }
  return { text, priority };
}

async function addTodo(rawText, opts = {}) {
  const { text, priority } = parseTodoInput(rawText);
  if (!text) return null;
  const state = await ensureTodoState();
  const now = Date.now();
  const todo = {
    id: newTodoId(),
    text,
    done: false,
    doneAt: null,
    priority: opts.priority ?? priority,
    url: opts.url || null,
    sourceTitle: opts.sourceTitle || null,
    createdAt: now,
    carriedDays: 0,
    order: now,
  };
  state.todos.push(todo);
  await saveTodoState(state);
  return todo;
}

/** Cycle priority on a todo: none → important → research → none.
 *  Used by the click-to-toggle priority chip on each row. */
async function cyclePriorityTodo(id) {
  const state = await ensureTodoState();
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  const next = t.priority === null ? 'important'
             : t.priority === 'important' ? 'research'
             : null;
  t.priority = next;
  await saveTodoState(state);
}

/** Reorder a todo by inserting it before another todo (or at the end).
 *  Cross-bucket drops also adopt the target bucket's priority so the
 *  user's drop position is honoured even after re-sort. */
async function reorderTodo(srcId, targetId, placeBefore) {
  if (!srcId || srcId === targetId) return;
  const state = await ensureTodoState();
  const src = state.todos.find(x => x.id === srcId);
  if (!src) return;

  // If dropping onto another todo, adopt its priority bucket.
  // (Drop onto empty space at end keeps current priority.)
  if (targetId) {
    const tgt = state.todos.find(x => x.id === targetId);
    if (!tgt) return;
    src.priority = tgt.priority;

    // Compute order: place src adjacent to tgt within the same bucket.
    const sameBucket = state.todos
      .filter(x => !x.done && x.id !== srcId && x.priority === tgt.priority)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const idx = sameBucket.findIndex(x => x.id === targetId);
    const before = placeBefore ? sameBucket[idx - 1] : sameBucket[idx];
    const after  = placeBefore ? sameBucket[idx]     : sameBucket[idx + 1];
    const lo = before ? (before.order || 0) : ((after?.order || Date.now()) - 2000);
    const hi = after  ? (after.order  || 0) : ((before?.order || Date.now()) + 2000);
    src.order = (lo + hi) / 2;
  } else {
    // Append to the end of src's current bucket.
    const sameBucket = state.todos
      .filter(x => !x.done && x.id !== srcId && x.priority === src.priority)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const last = sameBucket[sameBucket.length - 1];
    src.order = last ? (last.order || 0) + 1000 : Date.now();
  }

  await saveTodoState(state);
}

async function toggleTodo(id) {
  const state = await ensureTodoState();
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  await saveTodoState(state);
}

async function deleteTodo(id) {
  const state = await ensureTodoState();
  state.todos = state.todos.filter(x => x.id !== id);
  await saveTodoState(state);
}

async function editTodoText(id, newText) {
  const state = await ensureTodoState();
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  const { text, priority } = parseTodoInput(newText);
  if (!text) return; // ignore empty edits
  t.text = text;
  if (priority) t.priority = priority;
  await saveTodoState(state);
}

/** Wipe everything: live todos + archive + snapshots. */
async function clearAllTodoData() {
  _todoState = { version: TODO_DATA_VERSION, todos: [], lastRolloverDate: dateKey() };
  try {
    if (chrome?.storage?.sync) await chrome.storage.sync.remove(TODO_STORAGE_KEY);
    if (chrome?.storage?.local) {
      const all = await chrome.storage.local.get(null);
      const keysToRemove = [TODO_BACKUP_KEY, TODO_ARCHIVE_KEY,
        ...Object.keys(all).filter(k => k.startsWith(TODO_SNAPSHOT_PREFIX))];
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch (e) { console.warn('[TodayBoard] clear failed', e); }
}


/* ---- Export ----
   JSON download, includes live state + archive so a user can fully
   restore by re-importing later (importer is not exposed yet). */

async function exportTodosAsJSON() {
  const state = await ensureTodoState();
  const archive = await loadTodoArchive();
  const payload = {
    exportedAt: new Date().toISOString(),
    version: TODO_DATA_VERSION,
    state,
    archive,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabout-todos-${dateKey()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}


/* ---- Rendering ---- */

/** Escape text for safe insertion into HTML. */
function escTodoHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function todoItemHTML(t) {
  const priClass = t.priority === 'important' ? 'todo-priority-important'
                 : t.priority === 'research'  ? 'todo-priority-research'
                 : 'todo-priority-none';
  const priChar  = t.priority === 'important' ? '!'
                 : t.priority === 'research'  ? '?' : '·';
  const priTitle = t.priority === 'important' ? 'Priority: important — click to switch'
                 : t.priority === 'research'  ? 'Priority: research — click to clear'
                 : 'No priority — click to mark important';
  const carriedHTML = t.carriedDays > 0
    ? `<span class="todo-carried${t.carriedDays >= TODO_CARRY_STALE_DAYS ? ' is-stale' : ''}"
              title="Carried over ${t.carriedDays} day${t.carriedDays>1?'s':''}">·${t.carriedDays}</span>`
    : '';
  const text = t.url
    ? `<a class="todo-text-link" href="${escTodoHtml(t.url)}" target="_top"
            data-action="todo-open-url" data-todo-id="${escTodoHtml(t.id)}"
            title="Open ${escTodoHtml(t.url)}">${escTodoHtml(t.text)}</a>
       <span class="todo-source-tab" title="Linked to a tab">
         <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
              stroke-width="1.6" stroke="currentColor">
           <path stroke-linecap="round" stroke-linejoin="round"
                 d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
         </svg>
       </span>`
    : escTodoHtml(t.text);
  // Done rows are not draggable (prevents accidental reorder of completed work).
  const draggable = t.done ? '' : 'draggable="true"';
  return `
    <li class="todo-item" data-todo-id="${escTodoHtml(t.id)}" ${draggable}>
      <span class="todo-drag-handle" aria-hidden="true" title="Drag to reorder">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="10" height="10" fill="currentColor">
          <circle cx="5" cy="4"  r="1.2"/><circle cx="11" cy="4"  r="1.2"/>
          <circle cx="5" cy="8"  r="1.2"/><circle cx="11" cy="8"  r="1.2"/>
          <circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/>
        </svg>
      </span>
      <input type="checkbox" class="todo-checkbox" data-action="todo-toggle"
             data-todo-id="${escTodoHtml(t.id)}" ${t.done ? 'checked' : ''}
             aria-label="Toggle ${escTodoHtml(t.text)}">
      <div class="todo-text" data-action="todo-edit"
           data-todo-id="${escTodoHtml(t.id)}">${text}</div>
      <button type="button" class="todo-priority ${priClass}"
              data-action="todo-cycle-priority" data-todo-id="${escTodoHtml(t.id)}"
              title="${priTitle}">${priChar}</button>
      ${carriedHTML}
      <button class="todo-delete-btn" data-action="todo-delete"
              data-todo-id="${escTodoHtml(t.id)}" title="Delete">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
             stroke-width="1.6" stroke="currentColor" width="14" height="14">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M6 18 18 6M6 6l12 12" />
        </svg>
      </button>
    </li>
  `;
}

/**
 * loadCollapseState() — read persisted board/done collapse flags.
 * sync → local fallback, mirrors the main todo storage strategy so a
 * brand-new browser still reads your last preference.
 */
async function loadCollapseState() {
  let s = null;
  try {
    if (chrome?.storage?.sync) {
      const got = await chrome.storage.sync.get(TODO_COLLAPSE_KEY);
      s = got?.[TODO_COLLAPSE_KEY] || null;
    }
  } catch (_) { /* fall through */ }
  if (!s) {
    try {
      if (chrome?.storage?.local) {
        const got = await chrome.storage.local.get(TODO_COLLAPSE_KEY);
        s = got?.[TODO_COLLAPSE_KEY] || null;
      }
    } catch (_) { /* noop */ }
  }
  if (!s) return;
  _todoCollapse.board = !!s.board;
  _todoCollapse.done  = !!s.done;
  // doneUserSet is per-session, not persisted: each new tab starts "auto".
}

async function saveCollapseState() {
  const payload = { board: !!_todoCollapse.board, done: !!_todoCollapse.done };
  try {
    if (chrome?.storage?.sync)  await chrome.storage.sync.set({ [TODO_COLLAPSE_KEY]: payload });
  } catch (_) { /* noop */ }
  try {
    if (chrome?.storage?.local) await chrome.storage.local.set({ [TODO_COLLAPSE_KEY]: payload });
  } catch (_) { /* noop */ }
}

async function renderTodayBoard() {
  const board = document.getElementById('todayBoard');
  if (!board) return;
  const state = await ensureTodoState();

  const listEl       = document.getElementById('todoList');
  const doneEl       = document.getElementById('todoListDone');
  const emptyEl      = document.getElementById('todoEmpty');
  const progressEl   = document.getElementById('todoProgressText');
  const fillEl       = document.getElementById('todoProgressFill');
  const barEl        = document.getElementById('todoProgressBar');
  const summaryEl    = document.getElementById('todoSummary');
  const doneSection  = document.getElementById('todoDoneSection');
  const doneToggleEl = document.getElementById('todoDoneToggleText');
  const doneScroll   = document.getElementById('todoListScrollDone');

  const active = state.todos.filter(t => !t.done);
  const done   = state.todos.filter(t => t.done);

  // Active list — sort by priority bucket (! first, then ?, then by
  // user's manual order within each bucket). order defaults to createdAt
  // so untouched todos still appear in insertion order.
  const priWeight = p => p === 'important' ? 0 : p === 'research' ? 2 : 1;
  active.sort((a, b) => {
    const w = priWeight(a.priority) - priWeight(b.priority);
    if (w !== 0) return w;
    const ao = typeof a.order === 'number' ? a.order : a.createdAt;
    const bo = typeof b.order === 'number' ? b.order : b.createdAt;
    return ao - bo;
  });
  done.sort((a, b) => (a.doneAt || '').localeCompare(b.doneAt || ''));

  if (listEl) listEl.innerHTML = active.map(todoItemHTML).join('');
  if (doneEl) doneEl.innerHTML = done.map(todoItemHTML).join('');
  // Wire HTML5 drag-and-drop onto the freshly-rendered active list.
  // (Done list is intentionally not draggable.)
  if (listEl) attachTodoDnD(listEl);

  // Empty state shows only when literally nothing on the board.
  // Also hide the progress bar in that case so we don't leave a
  // floating line below the empty-state text.
  const isTrulyEmpty = (active.length === 0 && done.length === 0);
  if (emptyEl) emptyEl.style.display = isTrulyEmpty ? 'block' : 'none';
  if (barEl)   barEl.classList.toggle('is-hidden', isTrulyEmpty);

  // Done section visibility & default-collapse logic.
  // First render of the day: if user already has 3+ done items, fold
  // them automatically so the active list is the visual focus.
  // After that, respect whatever the user toggles.
  if (doneSection) {
    if (done.length === 0) {
      doneSection.style.display = 'none';
    } else {
      doneSection.style.display = 'block';
      if (!_todoCollapse.doneUserSet) {
        _todoCollapse.done = done.length >= TODO_DONE_AUTO_COLLAPSE_THRESHOLD;
      }
      doneSection.classList.toggle('is-open', !_todoCollapse.done);
      if (doneScroll) {
        doneScroll.style.display = _todoCollapse.done ? 'none' : 'block';
      }
      if (doneToggleEl) {
        doneToggleEl.textContent = `${done.length} done today`;
      }
    }
  }

  // Progress
  const total = state.todos.length;
  const completed = done.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;
  if (progressEl) progressEl.textContent = total ? `${completed} / ${total}` : '0';
  if (fillEl) fillEl.style.width = `${pct}%`;

  if (barEl) {
    const isComplete = total > 0 && completed === total;
    barEl.classList.toggle('is-complete', isComplete);
    if (isComplete && !_todoCelebrated) {
      barEl.classList.add('is-celebrating');
      _todoCelebrated = true;
      setTimeout(() => barEl.classList.remove('is-celebrating'), 1500);
    }
    if (!isComplete) _todoCelebrated = false;
  }

  // Whole-board collapse state. The header stays visible; .is-collapsed
  // hides .today-board-body via CSS and shows the one-line summary.
  board.classList.toggle('is-collapsed', !!_todoCollapse.board);
  if (summaryEl) {
    if (_todoCollapse.board) {
      summaryEl.style.display = 'block';
      if (active.length === 0 && done.length === 0) {
        summaryEl.innerHTML = `<span class="summary-empty">Nothing on the board today.</span>`;
      } else {
        const parts = [];
        if (active.length) parts.push(`<span class="summary-pending">${active.length} pending</span>`);
        if (done.length)   parts.push(`<span class="summary-done">${done.length} done</span>`);
        summaryEl.innerHTML = parts.join(' · ');
      }
    } else {
      summaryEl.style.display = 'none';
    }
  }
}


/* ---- Drag & drop reorder (HTML5 native, no deps) ----
   Wired onto the active list after each render. Drag any row to
   reorder; dropping onto a row in another priority bucket adopts
   that bucket (so dragging into the "!" zone marks it important).
   A 1px indicator line shows the drop target between rows. */

let _dndState = { srcId: null, indicator: null };

function _ensureDropIndicator() {
  if (_dndState.indicator && document.body.contains(_dndState.indicator)) {
    return _dndState.indicator;
  }
  const el = document.createElement('div');
  el.className = 'todo-drop-indicator';
  _dndState.indicator = el;
  return el;
}

function _clearDropIndicator() {
  const ind = _dndState.indicator;
  if (ind && ind.parentNode) ind.parentNode.removeChild(ind);
}

function attachTodoDnD(listEl) {
  if (!listEl || listEl._dndBound) {
    // Already wired — the listener uses event delegation so it survives
    // innerHTML replacements without re-binding.
    return;
  }
  listEl._dndBound = true;

  listEl.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.todo-item');
    if (!li || !listEl.contains(li)) return;
    _dndState.srcId = li.dataset.todoId || null;
    li.classList.add('is-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      // Required for Firefox — some payload must be set.
      e.dataTransfer.setData('text/plain', _dndState.srcId || '');
    } catch (_) { /* noop */ }
  });

  listEl.addEventListener('dragend', () => {
    listEl.querySelectorAll('.todo-item.is-dragging').forEach(el => el.classList.remove('is-dragging'));
    _clearDropIndicator();
    _dndState.srcId = null;
  });

  listEl.addEventListener('dragover', (e) => {
    if (!_dndState.srcId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) { /* noop */ }

    const li = e.target.closest('.todo-item');
    const ind = _ensureDropIndicator();
    if (li && listEl.contains(li) && li.dataset.todoId !== _dndState.srcId) {
      const rect = li.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      ind.dataset.before = before ? '1' : '0';
      ind.dataset.targetId = li.dataset.todoId || '';
      if (before) li.parentNode.insertBefore(ind, li);
      else        li.parentNode.insertBefore(ind, li.nextSibling);
    } else {
      // Hovering empty space at end of list → append indicator at tail.
      ind.dataset.before = '0';
      ind.dataset.targetId = '';
      listEl.appendChild(ind);
    }
  });

  listEl.addEventListener('dragleave', (e) => {
    // Only clear if we've actually left the list itself (not just
    // moved between child rows, which fires dragleave constantly).
    if (e.target === listEl) _clearDropIndicator();
  });

  listEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const srcId = _dndState.srcId;
    if (!srcId) { _clearDropIndicator(); return; }
    const ind = _dndState.indicator;
    const targetId = ind?.dataset.targetId || '';
    const placeBefore = ind?.dataset.before === '1';
    _clearDropIndicator();
    _dndState.srcId = null;
    await reorderTodo(srcId, targetId || null, placeBefore);
    await renderTodayBoard();
  });
}


/* ---- 7-day heatmap ----
   Reads the archive for the last 7 days (today included) and renders
   a small grid showing how many todos were completed each day. Today
   counts the live "done" list so the cell updates in real time. */

async function renderTodoHeatmap() {
  const grid = document.getElementById('todoHeatmapGrid');
  if (!grid) return;
  const archive = await loadTodoArchive();
  const state = await ensureTodoState();

  const todayKey = dateKey();
  const todayLiveDone = state.todos.filter(t => t.done).length;

  // Group archive items by day
  const byDay = new Map();
  for (const it of archive.items) {
    const k = dateKey(new Date(it.archivedAt || it.doneAt || it.createdAt));
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }

  // Build last 7 days (including today)
  const cells = [];
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const k = dateKey(d);
    const isToday = k === todayKey;
    const count = (byDay.get(k) || 0) + (isToday ? todayLiveDone : 0);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    let heat = 0;
    if (count >= 1)  heat = 1;
    if (count >= 4)  heat = 2;
    if (count >= 8)  heat = 3;
    if (count >= 12) heat = 4;
    cells.push({ k, count, isToday, isWeekend, heat, label: dayLabels[d.getDay()] });
  }

  grid.innerHTML = cells.map(c => `
    <div class="todo-heatmap-cell heat-${c.heat}${c.isToday ? ' is-today' : ''}${c.isWeekend ? ' is-weekend' : ''}"
         title="${c.k}: ${c.count} done">
      <span class="todo-heatmap-cell-day">${c.label}</span>
      <span class="todo-heatmap-cell-count">${c.count > 0 ? c.count : '·'}</span>
    </div>
  `).join('');
}


/* ---- Tab → Todo: inject "+ to today" button into mission cards ----
   Called after the open-tabs grid has rendered. Adds a small button
   next to each domain card title and each individual page chip. */

function injectTabToTodoButtons() {
  // Card-level: link the "primary" / first tab of the card
  document.querySelectorAll('.mission-card').forEach(card => {
    if (card.querySelector('.mission-add-todo-btn')) return; // idempotent
    const titleEl = card.querySelector('.mission-title')
                 || card.querySelector('h3')
                 || card.querySelector('.mission-header h3');
    const firstTabLink = card.querySelector('[data-action="focus-tab"][data-tab-url]');
    if (!titleEl || !firstTabLink) return;
    const url   = firstTabLink.dataset.tabUrl;
    const title = (firstTabLink.textContent || '').trim();
    const btn = document.createElement('button');
    btn.className = 'mission-add-todo-btn';
    btn.dataset.action = 'todo-add-from-tab';
    btn.dataset.tabUrl = url;
    btn.dataset.tabTitle = title;
    btn.title = 'Add to today';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
           stroke-width="1.8" stroke="currentColor" width="12" height="12">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M12 4.5v15m7.5-7.5h-15" />
      </svg>`;
    titleEl.appendChild(btn);
  });

  // Chip-level: every individual page chip gets a tiny + on hover
  document.querySelectorAll('.page-chip[data-action="focus-tab"]').forEach(chip => {
    if (chip.querySelector('.page-chip-add-todo')) return;
    const url = chip.dataset.tabUrl;
    if (!url) return;
    const title = (chip.textContent || '').trim();
    const btn = document.createElement('span');
    btn.className = 'page-chip-add-todo';
    btn.setAttribute('role', 'button');
    btn.dataset.action = 'todo-add-from-tab';
    btn.dataset.tabUrl = url;
    btn.dataset.tabTitle = title;
    btn.title = 'Add to today';
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"
           stroke-width="2" stroke="currentColor" width="10" height="10">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M12 4.5v15m7.5-7.5h-15" />
      </svg>`;
    chip.appendChild(btn);
  });
}


/* ---- Event handlers (wired in via the existing document click delegate) ----
   We expose a single handler that the main delegate calls when it
   sees one of our `data-action` values. Keeps blast radius minimal
   and keeps all todo logic inside this module. */

async function handleTodoAction(action, el, ev) {
  const id = el.dataset.todoId;

  if (action === 'todo-focus-input') {
    showTodoInput(true);
    return true;
  }

  if (action === 'todo-toggle') {
    if (!id) return true;
    await toggleTodo(id);
    await renderTodayBoard();
    await renderTodoHeatmap();
    return true;
  }

  if (action === 'todo-delete') {
    if (!id) return true;
    await deleteTodo(id);
    await renderTodayBoard();
    return true;
  }

  if (action === 'todo-edit') {
    if (!id) return true;
    startEditTodoInline(id);
    return true;
  }

  if (action === 'todo-cycle-priority') {
    if (!id) return true;
    ev?.stopPropagation();
    ev?.preventDefault();
    await cyclePriorityTodo(id);
    await renderTodayBoard();
    return true;
  }

  if (action === 'todo-open-url') {
    // Let the anchor's default navigation happen; nothing to do.
    return true;
  }

  if (action === 'todo-add-from-tab') {
    ev?.stopPropagation();
    ev?.preventDefault();
    const url = el.dataset.tabUrl;
    const title = el.dataset.tabTitle || url || '';
    if (!url) return true;
    await addTodo(title, { url, sourceTitle: title });
    await renderTodayBoard();
    showToast?.('Added to today');
    return true;
  }

  if (action === 'todo-heatmap-toggle') {
    const hm = document.getElementById('todoHeatmap');
    if (!hm) return true;
    if (hm.style.display === 'none') {
      hm.style.display = 'block';
      await renderTodoHeatmap();
    } else {
      hm.style.display = 'none';
    }
    return true;
  }

  if (action === 'todo-collapse-toggle') {
    // Whole-board collapse: persists across sessions / devices.
    _todoCollapse.board = !_todoCollapse.board;
    saveCollapseState(); // fire-and-forget
    await renderTodayBoard();
    return true;
  }

  if (action === 'todo-done-toggle') {
    // Done section: per-session memory. Stops auto-collapsing once the
    // user has expressed an explicit preference in this tab.
    _todoCollapse.done = !_todoCollapse.done;
    _todoCollapse.doneUserSet = true;
    await renderTodayBoard();
    return true;
  }

  if (action === 'todo-settings-toggle') {
    const s = document.getElementById('todoSettings');
    if (s) s.style.display = (s.style.display === 'none' ? 'flex' : 'none');
    return true;
  }

  if (action === 'todo-export') {
    await exportTodosAsJSON();
    showToast?.('Exported');
    return true;
  }

  if (action === 'todo-clear-all') {
    const confirmed = window.confirm(
      'Clear ALL todos, archive, and snapshots?\n\nThis cannot be undone.'
    );
    if (!confirmed) return true;
    await clearAllTodoData();
    await renderTodayBoard();
    await renderTodoHeatmap();
    showToast?.('All todos cleared');
    return true;
  }

  return false; // not a todo action
}

const TODO_ACTIONS = new Set([
  'todo-focus-input', 'todo-toggle', 'todo-delete', 'todo-edit',
  'todo-open-url', 'todo-add-from-tab', 'todo-heatmap-toggle',
  'todo-settings-toggle', 'todo-export', 'todo-clear-all',
  'todo-collapse-toggle', 'todo-done-toggle', 'todo-cycle-priority',
]);
function isTodoAction(action) { return TODO_ACTIONS.has(action); }


/* ---- Inline edit ---- */

function startEditTodoInline(id) {
  const li = document.querySelector(`.todo-item[data-todo-id="${CSS.escape(id)}"]`);
  if (!li) return;
  const textEl = li.querySelector('.todo-text');
  if (!textEl) return;
  const original = textEl.textContent.trim();
  // Avoid duplicate inline editors
  if (textEl.querySelector('.todo-inline-input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'todo-input todo-inline-input';
  input.value = original;
  input.maxLength = 200;
  input.style.padding = '2px 4px';
  input.style.fontSize = '14px';

  textEl.innerHTML = '';
  textEl.appendChild(input);
  input.focus();
  input.select();

  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const v = input.value.trim();
    if (!v) {
      // Empty → restore original (don't accidentally delete)
      await renderTodayBoard();
      return;
    }
    await editTodoText(id, v);
    await renderTodayBoard();
  };
  const cancel = async () => {
    if (committed) return;
    committed = true;
    await renderTodayBoard();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', commit);
}


/* ---- Quick-add input behavior ---- */

function showTodoInput(focus = true) {
  const row = document.getElementById('todoInputRow');
  const input = document.getElementById('todoInput');
  if (!row || !input) return;
  row.style.display = 'flex';
  if (focus) {
    input.focus();
    input.select?.();
  }
}

function hideTodoInput() {
  const row = document.getElementById('todoInputRow');
  const input = document.getElementById('todoInput');
  if (row) row.style.display = 'none';
  if (input) input.value = '';
}

function wireTodoInput() {
  const input = document.getElementById('todoInput');
  if (!input || input.dataset.wired === '1') return;
  input.dataset.wired = '1';

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { hideTodoInput(); return; }
      await addTodo(v);
      input.value = '';
      await renderTodayBoard();
      // Brain-dump mode: keep focus so user can keep typing.
      input.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideTodoInput();
    }
  });

  // Click outside the input row → hide if empty
  document.addEventListener('click', (e) => {
    const row = document.getElementById('todoInputRow');
    if (!row || row.style.display === 'none') return;
    if (row.contains(e.target)) return;
    if (e.target.closest('[data-action="todo-focus-input"]')) return;
    if (input.value.trim() === '') hideTodoInput();
  });
}


/* ---- Global keyboard shortcut: Cmd/Ctrl + K opens quick-add ---- */

function wireTodoShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
    if (!isCmdK) return;
    // Don't hijack if user is already typing in another input/textarea
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) {
      // Allow ⌘K to refocus our quick-add even if some other input has it
      if (e.target?.id !== 'todoInput') return;
    }
    e.preventDefault();
    showTodoInput(true);
  });
}


/* ---- Initialization ---- */

function initTodayBoard() {
  wireTodoInput();
  wireTodoShortcuts();
  // Load persisted collapse state first so the first paint already
  // reflects the user's last preference (avoids a flash of expanded UI).
  loadCollapseState()
    .catch(() => { /* missing storage — fall through to defaults */ })
    .finally(() => {
      renderTodayBoard().catch(err => console.warn('[TodayBoard] initial render failed', err));
    });
}



/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();
  renderDailyVerse();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();

  // --- Render Today Board (work-day todos) ---
  // Independent of tabs — but we render it AFTER the tab grid so the
  // "Add to today" buttons we inject can see the rendered mission cards.
  await renderTodayBoard();
  injectTabToTodoButtons();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Today Board actions (delegated to its own handler) ----
  // Routed first so todo buttons inside mission cards (e.g. "+ to today")
  // never fall through to the legacy tab-focus / tab-close logic.
  if (typeof isTodoAction === 'function' && isTodoAction(action)) {
    try { await handleTodoAction(action, actionEl, e); }
    catch (err) { console.warn('[TodayBoard] action failed', action, err); }
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */

// Paint the season + day/night attributes synchronously *before* the
// first frame so the page opens already in the correct tone (no FOUC).
// renderDailyVerse() will refresh these later — this is just the
// earliest possible application.
try { applySolarAndCircadian(new Date()); } catch (_) { /* noop */ }

// Wire up Today Board input + global ⌘K shortcut, then render.
// Safe to run before renderDashboard() — both share state via _todoState.
try { initTodayBoard(); } catch (_) { /* noop */ }

renderDashboard();
