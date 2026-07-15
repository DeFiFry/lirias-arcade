'use strict';

const selectScreen = document.getElementById('select-screen');
const gridScreen = document.getElementById('grid-screen');
const chooseBtn = document.getElementById('choose-game-btn');
const gameGrid = document.getElementById('game-grid');
const gridEmpty = document.getElementById('grid-empty');
const playerOverlay = document.getElementById('player-overlay');
const playerFrame = document.getElementById('player-frame');
const playerClose = document.getElementById('player-close');
const toastEl = document.getElementById('toast');
const bgm = document.getElementById('bgm');
const exitBtn = document.getElementById('exit-btn');

// Categories shown on the Choose Game screen, in this fixed order. Only
// ROM systems are categorized this way (HTML5 collection games aren't part
// of this menu); a category with zero games for it is filtered out entirely.
const CATEGORY_ORDER = [
  { key: 'genesis', label: 'Sega Genesis' },
  { key: 'psx', label: 'Playstation' },
  { key: 'ps2', label: 'PlayStation 2' },
  { key: 'snes', label: 'Super Nintendo' },
  { key: 'n64', label: 'Nintendo 64' },
  { key: 'PC', label: 'PC' },
];

let games = [];
let categories = []; // [{ key, label, games: [...] }], empty ones filtered out
let focusedCategoryIndex = 0; // folder-list cursor, used while nothing is expanded
let expandedCategoryIndex = -1; // -1 = viewing the folder list; else the open category
let selectedGameIndex = 0; // cursor within categories[expandedCategoryIndex].games
let columns = 1;
let currentScreen = 'select';

function showToast(message, ms = 2500) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toastEl.hidden = true; }, ms);
}

// Once a game launch starts, nothing may restart the music - not even the
// autoplay-unlock listeners below, which fire on the *first* click/keydown/
// touchstart of the page and can otherwise race the very same event that
// triggered the launch (e.g. the first-ever Enter press doubles as both
// "launch this game" and "audio is now unlocked, play"). A synchronous flag
// checked inside playMusic() itself closes that race regardless of event
// ordering, timing, or which call site fires it.
let musicLocked = false;

function playMusic() {
  if (musicLocked) return;
  const p = bgm.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function stopMusic() {
  musicLocked = true;
  bgm.pause();
  bgm.currentTime = 0;
}

function unlockMusic() {
  musicLocked = false;
}

function setScreen(name) {
  currentScreen = name;
  selectScreen.classList.toggle('active', name === 'select');
  gridScreen.classList.toggle('active', name === 'grid');
  if (name === 'select') {
    chooseBtn.focus();
  }
  if (name === 'select' || name === 'grid') {
    playMusic();
  }
}

async function loadGames() {
  try {
    const res = await fetch('/api/games');
    const data = await res.json();
    games = data.games || [];
  } catch (err) {
    games = [];
    showToast('Failed to load game list: ' + err.message, 4000);
  }
  categories = CATEGORY_ORDER
    .map(({ key, label }) => ({ key, label, games: games.filter((g) => g.system === key) }))
    .filter((cat) => cat.games.length > 0);
  focusedCategoryIndex = 0;
  expandedCategoryIndex = -1;
  selectedGameIndex = 0;
  renderCategories();
}

function renderCategories() {
  gameGrid.innerHTML = '';
  gridEmpty.hidden = categories.length > 0;

  categories.forEach((cat, ci) => {
    const catEl = document.createElement('div');
    catEl.className = 'category';

    const header = document.createElement('div');
    header.className = 'category-header';
    header.tabIndex = 0;

    const arrow = document.createElement('span');
    arrow.className = 'category-arrow';
    arrow.textContent = '▶';
    header.appendChild(arrow);

    const label = document.createElement('span');
    label.className = 'category-label';
    label.textContent = cat.label;
    header.appendChild(label);

    const count = document.createElement('span');
    count.className = 'category-count';
    count.textContent = `(${cat.games.length})`;
    header.appendChild(count);

    header.addEventListener('click', () => {
      focusedCategoryIndex = ci;
      toggleCategory(ci);
    });
    header.addEventListener('mouseenter', () => {
      if (expandedCategoryIndex !== -1) return;
      focusedCategoryIndex = ci;
      updateSelection();
    });

    catEl.appendChild(header);

    const gamesEl = document.createElement('div');
    gamesEl.className = 'game-grid category-games';
    gamesEl.hidden = true;

    cat.games.forEach((game, gi) => {
      const card = document.createElement('div');
      card.className = 'game-card';
      card.tabIndex = 0;

      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = game.title;
      card.appendChild(title);

      const sys = document.createElement('div');
      sys.className = 'card-system';
      sys.textContent = game.systemLabel || game.system;
      card.appendChild(sys);

      card.addEventListener('click', () => {
        expandedCategoryIndex = ci;
        selectedGameIndex = gi;
        updateSelection();
        launchGame(game);
      });
      card.addEventListener('mouseenter', () => {
        if (expandedCategoryIndex !== ci) return;
        selectedGameIndex = gi;
        updateSelection();
      });

      gamesEl.appendChild(card);
    });

    catEl.appendChild(gamesEl);
    gameGrid.appendChild(catEl);
  });

  updateSelection();
}

// Only one category is expanded (accordion-style) - opening another
// collapses whichever was open, so keyboard/gamepad nav always has one
// unambiguous game grid to operate on.
function toggleCategory(ci) {
  if (expandedCategoryIndex === ci) {
    expandedCategoryIndex = -1;
  } else {
    expandedCategoryIndex = ci;
    selectedGameIndex = 0;
  }
  updateSelection();
  if (expandedCategoryIndex >= 0) {
    // The games grid must be unhidden (done by updateSelection above) before
    // offsetTop-based column detection can measure anything meaningful.
    computeColumns();
    updateSelection();
  }
}

function computeColumns() {
  if (expandedCategoryIndex < 0) { columns = 1; return; }
  const catEl = gameGrid.children[expandedCategoryIndex];
  const cards = catEl ? catEl.querySelector('.category-games').children : [];
  if (cards.length < 2) { columns = 1; return; }
  const firstTop = cards[0].offsetTop;
  let count = 1;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].offsetTop !== firstTop) break;
    count++;
  }
  columns = count;
}

