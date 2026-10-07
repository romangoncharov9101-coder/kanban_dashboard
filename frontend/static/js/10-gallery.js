'use strict';
// Галерея изображений и лайтбокс.
// Часть фронтенда TaskBoard: файлы грузятся по порядку номеров (см. index.html).

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ВЛОЖЕНИЯ-КАРТИНКИ: галерея в карточке + полноэкранный просмотр (лайтбокс)
// ─────────────────────────────────────────────────────────────────────────────

// Тип берём из content_type, но у файлов, ожидающих отправки, его может
// не быть — тогда ориентируемся на расширение.
function isImageAttachment(a) {
  if (!a) return false;
  if (a.content_type) return a.content_type.startsWith('image/');
  return /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(a.filename || '');
}

function imageAttachments(attachments) {
  return (attachments || []).filter(isImageAttachment);
}

function attachmentUrl(cardId, attachmentId) {
  return `${API}/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}/download`;
}

// Файл ещё не на сервере — показываем его прямо из памяти браузера,
// иначе до сохранения карточки превью бы не было вовсе.
let _pendingPreviewUrls = [];
function _pendingPreviewUrl(file) {
  if (!file) return '';
  if (!file.__previewUrl) {
    file.__previewUrl = URL.createObjectURL(file);
    _pendingPreviewUrls.push(file.__previewUrl);
  }
  return file.__previewUrl;
}
function _revokePendingPreviews() {
  _pendingPreviewUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
  _pendingPreviewUrls = [];
  (pendingFiles || []).forEach(f => { delete f.__previewUrl; });
}

// ── Галерея миниатюр внутри окна карточки ───────────────────────────────────
function _renderAttachmentsGallery(attachments) {
  const box = document.getElementById('attachments-gallery');
  if (!box) return;

  const cardId = document.getElementById('card-edit-id')?.value || '';

  lightboxItems = imageAttachments(attachments).map(a => ({
    id: a.id,
    filename: a.filename || 'изображение',
    isPending: !!a.isPending,
    src: a.isPending ? _pendingPreviewUrl(a._file) : (cardId ? attachmentUrl(cardId, a.id) : '')
  })).filter(it => it.src);

  box.innerHTML = '';
  if (!lightboxItems.length) { box.style.display = 'none'; return; }
  box.style.display = '';

  lightboxItems.forEach((it, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'att-thumb' + (it.isPending ? ' att-thumb-pending' : '');
    btn.title = `${it.filename} — открыть`;
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openLightbox(i); };

    const img = document.createElement('img');
    img.src = it.src;
    img.alt = it.filename;
    img.loading = 'lazy';
    // Битую ссылку прячем целиком: пустая серая плитка выглядит как баг.
    img.onerror = () => { btn.style.display = 'none'; };
    btn.appendChild(img);

    if (it.isPending) {
      const badge = document.createElement('span');
      badge.className = 'att-thumb-badge';
      badge.textContent = 'ждёт';
      btn.appendChild(badge);
    }

    const name = document.createElement('span');
    name.className = 'att-thumb-name';
    name.textContent = it.filename;
    btn.appendChild(name);

    box.appendChild(btn);
  });
}

// Индекс картинки в лайтбоксе по id вложения (для клика по строке списка).
function _lightboxIndexOf(attachmentId) {
  return lightboxItems.findIndex(it => String(it.id) === String(attachmentId));
}

// ── Лайтбокс ────────────────────────────────────────────────────────────────
let lightboxItems = [];
let lightboxIndex = 0;

function openLightbox(index) {
  const dlg = document.getElementById('modal-lightbox');
  if (!dlg || !lightboxItems.length) return;
  lightboxIndex = Math.max(0, Math.min(index || 0, lightboxItems.length - 1));
  _renderLightboxStrip();
  _showLightboxImage();
  if (!dlg.open) dlg.showModal();
}

function closeLightbox() {
  const dlg = document.getElementById('modal-lightbox');
  if (dlg && dlg.open) dlg.close();
}

function lightboxNext() { _lightboxGo(1); }
function lightboxPrev() { _lightboxGo(-1); }

function _lightboxGo(delta) {
  if (lightboxItems.length < 2) return;
  // По кругу: с последней — на первую. Так листание не упирается в тупик.
  lightboxIndex = (lightboxIndex + delta + lightboxItems.length) % lightboxItems.length;
  _showLightboxImage();
}

