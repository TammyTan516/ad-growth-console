// SPDX-License-Identifier: MIT
// This adapter stores demo metadata only. It has no chat or advertising API.
(() => {
  'use strict';
  const storageKey = 'ad-growth-console.demo.v1';
  const warning = document.getElementById('storage-warning');
  let widgetState;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      const saved = parsed?.privateContent;
      if (saved?.version !== 1 || !saved.state || typeof saved.state !== 'object' || Array.isArray(saved.state)) {
        throw new Error('Unsupported demo snapshot');
      }
      widgetState = parsed;
    }
  } catch (_) {
    if (warning) warning.textContent = '无法恢复演示记录，已打开新演示。';
  }
  window.demoHost = {
    widgetState,
    async setWidgetState(payload) {
      // Quota/security failures reject and remain visible through the app's save status.
      const serialized = JSON.stringify(payload);
      window.localStorage.setItem(storageKey, serialized);
      this.widgetState = JSON.parse(serialized);
    }
  };
  document.getElementById('reset-demo')?.addEventListener('click', () => {
    if (!window.confirm('删除当前浏览器内的演示记录并重新开始？')) return;
    try {
      window.localStorage.removeItem(storageKey);
      window.location.reload();
    } catch (_) {
      if (warning) warning.textContent = '无法删除浏览器中的演示记录。';
    }
  });
})();