function updateSelection() {
  const catEls = gameGrid.children;
  for (let ci = 0; ci < catEls.length; ci++) {
    const catEl = catEls[ci];
    const header = catEl.querySelector('.category-header');
    const gamesEl = catEl.querySelector('.category-games');
    const arrow = catEl.querySelector('.category-arrow');
    const isExpanded = ci === expandedCategoryIndex;

    gamesEl.hidden = !isExpanded;
    arrow.textContent = isExpanded ? '▼' : '▶';
    catEl.classList.toggle('expanded', isExpanded);
    header.classList.toggle('selected', expandedCategoryIndex === -1 && ci === focusedCategoryIndex);

    if (isExpanded) {
      const cards = gamesEl.children;
      for (let gi = 0; gi < cards.length; gi++) {
        cards[gi].classList.toggle('selected', gi === selectedGameIndex);
      }
      if (cards[selectedGameIndex]) {
        cards[selectedGameIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }
  if (expandedCategoryIndex === -1 && catEls[focusedCategoryIndex]) {
    catEls[focusedCategoryIndex].querySelector('.category-header').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function moveFolderSelection(dy) {
  if (categories.length === 0) return;
  let next = focusedCategoryIndex + dy;
  if (next < 0) next = 0;
  if (next >= categories.length) next = categories.length - 1;
  focusedCategoryIndex = next;
  updateSelection();
}

function moveGameSelection(dx, dy) {
  const cat = categories[expandedCategoryIndex];
  if (!cat || cat.games.length === 0) return;
  let next = selectedGameIndex;
  if (dx !== 0) {
    next = selectedGameIndex + dx;
  } else if (dy !== 0) {
    next = selectedGameIndex + dy * columns;
  }
  if (next < 0) next = 0;
  if (next >= cat.games.length) next = cat.games.length - 1;
  selectedGameIndex = next;
  updateSelection();
}

async function launchGame(game) {
  stopMusic();
  try {
    const res = await fetch('/api/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: game.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Launch failed', 4000);
      unlockMusic();
      playMusic();
      return;
    }
    if (data.type === 'html5') {
      playerFrame.src = data.url;
      playerOverlay.hidden = false;
      exitBtn.hidden = true;
    } else if (data.type === 'rom') {
      showToast(`Launching "${game.title}" in RetroArch...`);
    }
  } catch (err) {
    showToast('Launch failed: ' + err.message, 4000);
    unlockMusic();
    playMusic();
  }
}

function closePlayer() {
  playerOverlay.hidden = true;
  playerFrame.src = 'about:blank';
  exitBtn.hidden = false;
  unlockMusic();
  playMusic();
}

async function shutdownServer() {
  if (!confirm('Stop the arcade server? You will need to relaunch it to play again.')) return;
  exitBtn.disabled = true;
  showToast('Stopping server...', 8000);
  stopMusic();
  try {
    await fetch('/api/shutdown', { method: 'POST' });
  } catch (err) {
    // Server closing the connection while responding is expected here.
  }
  showToast('Server stopped. You can close this tab.', 8000);
}

exitBtn.addEventListener('click', shutdownServer);

chooseBtn.addEventListener('click', () => {
  setScreen('grid');
  loadGames();
});

playerClose.addEventListener('click', closePlayer);

document.addEventListener('keydown', (e) => {
  if (!playerOverlay.hidden) {
    if (e.key === 'Escape') closePlayer();
    return;
  }

  if (currentScreen === 'select') {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseBtn.click();
    }
    return;
  }

  if (currentScreen === 'grid' && expandedCategoryIndex === -1) {
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveFolderSelection(-1); break;
      case 'ArrowDown': e.preventDefault(); moveFolderSelection(1); break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (categories[focusedCategoryIndex]) toggleCategory(focusedCategoryIndex);
        break;
      case 'Escape':
        e.preventDefault();
        setScreen('select');
        break;
    }
    return;
  }

  if (currentScreen === 'grid' && expandedCategoryIndex !== -1) {
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); moveGameSelection(0, -1); break;
      case 'ArrowDown': e.preventDefault(); moveGameSelection(0, 1); break;
      case 'ArrowLeft': e.preventDefault(); moveGameSelection(-1, 0); break;
      case 'ArrowRight': e.preventDefault(); moveGameSelection(1, 0); break;
      case 'Enter': {
        e.preventDefault();
        const cat = categories[expandedCategoryIndex];
        if (cat && cat.games[selectedGameIndex]) launchGame(cat.games[selectedGameIndex]);
        break;
      }
      case 'Escape':
        e.preventDefault();
        toggleCategory(expandedCategoryIndex);
        break;
    }
  }
});

