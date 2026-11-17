// ==UserScript==
// @name         Polarmed: сбор структуры страницы
// @namespace    local.polarmed-slot-hunter
// @version      0.1.0
// @description  По кнопке сохраняет структуру форм без значений полей и персональных данных. Не выполняет запись или отмену.
// @match        https://reg.polarmed.ru/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
// Контракт Polarmed, восстановленный по клиенту singup-build.js.
// Чистый контракт: сетевые вызовы находятся в polarmed-platform.js.
(function (root) {
  'use strict';

  const ORIGIN = 'https://reg.polarmed.ru';
  const VIEWS = new Set([
    'DistrictFormView', 'ClinicFormView', 'PatientCheckView',
    'SpecialityFormView', 'DoctorFormView', 'AppointmentSelectFormView',
    'SingUpValidateFormView', 'DoctorScheduleFormView',
  ]);

  function requireSuccess(result) {
    if (!result || result.success !== true) {
      // Не пробрасываем серверное ErrorDescription: там могут быть ФИО/полис.
      throw new Error('Polarmed не подтвердил успешное получение данных');
    }
    return result.response;
  }

  function identifier(value) {
    if ((typeof value !== 'string' && typeof value !== 'number') ||
        (typeof value === 'number' && !Number.isFinite(value)) || !String(value).trim()) {
      throw new Error('В ответе Polarmed отсутствует идентификатор');
    }
    return String(value);
  }

  function optionalIdentifier(value) {
    if (value == null || typeof value === 'string' && !value.trim()) return '';
    return identifier(value);
  }

  function localIso(value, day) {
    if (!value || typeof value !== 'object' || typeof value.iso !== 'string') {
      throw new Error('В талоне отсутствует дата в формате ISO');
    }
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value.iso);
    if (!match) throw new Error('Неизвестный формат времени талона');
    const iso = match[3] ? value.iso : value.iso + '+03:00';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new Error('Некорректная дата талона');
    // Часовой пояс Мурманской области — UTC+3, без сезонного перевода.
    const local = new Date(ms + 3 * 3600000).toISOString();
    if (local.slice(0, 10) !== day || (value.time && local.slice(11, 16) !== value.time)) {
      throw new Error('Дата или часовой пояс талона не согласуются с расписанием');
    }
    return iso;
  }

  function parseSlots(result) {
    const response = requireSuccess(result);
    // Публичный doctor_schedule возвращает недели-массивы. Это не талоны!
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Ожидались свободные талоны, а не общее расписание врача');
    }
    const out = [];
    const seen = new Map();
    for (const [day, entries] of Object.entries(response)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(entries)) {
        throw new Error('Неизвестная структура списка талонов');
      }
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') throw new Error('Некорректный талон');
        if (entry.deny) continue;
        const slot = {
          id: identifier(entry.id),
          startTime: localIso(entry.date_start, day),
          endTime: localIso(entry.date_end, day),
          siteStartTime: entry.date_start.iso,
        };
        if (Date.parse(slot.endTime) <= Date.parse(slot.startTime)) {
          throw new Error('Конец талона не позже начала');
        }
        const previous = seen.get(slot.id);
        if (previous) {
          if (previous.startTime !== slot.startTime || previous.endTime !== slot.endTime) {
            throw new Error('Один идентификатор талона соответствует разным интервалам');
          }
          continue;
        }
        seen.set(slot.id, slot);
        out.push(slot);
      }
    }
    return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  }

  function parseDoctors(result) {
    const response = requireSuccess(result);
    if (!Array.isArray(response)) throw new Error('Неизвестная структура списка врачей');
    return response.map((doctor) => {
      if (!doctor || typeof doctor.Name !== 'string') throw new Error('Неизвестная структура врача');
      return { id: identifier(doctor.IdDoc), name: doctor.Name,
        freeCount: Number.isFinite(Number(doctor.CountFreeParticipantIE))
          ? Math.max(0, Number(doctor.CountFreeParticipantIE)) : null };
    });
  }

  // Только поля, которые использует SingUpValidateForm.collectData().
  // Объект живёт в памяти и не должен сохраняться в настройках/журнале.
  function bookingFields({ clinicId, historyId, patientId, appointmentId, session, sessionExpires, csrf }) {
    return {
      'appointment_form-clinic_id': identifier(clinicId),
      // В свободной записи история обращения может отсутствовать.
      // Передаём пустое поле, а не строку "undefined" и не выдуманный ID.
      'appointment_form-history_id': optionalIdentifier(historyId),
      'appointment_form-patient_id': identifier(patientId),
      'appointment_form-appointment_id': identifier(appointmentId),
      'appointment_form-n3_session': identifier(session),
      'appointment_form-n3_session_expired_time': identifier(sessionExpires),
      'appointment_form-referal_id': '', // Именно referal, как в клиенте сайта.
      csrfmiddlewaretoken: identifier(csrf),
    };
  }

  function sameOriginAction(action) {
    const url = new URL(action, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) {
      throw new Error('Запросы разрешены только к reg.polarmed.ru');
    }
    return url.pathname + url.search;
  }

  // Отчёт о структуре, а не копия DOM: значения input, текст страницы,
  // localStorage, cookies и URL-параметры принципиально не читаются.
  function safePath(value) {
    try {
      const url = new URL(value, ORIGIN);
      if (url.origin !== ORIGIN) return '[external]';
      return url.pathname.split('/').map((part) =>
        /^[a-zA-Z_.-]*$/.test(part) && part.length <= 64 ? part : '[value]').join('/');
    } catch (_) { return '[invalid]'; }
  }

  function inspectPage(document, pathname) {
    return {
      format: 'polarmed-structure-v1',
      page: safePath(pathname),
      scripts: Array.from(document.querySelectorAll('script[src]'), (script) => safePath(script.getAttribute('src'))),
      links: Array.from(new Set(Array.from(document.querySelectorAll('a[href]'), (link) => safePath(link.getAttribute('href')))
        .filter((path) => /^\/(?:signup|profile|api|appointment|referral)(?:\/|$)/.test(path)))),
      forms: Array.from(document.querySelectorAll('form'), (form) => {
        const container = form.closest('[data-view]');
        const view = container && container.getAttribute('data-view');
        return {
          view: VIEWS.has(view) ? view : null,
          action: safePath(form.getAttribute('action') || pathname),
          method: (form.getAttribute('method') || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
          fields: Array.from(form.querySelectorAll('input[name],select[name],textarea[name],button[name]'), (field) => {
            const name = field.getAttribute('name') || '';
            // Не экспортируем нестандартные имена, которые могут содержать ID.
            return /^(?:[a-zA-Z_-]{1,100}|(?:clinic|patient|doctor|speciality|appointment)_form-n3_session(?:_expired_time)?)$/.test(name)
              ? name : '[nonstandard-name]';
          }),
        };
      }),
      views: Array.from(document.querySelectorAll('[data-view]'), (element) => element.getAttribute('data-view'))
        .filter((view) => VIEWS.has(view)),
    };
  }

  const api = { parseSlots, parseDoctors, bookingFields, optionalIdentifier, sameOriginAction, inspectPage };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PolarmedContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

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

})();