function _showLightboxImage() {
  const it = lightboxItems[lightboxIndex];
  if (!it) return;

  const img   = document.getElementById('lb-img');
  const spin  = document.getElementById('lb-spinner');
  const err   = document.getElementById('lb-error');
  const stage = document.getElementById('lb-stage');
  if (!img) return;

  img.classList.remove('zoomed');
  img.style.display = 'none';
  if (err) err.style.display = 'none';
  if (spin) spin.style.display = '';

  img.onload = () => {
    if (spin) spin.style.display = 'none';
    img.style.display = '';
  };
  img.onerror = () => {
    if (spin) spin.style.display = 'none';
    if (err) err.style.display = '';
  };
  img.alt = it.filename;
  img.src = it.src;
  // Картинка из кэша может не выстрелить onload — подстраховываемся.
  if (img.complete && img.naturalWidth) {
    if (spin) spin.style.display = 'none';
    img.style.display = '';
  }

  const counter = document.getElementById('lb-counter');
  if (counter) {
    counter.textContent = `${lightboxIndex + 1} / ${lightboxItems.length}`;
    counter.style.display = lightboxItems.length > 1 ? '' : 'none';
  }

  const nameEl = document.getElementById('lb-filename');
  if (nameEl) nameEl.textContent = it.filename;

  const dl = document.getElementById('lb-download');
  if (dl) {
    // У неотправленного файла нет ссылки на сервере — скачивать нечего.
    dl.style.display = it.isPending ? 'none' : '';
    dl.href = it.src;
    dl.download = it.filename;
  }

  const multi = lightboxItems.length > 1;
  const prev = document.getElementById('lb-prev');
  const next = document.getElementById('lb-next');
  const strip = document.getElementById('lb-strip');
  if (prev)  prev.style.display  = multi ? '' : 'none';
  if (next)  next.style.display  = multi ? '' : 'none';
  if (strip) strip.style.display = multi ? '' : 'none';

  if (stage) stage.scrollTo(0, 0);
  _highlightLightboxStrip();
}

function _renderLightboxStrip() {
  const strip = document.getElementById('lb-strip');
  if (!strip) return;
  strip.innerHTML = '';
  if (lightboxItems.length < 2) return;

  lightboxItems.forEach((it, i) => {
    const t = document.createElement('img');
    t.src = it.src;
    t.alt = it.filename;
    t.title = it.filename;
    t.onclick = () => { lightboxIndex = i; _showLightboxImage(); };
    strip.appendChild(t);
  });
}

function _highlightLightboxStrip() {
  const strip = document.getElementById('lb-strip');
  if (!strip) return;
  Array.from(strip.children).forEach((el, i) => el.classList.toggle('active', i === lightboxIndex));
  const active = strip.children[lightboxIndex];
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function toggleLightboxZoom() {
  const img = document.getElementById('lb-img');
  if (!img || img.style.display === 'none') return;
  img.classList.toggle('zoomed');
  if (!img.classList.contains('zoomed')) {
    const stage = document.getElementById('lb-stage');
    if (stage) stage.scrollTo(0, 0);
  }
}

// Клик по пустому полю вокруг картинки закрывает просмотр,
// клик по самой картинке — приближает (см. onclick у #lb-img).
function _lbStageClick(e) {
  if (e.target && e.target.id === 'lb-stage') closeLightbox();
}

function _initLightbox() {
  const dlg = document.getElementById('modal-lightbox');
  if (!dlg) return;

  document.addEventListener('keydown', (e) => {
    if (!dlg.open) return;
    if (e.key === 'ArrowRight')     { e.preventDefault(); lightboxNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); lightboxPrev(); }
    else if (e.key === 'Home')      { e.preventDefault(); lightboxIndex = 0; _showLightboxImage(); }
    else if (e.key === 'End')       { e.preventDefault(); lightboxIndex = lightboxItems.length - 1; _showLightboxImage(); }
  });

  dlg.addEventListener('close', () => {
    const img = document.getElementById('lb-img');
    if (img) { img.classList.remove('zoomed'); img.removeAttribute('src'); }
  });

  // Свайп на телефоне. При увеличенной картинке не мешаем прокрутке.
  const stage = document.getElementById('lb-stage');
  if (stage) {
    let sx = 0, sy = 0, st = 0;
    stage.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now();
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const img = document.getElementById('lb-img');
      if (img && img.classList.contains('zoomed')) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t || !st || Date.now() - st > 700) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        dx < 0 ? lightboxNext() : lightboxPrev();
      }
      st = 0;
    }, { passive: true });
  }

  // Блобы живут до закрытия окна карточки, иначе превью «ждущих» файлов
  // отвалится прямо во время работы с формой.
  const cardModal = document.getElementById('modal-card');
  if (cardModal) cardModal.addEventListener('close', () => {
    closeLightbox();
    _revokePendingPreviews();
    lightboxItems = [];
  });

  // Esc тоже закрывает <dialog> — событие 'cancel' отменяемо и стреляет
  // до 'close'. Всегда гасим нативное закрытие и решаем сами, через общий
  // guard (который умеет спросить пользователя про черновик комментария).
  if (cardModal) cardModal.addEventListener('cancel', (e) => {
    e.preventDefault();
    requestCloseCardModal();
  });
}