/* ---------- Gamepad API (up to 4 controllers) ---------- */
const GAMEPAD_REPEAT_MS = 180;
const padState = {}; // index -> { lastMoveAt, prevButtons }

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const now = performance.now();

  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (!pad) continue;
    if (i > 3) break; // up to 4 controllers

    if (!padState[i]) padState[i] = { lastMoveAt: 0, prevButtons: [] };
    const state = padState[i];

    const axisX = pad.axes[0] || 0;
    const axisY = pad.axes[1] || 0;
    const dpadUp = pad.buttons[12] && pad.buttons[12].pressed;
    const dpadDown = pad.buttons[13] && pad.buttons[13].pressed;
    const dpadLeft = pad.buttons[14] && pad.buttons[14].pressed;
    const dpadRight = pad.buttons[15] && pad.buttons[15].pressed;
    const btnA = pad.buttons[0] && pad.buttons[0].pressed;
    const btnB = pad.buttons[1] && pad.buttons[1].pressed;

    const up = dpadUp || axisY < -0.5;
    const down = dpadDown || axisY > 0.5;
    const left = dpadLeft || axisX < -0.5;
    const right = dpadRight || axisX > 0.5;

    if (now - state.lastMoveAt > GAMEPAD_REPEAT_MS) {
      if (currentScreen === 'grid' && expandedCategoryIndex === -1) {
        if (up) { moveFolderSelection(-1); state.lastMoveAt = now; }
        else if (down) { moveFolderSelection(1); state.lastMoveAt = now; }
      } else if (currentScreen === 'grid') {
        if (up) { moveGameSelection(0, -1); state.lastMoveAt = now; }
        else if (down) { moveGameSelection(0, 1); state.lastMoveAt = now; }
        else if (left) { moveGameSelection(-1, 0); state.lastMoveAt = now; }
        else if (right) { moveGameSelection(1, 0); state.lastMoveAt = now; }
      }
    }

    const prevA = state.prevButtons[0] || false;
    const prevB = state.prevButtons[1] || false;

    if (btnA && !prevA) {
      if (!playerOverlay.hidden) {
        // ignore, in-game
      } else if (currentScreen === 'select') {
        chooseBtn.click();
      } else if (currentScreen === 'grid' && expandedCategoryIndex === -1) {
        if (categories[focusedCategoryIndex]) toggleCategory(focusedCategoryIndex);
      } else if (currentScreen === 'grid') {
        const cat = categories[expandedCategoryIndex];
        if (cat && cat.games[selectedGameIndex]) launchGame(cat.games[selectedGameIndex]);
      }
    }

    if (btnB && !prevB) {
      if (!playerOverlay.hidden) closePlayer();
      else if (currentScreen === 'grid' && expandedCategoryIndex !== -1) toggleCategory(expandedCategoryIndex);
      else if (currentScreen === 'grid') setScreen('select');
    }

    state.prevButtons[0] = btnA;
    state.prevButtons[1] = btnB;
  }

  requestAnimationFrame(pollGamepads);
}

requestAnimationFrame(pollGamepads);

/* ---------- Autoplay unlock ---------- */
// Browsers block audio autoplay until a real user gesture occurs. Try
// immediately (works if the tab already has audio permission), and
// retry on the first click/key/touch otherwise.
['click', 'keydown', 'touchstart'].forEach((evt) => {
  document.addEventListener(evt, playMusic, { once: true });
});

setScreen('select');
