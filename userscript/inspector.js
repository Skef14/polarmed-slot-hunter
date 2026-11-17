(function () {
  'use strict';
  if (window.__polarmedInspectorMounted) return;
  window.__polarmedInspectorMounted = true;

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'closed' });
  const button = document.createElement('button');
  button.textContent = 'Polarmed: сохранить структуру';
  button.style.cssText = 'padding:12px 16px;border:0;border-radius:10px;background:#245bcc;color:white;cursor:pointer;font:14px sans-serif';
  button.title = 'Без значений полей, ФИО, полиса, cookie и токенов';
  button.addEventListener('click', () => {
    try {
      const report = globalThis.PolarmedContract.inspectPage(document, location.pathname);
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // Имя не содержит адреса страницы или параметров пациента.
      link.download = 'polarmed-structure-' + Date.now() + '.json';
      shadow.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {
      button.textContent = 'Не удалось сохранить. Обновите страницу';
    }
  });
  shadow.appendChild(button);
  document.body.appendChild(host);
})();
