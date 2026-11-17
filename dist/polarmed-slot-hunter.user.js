// ==UserScript==
// @name         Polarmed: охотник за слотами
// @namespace    local.polarmed-slot-hunter
// @version      0.3.2
// @description  Ищет талон у любого врача выбранной специальности или у конкретного врача на reg.polarmed.ru. Без отмены старых записей.
// @author       Based on polinalamponi/emias-slot-hunter (MIT); Polarmed adaptation
// @homepageURL  https://github.com/Skef14/polarmed-slot-hunter
// @supportURL   https://github.com/Skef14/polarmed-slot-hunter/issues
// @match        https://reg.polarmed.ru/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
MIT License

Copyright (c) 2026 Polina

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

(function () {
'use strict';
/* ---- adapters/polarmed.js ---- */
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

/* ---- adapters/polarmed-platform.js ---- */
// Адаптер свободной записи. Не умеет и никогда не вызывает отмену записи.
(function (root) {
  'use strict';

  const WAIT = 'Войдите на Polarmed, выберите поликлинику, пациента и специальность. Дождитесь списка врачей. Конкретного врача выбирать не нужно. Затем нажмите «Проверить выбор и открыть настройки».';
  const REVIEW = 'Попытка записи уже была. Проверьте личный кабинет, прежде чем разрешать новую попытку. Старые записи не отменялись.';
  const BOOK = '/api/signup/';
  const LIST = '/api/appointment_list/';
  const REGISTER = '/signup/create-appointment/';
  const DOCTORS = '/api/doctor_list/';

  class SessionError extends Error {
    constructor(message) { super(message); this.name = 'SessionError'; }
  }

  function readSiteData(env = root) {
    // У менеджеров userscript глобальные переменные страницы могут быть
    // видны по-разному. Не привязываемся только к window.requirejs.
    const apps = [];
    if (env.app) apps.push(env.app);
    for (const loader of [env.requirejs, env.require]) {
      if (typeof loader !== 'function') continue;
      try { apps.push(loader('app')); } catch (_) { /* модуль пока не загружен */ }
    }
    for (const app of apps) {
      if (!app || !app.view) continue;
      try {
        const data = app.view.getVerboseData();
        if (data && data.preset && data.preset.additional && data.clinic && data.speciality) return data;
      } catch (_) { /* несвязанный незаполненный шаг не должен ломать чтение */ }
      const data = {};
      for (const form of app.view.forms || []) {
        if (!form.settings || !['preset', 'clinic', 'speciality', 'doctor'].includes(form.settings.modelValueName)) continue;
        try {
          const part = form.getVerboseData();
          if (part) data[part.key] = part.data;
        } catch (_) { /* шаг ещё не выбран */ }
      }
      if (data.preset && data.preset.additional && data.clinic && data.speciality) return data;
    }

    // Резервный путь без доступа к JS страницы: только явно выбранный preset
    // из маршрута и его штатное хранилище Amplify. Не берём «первого пациента».
    let route;
    try {
      const hash = env.location && env.location.hash;
      if (!hash || hash.length > 10000) throw new Error();
      const steps = JSON.parse(decodeURIComponent(hash.slice(1)));
      if (!Array.isArray(steps) || steps.length > 16) throw new Error();
      route = {};
      for (const step of steps) {
        if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error();
        for (const key of ['clinic', 'speciality', 'preset', 'doctor']) {
          if (!Object.hasOwn(step, key)) continue;
          if (!['string', 'number'].includes(typeof step[key])) throw new Error();
          if (Object.hasOwn(route, key)) throw new Error();
          route[key] = step[key];
        }
      }
    } catch (_) {
      throw new Error('P_CONTEXT: Не удалось прочитать выбор со страницы. Откройте свободную запись, выберите пациента и специальность, дождитесь списка врачей.');
    }
    if (typeof route.preset !== 'string' || !route.preset || route.clinic == null || route.speciality == null) {
      throw new Error('P_SELECTION: На сайте ещё не завершён выбор пациента и специальности. ' + WAIT);
    }
    const field = (id) => {
      const node = env.document.getElementById(id);
      return node && node.value || '';
    };
    for (const [key, id] of [['clinic', 'id_clinic_form-clinic_id'], ['speciality', 'id_speciality_form-speciality_id']]) {
      const selected = field(id);
      if (selected && String(selected) !== String(route[key])) {
        throw new Error('P_TRANSITION: Сайт ещё переключает выбор. Дождитесь загрузки списка врачей и повторите проверку.');
      }
    }
    let preset;
    for (const name of ['localStorage', 'sessionStorage']) {
      try {
        const store = env[name];
        if (!store) continue;
        const saved = JSON.parse(store.getItem('__amplify__presets'));
        if (!saved || saved.expires && saved.expires <= Date.now()) continue;
        const item = saved.data && Object.hasOwn(saved.data, route.preset) && saved.data[route.preset];
        if (!item || !item.additional || item.additional.patient_id == null) continue;
        if (preset && String(preset.additional.patient_id) !== String(item.additional.patient_id)) {
          throw new Error('P_AMBIGUOUS');
        }
        preset = item;
      } catch (error) {
        if (error.message === 'P_AMBIGUOUS') throw new Error('P_AMBIGUOUS: Данные пациента расходятся между хранилищами. Повторите выбор пациента на сайте.');
      }
    }
    if (!preset) throw new Error('P_PATIENT: Сохранённый выбор пациента недоступен или устарел. Снова заполните шаг пациента на сайте; данные присылать не нужно.');
    const item = (selector, id) => Array.from(env.document.querySelectorAll(selector))
      .find((node) => node.getAttribute('data-id') === String(id));
    const clinic = item('#clinic_list li[data-id]', route.clinic);
    const speciality = item('#speciality_list li[data-id]', route.speciality);
    if (!clinic || !speciality) throw new Error('P_LIST: Список поликлиник или специальностей ещё не загружен. Повторите выбор на сайте.');
    const clinicName = clinic.querySelector('.clinic_name');
    const doctor = route.doctor == null ? null : item('#doctor_list li[data-id]', route.doctor);
    return {
      preset, clinic: { id: route.clinic, title: clinicName ? clinicName.textContent : clinic.textContent,
        data: { title: clinicName ? clinicName.textContent : clinic.textContent, address: clinic.getAttribute('data-address') || '' } },
      speciality: { id: route.speciality, title: speciality.textContent },
      doctor: doctor ? { id: route.doctor, title: doctor.textContent } : null,
    };
  }

  // Используем уже загруженную модель сайта: в DOM часть patient_id/history_id
  // не заполняется, клиент добавляет их из preset непосредственно при запросе.
  function browserContext() {
    if (!root.navigator || !root.navigator.locks || !root.crypto || !root.crypto.subtle) {
      throw new Error('Нужен современный браузер с Web Locks и Web Crypto. Попробуйте актуальный Chrome, Edge или Firefox.');
    }
    const data = readSiteData();
    const additional = data.preset && data.preset.additional;
    if (!additional || !data.clinic || !data.speciality) throw new Error(WAIT);
    const value = (id) => {
      const field = root.document.getElementById(id);
      return field ? field.value : '';
    };
    const cookie = root.document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('csrftoken='));
    const csrf = cookie ? decodeURIComponent(cookie.slice('csrftoken='.length)) : '';
    const form = root.document.querySelector('[data-view="DoctorFormView"] form');
    const booking = root.document.querySelector('[data-view="SingUpValidateFormView"] form');
    const doctors = root.document.querySelector('[data-view="SpecialityFormView"] form');
    const context = {
      clinicId: data.clinic.id, doctorId: data.doctor && data.doctor.id, specialityId: data.speciality.id,
      patientId: additional.patient_id, historyId: additional.history_id,
      session: value('id_clinic_form-n3_session'),
      sessionExpires: value('id_clinic_form-n3_session_expired_time'), csrf,
      appointmentType: value('id_doctor_form-appointment_type'),
      listAction: form && form.getAttribute('action'),
      bookingAction: booking && booking.getAttribute('action'),
      doctorsAction: doctors && doctors.getAttribute('action'),
      doctorName: data.doctor && data.doctor.title, specialityName: data.speciality.title,
      clinicName: data.clinic.data && data.clinic.data.title || data.clinic.title,
      address: data.clinic.data && data.clinic.data.address || '',
      // Только в памяти и только для штатного запроса create-appointment.
      patientFio: [data.preset.last_name, data.preset.first_name, data.preset.middle_name].filter(Boolean).join(' '),
    };
    return context;
  }

  async function browserScope(context) {
    const bytes = new TextEncoder().encode(JSON.stringify([String(context.patientId), String(context.clinicId)]));
    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function browserLock(fn) {
    if (!root.navigator.locks) throw new Error('Браузер не поддерживает безопасную блокировку вкладок. Используйте актуальный Chrome, Edge или Firefox.');
    return root.navigator.locks.request('polarmed-slot-hunter:booking', { mode: 'exclusive' }, fn);
  }

  function browserVerify(html, context, candidate) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // create-claim.js подтверждает эти атрибуты существующей записи.
    // Кнопки отмены только читаем — никогда не нажимаем и не вызываем их URL.
    return Array.from(doc.querySelectorAll('[data-claim][data-appointment-id]')).some((node) =>
      node.getAttribute('data-appointment-id') === String(candidate.slot.id) &&
      node.getAttribute('data-clinic-id') === String(context.clinicId) &&
      node.getAttribute('data-patient-id') === String(context.patientId));
  }

  function makePlatform({ contract = root.PolarmedContract, readContext = browserContext,
    scopeOf = browserScope, withLock = browserLock, verifyProfile = browserVerify } = {}) {
    return { create({ storage, fetch, now, filters }) {
      let backoff = 0;
      let networkStep = 0;
      const JOURNAL = 'polarmedSlotHunter:attempt:';

      async function context() {
        const c = await readContext();
        if (!c) throw new Error('P_CONTEXT: Контекст страницы недоступен. ' + WAIT);
        const required = { patientId: 'пациент', clinicId: 'поликлиника', specialityId: 'специальность',
          session: 'внутренняя сессия сайта', sessionExpires: 'срок сессии', csrf: 'защитный токен сайта' };
        const missing = Object.keys(required).filter((key) => c[key] == null || String(c[key]).trim() === '');
        if (missing.length) throw new Error('P_FIELDS: Не получены поля: ' + missing.map((key) => required[key]).join(', ') + '. Повторите выбор пациента и специальности на сайте.');
        if (contract.sameOriginAction(c.listAction) !== LIST || contract.sameOriginAction(c.bookingAction) !== BOOK ||
            contract.sameOriginAction(c.doctorsAction) !== DOCTORS) {
          throw new Error('Формы Polarmed изменились. Запись заблокирована до проверки адаптера.');
        }
        return { ...c, historyId: contract.optionalIdentifier(c.historyId), scope: await scopeOf(c) };
      }

      async function bound(t) {
        const c = await context();
        if (t.scenario !== 'polarmedBook' || !t.source || c.scope !== t.source.scope ||
          String(c.clinicId) !== String(t.source.clinicId) || String(c.specialityId) !== String(t.source.specialityId) ||
          (!t.source.anyDoctor && (!t.source.doctorId || String(c.doctorId) !== String(t.source.doctorId)))) {
          throw new Error('Пациент, врач, специальность или поликлиника изменились. Пройдите настройку заново.');
        }
        return c;
      }

      function journal(c) {
        // Повреждённую запись не считаем отсутствием предыдущей попытки.
        return storage.getItem(JOURNAL + c.scope);
      }

      async function request(path, fields) {
        const method = fields === undefined ? 'GET' : 'POST';
        // Жёсткий белый список: отмена и произвольные адреса невозможны.
        if (![DOCTORS, LIST, BOOK, REGISTER, '/profile/'].includes(path)) throw new Error('Запрос не разрешён');
        if (now() < backoff) throw new Error('Polarmed попросил паузу. Проверка отложена.');
        const headers = { Accept: method === 'GET' ? 'text/html' : 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
        if (fields) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          if (fields.csrfmiddlewaretoken) headers['X-CSRFToken'] = fields.csrfmiddlewaretoken;
        }
        let response;
        try {
          response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store',
            redirect: 'error', signal: AbortSignal.timeout(30000),
            ...(fields ? { body: new URLSearchParams(fields).toString() } : {}) });
        } catch (_) {
          const waits = [30000, 60000, 120000, 300000];
          backoff = now() + waits[Math.min(networkStep++, waits.length - 1)];
          throw new Error('Нет ответа от Polarmed. После попытки записи обязательно проверьте личный кабинет.');
        }
        networkStep = 0;
        if (response.status === 401 || response.status === 403) throw new SessionError('Вход или сессия Polarmed истекли. Войдите заново и снова выберите пациента и специальность на сайте.');
        if (response.status === 429 || response.status >= 500) backoff = now() + 60000;
        if (!response.ok) throw new Error('Polarmed отклонил запрос (HTTP ' + response.status + ').');
        const text = await response.text();
        if (method === 'GET') return text;
        try { return JSON.parse(text); } catch (_) {
          // Клиент сайта не использует тело ответа этого вспомогательного
          // запроса. Успех всё равно проверяется отдельным GET /profile/.
          if (path === REGISTER) return null;
          throw new Error('Polarmed вернул не JSON. Возможно, нужно войти заново.');
        }
      }

      function listFields(c, doctorId) {
        return {
          'doctor_form-doctor_id': doctorId, 'doctor_form-clinic_id': c.clinicId,
          'doctor_form-patient_id': c.patientId, 'doctor_form-history_id': c.historyId,
          'doctor_form-n3_session': c.session, 'doctor_form-n3_session_expired_time': c.sessionExpires,
          'doctor_form-appointment_type': c.appointmentType || '', csrfmiddlewaretoken: c.csrf,
        };
      }

      async function doctorsFor(t, c) {
        if (!t.source.anyDoctor) return [{ id: String(t.source.doctorId), name: c.doctorName || t.title }];
        const result = await request(DOCTORS, {
          'speciality_form-speciality_id': c.specialityId, 'speciality_form-clinic_id': c.clinicId,
          'speciality_form-patient_id': c.patientId, 'speciality_form-history_id': c.historyId,
          'speciality_form-n3_session': c.session, 'speciality_form-n3_session_expired_time': c.sessionExpires,
          csrfmiddlewaretoken: c.csrf,
        });
        // Счётчики талонов могут запаздывать: нулевой счётчик не исключает врача.
        return Array.from(new Map(contract.parseDoctors(result).map((doctor) => [doctor.id, doctor])).values());
      }

      async function search(t, ctx, onlyDoctor) {
        const c = await bound(t);
        if (journal(c)) return { candidates: [], rejected: [], notes: [REVIEW], action: 'stopTarget' };
        if (t.respectTravel) throw new Error('Автоматический учёт других записей на Polarmed пока недоступен. Проверьте пересечения вручную.');
        const address = c.address || '';
        if (t.addressContains && !address.toLowerCase().includes(t.addressContains.toLowerCase())) {
          return { candidates: [], rejected: [], notes: ['Адрес не соответствует условиям'], action: null };
        }
        if (ctx.isActive && !ctx.isActive()) return { candidates: [], rejected: [], notes: ['Поиск остановлен'], action: null };
        const doctors = await doctorsFor(t, c);
        const notes = ['Старые записи не отменяются. Пересечения и дорогу проверяйте самостоятельно.'];
        const rejected = [];
        for (const doctor of doctors) {
          if (onlyDoctor != null && doctor.id !== String(onlyDoctor)) continue;
          if (ctx.isActive && !ctx.isActive()) break;
          // Последовательно, без параллельного потока запросов. При 429/5xx
          // request бросает исключение и останавливает весь проход.
          const result = await request(LIST, listFields(c, doctor.id));
          let slots;
          try { slots = contract.parseSlots(result); }
          catch (_) {
            if (!t.source.anyDoctor) throw new Error('Не удалось разобрать талоны выбранного врача.');
            notes.push('Не удалось проверить талоны врача: ' + doctor.name);
            continue;
          }
          const picked = filters.pickSlots({ slots, target: t, now: ctx.now, appointments: [], addressOf: () => address });
          rejected.push(...picked.rejected);
          if (picked.ok.length) return {
            candidates: picked.ok.map((slot) => ({ slot: { ...slot, doctorName: doctor.name },
              address, resourceId: doctor.id, complexResourceId: c.clinicId, name: doctor.name })),
            rejected, notes, action: null,
          };
        }
        return { candidates: [], rejected, notes, action: null };
      }

      async function act(t, candidate, ctx) {
        return withLock(async () => {
          const c = await bound(t);
          if (journal(c)) return { ok: false, verified: false, action: 'stopTarget', message: REVIEW };
          // Перечитываем талон и фильтры: за 60 секунд подтверждения он мог уйти.
          const fresh = await search(t, { now: now(), appointments: [], isActive: ctx.isActive }, candidate.resourceId);
          const found = fresh.candidates.find((item) => item.slot.id === candidate.slot.id &&
            item.resourceId === candidate.resourceId &&
            item.slot.startTime === candidate.slot.startTime && item.slot.endTime === candidate.slot.endTime);
          if (!found) return { ok: false, verified: false, action: 'retry', message: 'Талон уже недоступен или больше не подходит.' };
          const live = await bound(t);
          if (!ctx.isActive()) return { ok: false, verified: false, message: 'Поиск остановлен. Запрос записи не отправлен.' };
          // До первого изменяющего запроса сохраняем метку. Даже при перезагрузке,
          // потере ответа или одновременной второй вкладке нельзя записать повторно.
          storage.setItem(JOURNAL + live.scope, JSON.stringify({ at: now(), status: 'attempted', ticketId: found.slot.id }));
          try {
            const result = await request(BOOK, contract.bookingFields({ ...live, appointmentId: found.slot.id }));
            if (!result || result.success !== true) {
              return { ok: false, verified: false, action: 'stopTarget',
                message: 'Polarmed не подтвердил запись: талон мог уйти или новая запись запрещена при существующей. Проверьте личный кабинет. Старая запись не отменялась.' };
            }
            // Второй штатный запрос клиента сохраняет запись для личного кабинета.
            // ФИО берётся из живой модели сайта, в настройки/лог не попадает.
            const registered = await request(REGISTER, {
              app_id: found.slot.id, patient_id: live.patientId, patient_fio: live.patientFio,
              lpu_id: live.clinicId, lpu: live.clinicName, speciality_id: live.specialityId,
              speciality: live.specialityName, doctor_id: found.resourceId, doctor: found.name,
              date: found.slot.siteStartTime, csrfmiddlewaretoken: live.csrf,
            });
            if (registered && registered.success === false) throw new Error('Не подтверждено сохранение в личном кабинете');
            const html = await request('/profile/');
            if (!verifyProfile(html, live, found)) {
              return { ok: false, verified: false, action: 'stopTarget', message: 'Сайт принял запрос, но запись не удалось независимо проверить в личном кабинете. Проверьте её вручную. Повторная запись заблокирована.' };
            }
            storage.setItem(JOURNAL + live.scope, JSON.stringify({ at: now(), status: 'verified', ticketId: found.slot.id }));
            return { ok: true, verified: true, message: 'Новый талон виден в личном кабинете. Старую запись при необходимости отмените вручную после проверки.' };
          } catch (_) {
            return { ok: false, verified: false, action: 'stopTarget', message: 'Результат попытки неизвестен. Запись могла состояться. Проверьте личный кабинет; повторные попытки заблокированы. Старые записи не отменялись.' };
          }
        });
      }

      return {
        init: async () => { await context(); return { ok: true }; },
        // Сессия сайта cookie+n3, а не токены Polarmed. Продление ЕСИА не эмулируем.
        session: { needsRefresh: () => false, refresh: async () => false, refreshedAt: 0 },
        // Полный список записей/интервалов неизвестен. UI явно отключает travel,
        // и search дополнительно запрещает его вместо выдумывания расписания.
        api: { appointments: async () => [], backoffUntil: () => backoff },
        discover: { list: async () => {
          const c = await context();
          const any = { id: 'polarmed:' + c.scope + ':speciality:' + c.specialityId, scenario: 'polarmedBook',
            title: 'Любой врач: ' + (c.specialityName || 'выбранная специальность'), current: null,
            address: c.address || null, deadline: null, supported: true, source: {
              scope: c.scope, clinicId: String(c.clinicId), specialityId: String(c.specialityId),
              anyDoctor: true, address: c.address || '',
            } };
          if (c.doctorId == null || String(c.doctorId).trim() === '') return [any];
          return [{ id: 'polarmed:' + c.scope + ':' + c.doctorId, scenario: 'polarmedBook',
            title: c.doctorName || 'Выбранный врач', current: null, address: c.address || null,
            deadline: null, supported: true, source: {
              scope: c.scope, clinicId: String(c.clinicId), specialityId: String(c.specialityId),
              doctorId: String(c.doctorId), address: c.address || '',
            } }, any];
        } },
        targets: { search, act },
        normalizeTarget: (t) => ({ ...t, keepImproving: false }),
        reviewAttempt: async () => withLock(async () => {
          const c = await context();
          storage.removeItem(JOURNAL + c.scope);
        }),
      };
    } };
  }

  const api = { makePlatform, browserVerify, readSiteData };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PolarmedPlatform = makePlatform();
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/util.js ---- */
// core/util.js
(function (root) {
  'use strict';

  const VERSION = '0.1.5';
  const TZ = 'Europe/Moscow';

  function createUtil() {
    const fmt = (d, opts) => d.toLocaleString('sv-SE', { timeZone: TZ, ...opts });
    const mskDate = (d = new Date()) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
    const mskTime = (d = new Date()) => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false });
    const mskDateTime = (d = new Date()) => fmt(d, { hour12: false });
    const hasZone = (iso) => /[+-]\d\d:?\d\d$|Z$/.test(String(iso).slice(10));
    const toMs = (iso) => new Date(hasZone(iso) ? iso : iso + '+03:00').getTime();
    const slotHHMM = (iso) => mskTime(new Date(toMs(iso)));
    const distTo = (range, startMs, endMs) =>
      Math.max(0, toMs(range.start) - endMs, startMs - toMs(range.end));
    const campus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim().toLowerCase();
    const jitter = (ms, rnd = Math.random) => Math.round(ms * (0.8 + rnd() * 0.4));

    return { VERSION, mskDate, mskTime, mskDateTime, toMs, slotHHMM, distTo, campus, jitter };
  }

  const api = { VERSION, createUtil };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/errors.js ---- */
// core/errors.js
(function (root) {
  'use strict';

  function createErrors() {
    const mask = (text) => String(text == null ? '' : text)
      // Проход 1: маскирование по имени поля JSON
      .replace(/"(omsNumber|birthDate|birthdate|patientId|snils|fio|firstName|lastName|middleName|patronymic)"\s*:\s*"[^"]*"/g, (m) => {
        const key = m.match(/"([^"]+)"/)[1];
        return '"' + key + '":"<скрыто>"';
      })
      // Проход 2: полис (16 и более цифр подряд)
      .replace(/\d{16,}/g, '<полис>')
      // Проход 3: дата ISO (YYYY-MM-DD)
      .replace(/\b(19|20)\d\d-\d\d-\d\d(?=["' ]|$)/g, (m) => (Number(m.slice(0, 4)) < 2020 ? '<дата рождения>' : m))
      // Проход 4: дата DD.MM.YYYY
      .replace(/\b(\d{1,2})\.(\d{1,2})\.((19|20)\d\d)\b/g, (m) => {
        const year = Number(m.split('.')[2]);
        return (year >= 1900 && year <= 2019) ? '<дата рождения>' : m;
      })
      // Проход 5: ФИО (полное имя с отчеством)
      .replace(/\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(вич|вна|ична)\b/g, '<ФИО>');

    const KNOWN = {
      SA_SAME_BM_IS_NOT_AVAILABLE: { message: 'Вы уже записаны на это исследование — перехожу в режим переноса.', action: 'switchToShift' },
      SA_REFERRAL_EXPIRED: { message: 'Направление истекло — цель отключена.', action: 'stopTarget' },
      SA_APPOINTMENT_NOT_FOUND: { message: 'Запись не найдена: возможно, её отменили или перенесли в другом месте.', action: 'stopTarget' },
      // Живой ответ Polarmed и на перенос уже начавшейся записи, и на приём
      // без направления (ЦЖЗ), который сайт этим путём переносить не даёт.
      SA_APPOINTMENT_CANNOT_BE_CANCELED: { message: 'Polarmed не даёт перенести эту запись: приём уже начался, запись отменена или такой перенос сайт не разрешает. Цель остановлена.', action: 'stopTarget' },
    };

    function explain({ status, code, text }) {
      if (code && KNOWN[code]) return KNOWN[code];
      // I4: в реальном пути 401 сюда не доходит — core/api.js сам перехватывает
      // 401 до вызова explain() (один раз продлевает сессию и повторяет запрос,
      // а при повторном 401 сразу бросает SessionError с тем же по смыслу
      // текстом, см. api.js), поэтому явное действие пользователю показывает
      // именно то исключение. Ветка ниже остаётся ради других вызывающих кодов
      // explain() напрямую (см. test/errors.test.js) и на случай, если этот
      // порядок обработки 401 в api.js когда-нибудь изменится — тест ниже
      // прямо помечен как проверка explain() в изоляции, а не сквозного пути.
      if (status === 401) return { message: 'Polarmed перестал принимать вход. Войдите заново в другой вкладке — поиск продолжится сам.', action: 'relogin' };
      if (status === 429) return { message: 'Polarmed просит не частить — пауза 30 секунд.', action: 'wait' };
      if (status >= 500) return { message: 'Polarmed временно отвечает ошибкой — пауза 30 секунд.', action: 'wait' };
      return { message: 'Непонятный ответ Polarmed: ' + mask(text).slice(0, 300), action: 'retry' };
    }

    return { mask, explain };
  }

  const api = { createErrors };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/filters.js ---- */
// core/filters.js
(function (root) {
  'use strict';

  function createFilters(util) {
    const { toMs, slotHHMM, distTo, campus } = util;

    // Можно ли занять слот, не нарушив другие записи того же дня: между записями
    // в разных кампусах нужен запас travelMs на дорогу, в одном и том же — можно впритык.
    function travelOk({ selfId, address, slot, appointments, travelMs }) {
      const s = toMs(slot.startTime);
      const e = toMs(slot.endTime);
      const day = slot.startTime.slice(0, 10);
      for (const a of appointments || []) {
        if (selfId != null && a.id === selfId) continue;
        if (a.startTime.slice(0, 10) !== day) continue;
        const gap = campus(a.lpuAddress) === campus(address) ? 0 : travelMs;
        if (s < toMs(a.endTime) + gap && e > toMs(a.startTime) - gap) return false;
      }
      return true;
    }

    function pickSlots({ slots, target: t, now, appointments, addressOf }) {
      const cur = t.current ? toMs(t.current) : null;
      const ok = [];
      const rejected = [];
      const reject = (slot, reason) => rejected.push({ slot, reason });

      // onlyIfConflict: не трогаем запись, если она ни с чем не пересекается —
      // тогда искать замену незачем, возвращаем пустой результат с пометкой skipped.
      if (t.onlyIfConflict && cur != null) {
        const self = (appointments || []).find((a) => a.id === t.selfId);
        const hasConflict = self ? !travelOk({
          selfId: t.selfId, address: self.lpuAddress,
          slot: { startTime: self.startTime, endTime: self.endTime },
          appointments, travelMs: t.travelMs,
        }) : false;
        if (!hasConflict) return { ok: [], rejected: [], skipped: 'конфликта нет' };
      }

      // Для режима near расстояние текущей записи до желаемого интервала — точка
      // отсчёта: слот принимаем только если он ближе к near, чем сама текущая запись.
      let curDist = null;
      if (t.near && cur != null) {
        const self = (appointments || []).find((a) => a.id === t.selfId);
        curDist = self ? distTo(t.near, toMs(self.startTime), toMs(self.endTime)) : distTo(t.near, cur, cur);
      }

      for (const slot of slots) {
        const s = toMs(slot.startTime);
        const day = slot.startTime.slice(0, 10);
        if (s - now < t.minLeadMs) { reject(slot, `слишком скоро (меньше ${Math.round(t.minLeadMs / 3600000)} ч)`); continue; }
        if (t.onlyDay && day !== t.onlyDay) { reject(slot, 'другой день'); continue; }
        if (t.dateFrom && day < t.dateFrom) { reject(slot, 'раньше выбранной даты'); continue; }
        if (t.dateTo && day > t.dateTo) { reject(slot, 'позже выбранной даты'); continue; }
        if (t.timeFrom && slotHHMM(slot.startTime) < t.timeFrom) { reject(slot, 'раньше выбранного времени'); continue; }
        if (t.timeTo && slotHHMM(slot.startTime) > t.timeTo) { reject(slot, 'позже выбранного времени'); continue; }
        if (cur != null && s === cur) { reject(slot, 'это и есть текущая запись'); continue; }
        if (t.near) {
          if (curDist != null && distTo(t.near, s, toMs(slot.endTime)) >= curDist) { reject(slot, 'не ближе к нужной записи'); continue; }
        } else if (cur != null && !t.anyTime && s >= cur) { reject(slot, 'позже текущей записи'); continue; }
        if (t.respectTravel && !travelOk({ selfId: t.selfId, address: addressOf(slot), slot, appointments, travelMs: t.travelMs })) {
          reject(slot, 'не успеть доехать между записями'); continue;
        }
        ok.push(slot);
      }

      if (t.near) {
        // Сортируем по близости к желаемому интервалу near (0 = пересекается с ним).
        ok.sort((a, b) => distTo(t.near, toMs(a.startTime), toMs(a.endTime)) - distTo(t.near, toMs(b.startTime), toMs(b.endTime)));
      } else if (t.anyTime && cur != null) {
        // При anyTime ориентируемся на время текущей записи: ближайшие по модулю — первыми.
        ok.sort((a, b) => Math.abs(toMs(a.startTime) - cur) - Math.abs(toMs(b.startTime) - cur));
      } else {
        // prefer поднимает наверх слоты, попадающие в предпочтительное окно
        // (день не позже prefer.until и, если задано, время раньше prefer.timeTo);
        // внутри каждой группы (предпочтительные / остальные) — по возрастанию времени.
        const preferred = (slot) => (t.prefer
          && slot.startTime.slice(0, 10) <= t.prefer.until
          && (!t.prefer.timeTo || slotHHMM(slot.startTime) < t.prefer.timeTo) ? 0 : 1);
        ok.sort((a, b) => preferred(a) - preferred(b) || toMs(a.startTime) - toMs(b.startTime));
      }

      return { ok, rejected };
    }

    return { pickSlots, travelOk };
  }

  const api = { createFilters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/runner.js ---- */
// core/runner.js — цикл проверок целей: обязательный холостой прогон перед
// стартом, обнаружение сна компьютера, «протухание» проверок и режим
// подтверждения. Время приходит только через now()/timer — прямой
// Date.now()/setTimeout здесь не используются, чтобы тесты были быстрыми и
// детерминированными.
(function (root) {
  'use strict';

  function hash(obj) {
    const s = JSON.stringify(obj);
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'dr' + Math.abs(h);
  }

  // Ключ кандидата — чтобы после «не смог проверить» не повторять попытку
  // ровно на том же слоте прямо на следующем тике (риск задвоить запись).
  function candidateKey(cand) {
    return cand.resourceId + ':' + cand.complexResourceId + ':' + cand.slot.startTime;
  }

  // Срок жизни метки «не тот же слот» после verifyFailed. Если слот всё это
  // время остаётся единственным кандидатом, цель не должна зависать на нём
  // бессрочно — по истечении срока попытка на том же слоте снова разрешена.
  const VERIFY_FAILED_TTL_MS = 10 * 60 * 1000;

  // Поля, которые finish() может изменить сам при keepImproving после
  // успешной мутации (перенос на более удобное время). Их исключаем из
  // отпечатка гейта холостого прогона — иначе успешный перенос будет каждый
  // раз ложно требовать новый холостой прогон, хотя человек ничего не менял.
  function gateFingerprint(list) {
    return hash(list.map((t) => {
      const { current, source, scenario, ...rest } = t;
      return rest;
    }));
  }

  function createRunner({ targets, api, session, timer, now, emit, config }) {
    const state = {
      running: false,
      list: [],
      byId: {},
      confirmed: null,
      lastReport: null,
      lastTickAt: 0,
      // Время последней НАСТОЯЩЕЙ проверки — ставится только в tick().
      // lastTickAt при start() тоже взводится (точка отсчёта для обнаружения
      // сна), поэтому для показа «проверено в …» он не годится.
      lastCheckAt: 0,
      lastOkAt: 0,
      staleNotified: false,
      pending: {},
      verifyFailedKey: {},
      leadershipHandlers: [],
    };

    const log = (msg) => emit('log', { at: now(), msg });
    // Нижняя граница интервала — 20 секунд, чтобы не нагружать Polarmed, даже
    // если когда-нибудь захочется настроить более «быстрый» slowMs.
    const interval = () => Math.max(config.minIntervalMs, config.slowMs);

    function setTargets(list) {
      state.list = list.map((t) => ({ ...t }));
      state.byId = {};
      state.verifyFailedKey = {};
      for (const t of state.list) state.byId[t.id] = { state: 'idle', note: '' };
      // Смена целей обнуляет подтверждение холостого прогона — иначе можно
      // было бы подтвердить одни цели, а незаметно подставить другие.
      // lastReport тоже устаревает — иначе confirmDryRun() смог бы принять
      // id старого отчёта, снятого по прежнему списку целей.
      state.confirmed = null;
      state.lastReport = null;
    }

    async function appointments() {
      if (api.appointments) return api.appointments();
      const r = await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {});
      return (r.json && r.json.payload && r.json.payload.appointment) || [];
    }

    // Запись, которая уже есть по направлению цели новой записи (bookLab,
    // bookDoctor, bookLdp). Кровь узнаём по МО и виду анализа (у таких
    // назначений нет номера направления), врача и исследование — по номеру
    // направления в самой записи.
    function existingAppointment(t, appts) {
      const s = t.source || {};
      if (t.scenario === 'bookLab') {
        return appts.find((a) => a.toBM && Number(a.toBM.id) === Number(s.samplingTypeId) && String(a.lpuId) === String(s.moId)) || null;
      }
      if (t.scenario === 'bookDoctor' || t.scenario === 'bookLdp') {
        if (s.referralId == null) return null;
        const kind = t.scenario === 'bookDoctor' ? 'toDoctor' : 'toLdp';
        return appts.find((a) => a[kind] && a.referral && String(a.referral.referralId) === String(s.referralId)) || null;
      }
      return null;
    }

    // Перед поиском сверяем цель новой записи со списком записей: если по
    // направлению запись уже есть (была при старте, охотник поймал её, но
    // ответ потерялся, или человек записался сам), цель становится переносом
    // этой записи и дальше ищет слот раньше неё. Без этого охотник продолжал
    // искать новую запись по уже занятому направлению и получал от Polarmed
    // ошибку на каждой проверке. Возвращает true, если цель изменилась.
    function adoptExisting(t, appts) {
      const a = existingAppointment(t, appts);
      if (!a || !a.startTime) return false;
      const when = a.startTime.slice(0, 16).replace('T', ' ');
      if (t.keepImproving === false) {
        const message = `по направлению уже есть запись на ${when}`;
        state.byId[t.id] = { state: 'done', note: message };
        emit('targetDone', { targetId: t.id, title: t.title, message });
        return true;
      }
      t.current = a.startTime + '+03:00';
      if (t.scenario === 'bookDoctor') {
        t.source = {
          ...t.source, appointmentId: a.id, lpuId: a.lpuId || t.source.lpuId,
          specialityName: (a.toDoctor && a.toDoctor.specialityName) || t.title,
        };
        t.scenario = 'shiftDoctor';
      } else if (t.scenario === 'bookLdp') {
        t.source = { ...t.source, appointmentId: a.id, lpuId: a.lpuId || t.source.lpuId };
        t.scenario = 'shiftLdp';
      } else {
        t.source = { ...t.source, appointmentId: a.id, moId: a.lpuId || t.source.moId };
        t.scenario = 'shiftLab';
      }
      log(`${t.title}: по направлению уже есть запись на ${when} — ищу слот раньше и переношу`);
      // Обвязка сохраняет цели отдельно (см. C1 в finish()), поэтому новые
      // current/source/scenario отдаём событием, как и после своей записи.
      emit('targetUpdated', { targetId: t.id, title: t.title, current: t.current, source: t.source, scenario: t.scenario });
      return true;
    }

    function buildWarnings(t, best, r, appts) {
      const w = [];
      if (best && t.addressContains && !best.address.toLowerCase().includes(String(t.addressContains).toLowerCase())) {
        w.push(`Адрес «${best.address}» не содержит «${t.addressContains}»`);
      }
      if (best && t.current && !t.anyTime && !t.near && new Date(best.slot.startTime) > new Date(t.current)) {
        w.push('Найденный слот позже текущей записи');
      }
      if (!best && r.rejected.length) {
        const why = {};
        for (const x of r.rejected) why[x.reason] = (why[x.reason] || 0) + 1;
        w.push('Слоты есть, но все отброшены: ' + Object.entries(why).map(([k, v]) => `${k} (${v})`).join(', '));
      }
      if (best) {
        const sameDay = appts.filter((a) => a.startTime.slice(0, 10) === best.slot.startTime.slice(0, 10));
        if (sameDay.length) w.push(`В этот день уже есть записи: ${sameDay.length}`);
      }
      return w;
    }

    async function dryRun() {
      const appts = await appointments();
      const items = [];
      for (const t of state.list) {
        adoptExisting(t, appts);
        if (state.byId[t.id].state === 'done') {
          items.push({ targetId: t.id, title: t.title, would: null, waiting: false, warnings: [], notes: [state.byId[t.id].note] });
          continue;
        }
        let r;
        try {
          r = await targets.search(t, { now: now(), appointments: appts });
        } catch (e) {
          // Холостой прогон не должен падать целиком из-за одной сбойной
          // цели — иначе человек не увидит отчёт по остальным целям и не
          // сможет ничего подтвердить. Сбой показываем как предупреждение.
          items.push({
            targetId: t.id, title: t.title, would: null, waiting: true,
            warnings: ['Проверка не выполнена: ' + (e && e.message)], notes: [],
          });
          continue;
        }
        const best = r.candidates[0] || null;
        items.push({
          targetId: t.id, title: t.title,
          would: best ? { ...best.slot, address: best.address } : null,
          waiting: !best,
          warnings: buildWarnings(t, best, r, appts),
          notes: r.notes,
        });
      }
      const report = { id: hash({ list: state.list, at: now() }), items, targetsHash: gateFingerprint(state.list) };
      state.lastReport = report;
      return report;
    }

    function confirmDryRun(id) {
      if (!state.lastReport || state.lastReport.id !== id) throw new Error('отчёт устарел, повторите холостой прогон');
      // Подтверждение фиксируется по отпечатку целей на момент этого отчёта
      // (см. gateFingerprint) — снимок, который переживает последующие
      // мутации current/source/scenario из keepImproving.
      state.confirmed = state.lastReport.targetsHash;
    }

    async function start() {
      if (state.confirmed !== gateFingerprint(state.list)) throw new Error('сначала холостой прогон и подтверждение');
      state.running = true;
      state.lastTickAt = now();
      state.lastCheckAt = 0; // в этом запуске проверок ещё не было
      // Точка отсчёта для обнаружения «протухания»: считаем именно от
      // старта, а не только от последней УДАЧНОЙ проверки — иначе если ни
      // одной успешной проверки так и не случится, stale не придёт никогда.
      state.lastOkAt = now();
      state.staleNotified = false;
      schedule();
    }

    function stop() {
      state.running = false;
      timer.cancel();
    }

    function schedule() {
      if (!state.running) return;
      const base = interval();
      // Небольшой джиттер (±20%), чтобы не долбить Polarmed строго по таймеру.
      // minIntervalMs — жёсткий пол ПОСЛЕ джиттера: даже нижняя граница
      // джиттера не должна увести фактическую задержку ниже 20 секунд.
      const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
      timer.schedule(Math.max(config.minIntervalMs, jittered), tick);
    }

    // Три исхода targets.act(): успех (ok && verified) — цель выполнена;
    // «не смогли проверить» (ok && !verified, включая явный verifyFailed) —
    // мутация могла пройти, но подтвердить не удалось: цель НЕ помечаем
    // выполненной и на этом же слоте не повторяемся прямо на следующем
    // тике; отказ (!ok) — смотрим action.
    async function finish(t, cand) {
      const appts = await appointments();
      const res = await targets.act(t, cand, { now: now(), appointments: appts,
        isActive: () => state.running && state.confirmed === gateFingerprint(state.list) });

      if (res.ok && res.verified) {
        state.byId[t.id] = { state: t.keepImproving ? 'improving' : 'done', note: res.message };
        delete state.verifyFailedKey[t.id];
        if (t.keepImproving && res.newAppointment) {
          t.current = res.newAppointment.startTime + '+03:00';
          const wasBookDoctor = t.scenario === 'bookDoctor';
          t.source = { ...t.source, appointmentId: res.newAppointment.id, moId: res.newAppointment.lpuId || t.source.moId };
          if (wasBookDoctor) {
            // Как и bookLab → shiftLab: после первой успешной записи по направлению
            // цель становится переносом уже СВОЕЙ записи. lpuId и specialityName
            // берём из только что созданной записи (appointmentId уже выставлен
            // строкой выше) — они нужны переносу для описания цели.
            t.source = {
              ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId,
              specialityName: (res.newAppointment.toDoctor && res.newAppointment.toDoctor.specialityName) || t.title,
            };
            t.scenario = 'shiftDoctor';
          } else if (t.scenario === 'bookLab') {
            t.scenario = 'shiftLab';
          } else if (t.scenario === 'bookLdp') {
            // referralId и ldpTypeId остаются в source — они нужны переносу.
            t.source = { ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId };
            t.scenario = 'shiftLdp';
          }
        }
        // C1: current/source/scenario идут в событие как есть ПОСЛЕ возможной мутации
        // выше — раннер меняет их только у себя в памяти (state.list), а обвязка
        // (userscript) хранит цели отдельно в localStorage (cfg.targets). Без этих
        // полей в payload обвязка не может обновить сохранённую цель и после
        // перезагрузки/захвата другой вкладкой стартует по УСТАРЕВШИМ current/source —
        // gateFingerprint намеренно не замечает эту рассинхронизацию (см. выше), так что
        // дыру не поймать ни один гейт, только сама доставка актуальных полей.
        emit('booked', {
          targetId: t.id, title: t.title, slot: cand.slot, address: cand.address, message: res.message,
          current: t.current, source: t.source, scenario: t.scenario,
        });
        return res;
      }

      if (res.ok && !res.verified) {
        // Не смогли подтвердить результат (verifyFailed или явное «готово,
        // но в списке не вижу») — не трогаем состояние цели и запоминаем
        // слот на VERIFY_FAILED_TTL_MS, чтобы не попытаться записаться на
        // него же ещё раз почти сразу; после истечения срока (или если
        // появится другой кандидат) попытка на этом слоте снова разрешена.
        state.verifyFailedKey[t.id] = { key: candidateKey(cand), expiresAt: now() + VERIFY_FAILED_TTL_MS };
        emit('found', { targetId: t.id, warning: res.message, slot: cand.slot, address: cand.address });
        return res;
      }

      // !res.ok — смотрим на action.
      if (res.action === 'stopTarget') {
        state.byId[t.id] = { state: 'stopped', note: res.message };
        emit('targetDone', { targetId: t.id, title: t.title, message: res.message });
      } else if (res.action === 'relogin') {
        emit('sessionLost', { message: res.message });
        return res;
      }
      // 'wait' | 'switchToShift' | 'retry' | null — обычный повтор на
      // следующем тике, состояние цели не меняем.
      emit('found', { targetId: t.id, warning: res.message, slot: cand.slot, address: cand.address });
      return res;
    }

    // Ответ пользователя на needConfirm (режим mode: 'confirm'). Раннер
    // может быть уже остановлен между needConfirm и ответом человека (или
    // намеренно, или из-за stop()) — в этом случае ничего в Polarmed не шлём,
    // заявка остаётся нетронутой на случай последующего запуска.
    async function answer(targetId, decision) {
      if (!state.running) return { ok: false, message: 'раннер остановлен, ответ не отправлен' };
      const p = state.pending[targetId];
      delete state.pending[targetId];
      if (!p) return { ok: false, message: 'решение уже не актуально' };
      if (decision !== 'book') {
        log(`${p.target.title}: пользователь отклонил слот`);
        return { ok: false };
      }
      return finish(p.target, p.candidate);
    }

    async function tick() {
      if (!state.running) return;

      // C2: гейт холостого прогона проверяем не только в start(), но и на
      // каждом тике — setTargets() может прийти уже во время работающего
      // цикла (мастер меняет условия, пока человек ещё читает холостой
      // прогон), и цикл не должен продолжать работать по неподтверждённым
      // целям до следующего запланированного tick().
      if (state.confirmed !== gateFingerprint(state.list)) {
        state.running = false;
        timer.cancel();
        emit('needDryRun', { message: 'цели изменились — нужен новый холостой прогон' });
        return;
      }

      // Обнаружение сна компьютера/вкладки: если между тиками прошло сильно
      // больше, чем должно быть по расписанию, — это не «мы решили не
      // проверять», а комп/браузер были неактивны.
      const gap = now() - state.lastTickAt;
      if (state.lastTickAt && gap > interval() * config.sleepFactor) {
        emit('slept', { from: state.lastTickAt, to: now(), missed: Math.round(gap / interval()) });
      }
      state.lastTickAt = now();
      state.lastCheckAt = now();

      try {
        if (session.needsRefresh(config.refreshAt)) await session.refresh();
        if (now() >= api.backoffUntil()) {
          const appts = await appointments();
          // I4: потеря сессии не должна засчитываться как успешная проверка —
          // оба break targetsLoop ниже взводят этот флаг, и lastOkAt/
          // staleNotified обновляются только если сессия жива.
          let relogin = false;
          targetsLoop:
          for (const t of state.list) {
            // C2: backoffUntil проверяли только один раз в начале tick() (выше) — но
            // targets.search() сам может нарваться на 429 ПОСЕРЕДИНЕ этого перебора
            // (например, у первой цели), и тогда без этой проверки раннер всё равно
            // продолжил бы дёргать Polarmed по остальным целям в том же тике.
            if (now() < api.backoffUntil()) break targetsLoop;
            const st = state.byId[t.id];
            // 'improving' — цель уже выполнена один раз, но keepImproving
            // просит продолжать искать более удобный слот, поэтому такую
            // цель не пропускаем, в отличие от 'done' и 'stopped'.
            if (st.state === 'done' || st.state === 'stopped') continue;
            if (state.pending[t.id]) continue; // ждём решения пользователя

            // Запись по направлению могла появиться во время работы (в том
            // числе руками на сайте) — тогда переходим в перенос, а не ищем
            // новую запись по занятому направлению.
            if (adoptExisting(t, appts) && state.byId[t.id].state === 'done') continue;

            // Текущая запись уже скоро (или прошла) — переносить её некуда:
            // слоты раньше неё отсеет minLeadMs, а Polarmed на перенос начавшейся
            // записи отвечает ошибкой. Завершаем цель, а не долбим сайт.
            if (t.current && Date.parse(t.current) - now() < (t.minLeadMs || 0)) {
              const message = `запись на ${String(t.current).slice(0, 16).replace('T', ' ')} уже скоро или прошла — больше не переношу`;
              state.byId[t.id] = { state: 'done', note: message };
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }

            const r = await targets.search(t, { now: now(), appointments: appts,
              isActive: () => state.running && state.confirmed === gateFingerprint(state.list) });

            if (r.action === 'stopTarget') {
              const message = (r.notes && r.notes.join('; ')) || 'цель остановлена';
              state.byId[t.id] = { state: 'stopped', note: message };
              // Та же реакция, что и на stopTarget из act() (см. finish()) —
              // кто следит только за событиями, должен узнать об остановке,
              // а не только по опросу status().
              emit('found', { targetId: t.id, warning: message, slot: null, address: null });
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }
            if (r.action === 'relogin') {
              relogin = true;
              emit('sessionLost', { message: (r.notes && r.notes.join('; ')) || 'потеряна сессия' });
              break targetsLoop; // сессия недействительна для всех целей сразу
            }

            if (!r.candidates.length) {
              if (r.notes && r.notes.length) log(`${t.title}: ${r.notes.join('; ')}`);
              continue;
            }

            const cand = r.candidates[0];
            const key = candidateKey(cand);
            const vf = state.verifyFailedKey[t.id];
            if (vf) {
              if (now() < vf.expiresAt && vf.key === key) {
                log(`${t.title}: пропускаю тот же слот после неудачной проверки, попробую другой на следующем тике`);
                continue;
              }
              // Либо срок истёк, либо появился другой кандидат — метка не актуальна.
              delete state.verifyFailedKey[t.id];
            }

            if (t.mode === 'confirm') {
              const expiresAt = now() + 60000;
              state.pending[t.id] = { target: t, candidate: cand, expiresAt };
              emit('needConfirm', { targetId: t.id, title: t.title, slot: cand.slot, address: cand.address, expiresAt });
              continue;
            }

            const res = await finish(t, cand);
            if (res.action === 'relogin') { relogin = true; break targetsLoop; }
          }
          if (!relogin) {
            state.lastOkAt = now();
            state.staleNotified = false;
          }
        }
      } catch (e) {
        if (e && e.name === 'SessionError') emit('sessionLost', { message: e.message });
        else log('сбой проверки: ' + (e && e.message));
      }

      // Протухание: считаем от старта/последней удавшейся проверки. Как
      // только разрыв достиг трёх интервалов — сообщаем один раз и молчим
      // до следующей удачной проверки (staleNotified сбрасывается выше).
      if (now() - state.lastOkAt >= interval() * config.staleFactor && !state.staleNotified) {
        state.staleNotified = true;
        emit('stale', { since: state.lastOkAt });
      }

      for (const [id, p] of Object.entries(state.pending)) {
        if (now() > p.expiresAt) { delete state.pending[id]; log('подтверждение не получено, слот пропущен'); }
      }

      schedule();
    }

    function status() {
      return {
        running: state.running,
        confirmed: state.confirmed === gateFingerprint(state.list),
        lastTickAt: state.lastTickAt,
        lastCheckAt: state.lastCheckAt,
        lastOkAt: state.lastOkAt,
        sessionRefreshedAt: session.refreshedAt,
        targets: state.list.map((t) => ({ id: t.id, title: t.title, current: t.current || null, ...state.byId[t.id] })),
        pending: Object.keys(state.pending),
      };
    }

    // Единая вкладка: у самого core/runner.js в зависимостях фабрики нет
    // ничего для межвкладочной координации (BroadcastChannel/локальная
    // блокировка и т.п. — их нет в списке Consumes этой задачи), поэтому
    // фактический выбор «лидера» среди вкладок браузера — забота обвязки
    // вне core/. Здесь — точка расширения: с точки зрения одного экземпляра
    // раннера он всегда лидер.
    function onLeadership(fn) {
      state.leadershipHandlers.push(fn);
      fn(true);
      return () => { state.leadershipHandlers = state.leadershipHandlers.filter((f) => f !== fn); };
    }

    return { setTargets, dryRun, confirmDryRun, start, stop, tick, answer, status, onLeadership };
  }

  const api = { createRunner };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/index.js ---- */
// core/index.js — сборка всех модулей ядра (util, errors, filters, session,
// api, discover, targets, runner) в единый объект EmiasHunter, плюс события
// и координация «одна активная вкладка» поверх channel.
//
// Важно: в отличие от остальных модулей ядра, этот файл не подключает своих
// соседей напрямую через модульную систему Node — так собранный userscript
// (dist/*.user.js) остался бы с таким подключением внутри, а тест сборки
// (Task 1) явно это запрещает. Вместо этого create() принимает соседей через
// параметр modules — плоский объект со всеми фабриками (createUtil,
// createErrors, ..., createRunner). Если modules не передан, берём
// globalThis.PolarmedCore: именно туда каждый core/*.js в браузерной сборке
// кладёт себя через `Object.assign(root.PolarmedCore, api)`, и после склейки
// всех файлов в одну IIFE (scripts/build.js) там уже лежит ровно тот же набор
// фабрик. В тестах modules собирают явно, каждый сосед по отдельности, — так
// ядро остаётся без прямого подключения модулей, а тест рабочим.
(function (root) {
  'use strict';

  // Нижняя граница интервала проверок — 20 секунд. Это жёсткий пол: даже
  // если снаружи передадут config с меньшими slowMs/minIntervalMs (случайно
  // или по недосмотру), фактический интервал раннера ниже этого порога не
  // опустится — чтобы не долбить Polarmed слишком часто.
  const MIN_INTERVAL_MS = 20000;

  // Раз в столько шлём в channel heartbeat работающей вкладки — см.
  // createSharedTimer ниже и Task 12c.
  const ALIVE_INTERVAL_MS = 20000;

  // identityFromStorage() не смогла определить полис и/или дату рождения —
  // ни через idToken/policy/list, ни явным opts.identity. Отдельное имя (как
  // SessionError в core/api.js) даёт userscript/ui-dom.js отличить этот
  // случай от настоящей потери сессии: там нужно другое, не вводящее в
  // заблуждение объяснение (см. Task после review бага с датой рождения).
  class IdentityError extends Error {
    constructor(message) {
      super(message);
      this.name = 'IdentityError';
    }
  }

  // Настоящий timer (что в браузере — воркер с единственным setTimeout
  // внутри, что в тестовой заглушке) держит только ОДНО отложенное
  // срабатывание одновременно — ровно то, что нужно раннеру: тики идут
  // строго по одному, и schedule()/cancel() раннера рассчитаны именно на
  // это. Но пока экземпляр работает, параллельно нужен ещё и независимый
  // периодический heartbeat (раз в ALIVE_INTERVAL_MS, что бы ни было
  // настроено раннеру в slowMs) — двум одновременным потребителям одного
  // и того же timer.schedule() просто наступить друг другу на pending-
  // колбэк нельзя. createSharedTimer делит единственный слот настоящего
  // timer между двумя логическими под-таймерами: tick — разовое
  // срабатывание, интерфейс которого (schedule/cancel) отдаём раннеру
  // взамен настоящего timer как есть; alive — периодическое, включается и
  // выключается самим core/index.js. В любой момент настоящий timer взведён
  // на ближайшее из двух отложенных срабатываний; сработав, будим все
  // под-таймеры, чьё время пришло, и переармируем.
  function createSharedTimer(realTimer, now) {
    const slots = { tick: null, alive: null }; // { fn, dueAt, everyMs (0 = разовый) }
    // Время (в шкале now()), на которое сейчас взведён настоящий timer — а
    // не заново считанный now() в момент срабатывания. В браузере разницы
    // почти нет (настоящее время и так успело дойти до dueAt), а вот в
    // тестах now() обычно фиксированная функция (время не «идёт» само по
    // себе, timer.schedule()/cancel() — просто заглушка с очередью
    // колбэков) — сверяться с повторным now() там было бы неверно: заново
    // считанное now() всегда останется МЕНЬШЕ dueAt, и ни один под-таймер
    // никогда не считался бы наступившим.
    let armedAt = null;

    function armSoonest() {
      let soonest = null;
      for (const key of Object.keys(slots)) {
        const s = slots[key];
        if (s && (soonest === null || s.dueAt < soonest)) soonest = s.dueAt;
      }
      // Сначала снимаем прежнее отложенное срабатывание, потом (если есть
      // что ждать) взводим новое — ровно ОДНО пере-взведение настоящего
      // timer на вызов armSoonest(), а не «ещё один поверх старого». Само
      // по себе schedule() настоящего Worker-таймера тоже заменяет
      // предыдущий отложенный вызов, но так это верно и для простых
      // тестовых заглушек timer (очередь без автозамены).
      realTimer.cancel();
      if (soonest === null) { armedAt = null; return; }
      armedAt = soonest;
      realTimer.schedule(Math.max(0, soonest - now()), onFire);
    }

    function onFire() {
      const t = armedAt === null ? now() : armedAt;
      for (const key of Object.keys(slots)) {
        const s = slots[key];
        if (!s || s.dueAt > t) continue;
        slots[key] = s.everyMs ? { ...s, dueAt: t + s.everyMs } : null;
        s.fn();
      }
      armSoonest();
    }

    return {
      tick: {
        schedule(ms, fn) { slots.tick = { fn, dueAt: now() + ms, everyMs: 0 }; armSoonest(); },
        cancel() { slots.tick = null; armSoonest(); },
      },
      startAlive(fn) { slots.alive = { fn, dueAt: now() + ALIVE_INTERVAL_MS, everyMs: ALIVE_INTERVAL_MS }; armSoonest(); },
      stopAlive() { slots.alive = null; armSoonest(); },
    };
  }

  function create({ storage, fetch, now = Date.now, timer, channel = null, config = {}, modules, instanceId, platform } = {}) {
    const M = modules || root.PolarmedCore;
    if (!M) {
      throw new Error('core/index.js: не переданы модули ядра (modules) и globalThis.PolarmedCore недоступен');
    }

    const util = M.createUtil();
    const errors = M.createErrors();
    const filters = M.createFilters(util);
    const integration = platform ? platform.create({ storage, fetch, now, filters, util }) : null;
    const session = integration ? integration.session : M.createSession({ storage, fetch, now });
    const api = integration ? integration.api : M.createApi({ session, errors, fetch, now });
    const discover = integration ? integration.discover : M.createDiscover({ api, today: () => util.mskDate(new Date(now())) });
    const targets = integration ? integration.targets : M.createTargets({ api, filters, util });

    // Простая шина событий: подписка по типу события ('log', 'found',
    // 'booked', 'needConfirm', 'sessionLost', 'stale', 'slept', 'standby', ...)
    // и подписка на всё сразу через '*'.
    const listeners = {};
    const emit = (type, payload) => {
      for (const fn of listeners[type] || []) fn(payload);
      for (const fn of listeners['*'] || []) fn({ type, payload });
    };

    const safeConfig = { slowMs: 20000, minIntervalMs: 20000, refreshAt: 0.6, sleepFactor: 3, staleFactor: 3, ...config };
    // Жёсткий пол применяем уже ПОСЛЕ разворачивания пользовательского config —
    // runner.js берёт Math.max(minIntervalMs, slowMs), поэтому если оба поля
    // занижены одновременно, пол внутри runner.js не спасёт.
    safeConfig.minIntervalMs = Math.max(MIN_INTERVAL_MS, safeConfig.minIntervalMs);
    safeConfig.slowMs = Math.max(MIN_INTERVAL_MS, safeConfig.slowMs);

    // Heartbeat нужен только когда координация вообще включена (есть
    // channel) — без него делить слот timer не с кем, раннер получает
    // настоящий timer как есть.
    const sharedTimer = channel ? createSharedTimer(timer, now) : null;
    const runner = M.createRunner({ targets, api, session, timer: sharedTimer ? sharedTimer.tick : timer, now, emit, config: safeConfig });

    // «Одна активная вкладка». Идентификатор экземпляра — по умолчанию
    // случайный (можно задать явно через instanceId — понадобилось тестам,
    // где важен детерминированный порядок арбитража). Побеждает БОЛЬШИЙ
    // идентификатор, а не тот, кто стартовал последним: при асинхронной
    // доставке (настоящий BroadcastChannel именно такой) сравнение «кто
    // последний» не работает — при одновременном старте обе вкладки могут
    // одновременно оказаться running и обе получить чужой claim, и тогда обе
    // остановились бы, если бы правило было «останавливаюсь при любом чужом
    // claim». Вместо этого:
    //  - если я сейчас работаю и получил claim с БОЛЬШИМ id — я проиграл,
    //    останавливаюсь и сообщаю об этом событием standby;
    //  - если я сейчас работаю и получил claim с МЕНЬШИМ id — я не
    //    останавливаюсь, а рассылаю свой claim ещё раз, чтобы тот экземпляр
    //    увидел больший id и остановился сам (без этого при одновременном
    //    старте могли бы остаться работающими оба);
    //  - если я сейчас не работаю — не реагирую вовсе (в т.ч. не отвечаю
    //    своим claim), иначе неработающие вкладки бы бесконечно перекидывались
    //    сообщениями между собой.
    // Если channel не передан (например, тесты или окружение без
    // BroadcastChannel), считаем себя единственными и координацию не включаем.
    const myId = instanceId || Math.random().toString(36).slice(2);

    // Heartbeat лидера (Task 12c): пока эта вкладка активно работает, она
    // раз в ALIVE_INTERVAL_MS шлёт { type: 'alive', from: myId } — самому
    // сообщению ни на что, кроме отметки времени у чужих вкладок, влиять не
    // положено (обработчик claim ниже не меняется). leaderSeenAtTs — время
    // последнего чужого alive ИЛИ claim; без channel координации нет вовсе,
    // и leaderSeenAt() всегда отдаёт 0. Используется в userscript/ui-dom.js:
    // standby-вкладка запускает дорогой startFromSavedConfig() только если
    // давно ничего не слышала от лидера, а не раз в минуту вслепую.
    let leaderSeenAtTs = 0;
    function sendAlive() {
      // Раннер мог остановиться сам (например, needDryRun на тике) в обход
      // stop()/арбитража — в этом случае heartbeat самоликвидируется, а не
      // продолжает выдавать вкладку за лидера, который на деле не работает.
      if (!runner.status().running) { sharedTimer.stopAlive(); return; }
      channel.postMessage({ type: 'alive', from: myId });
    }
    function startAlive() { if (sharedTimer) sharedTimer.startAlive(sendAlive); }
    function stopAlive() { if (sharedTimer) sharedTimer.stopAlive(); }

    if (channel) {
      channel.onmessage = (msg) => {
        const m = msg && msg.data ? msg.data : msg;
        if (!m || m.from === myId) return;
        // И alive, и claim от чужой вкладки означают «лидер сейчас жив» —
        // это ЕДИНСТВЕННОЕ, на что влияет alive; арбитраж по claim ниже
        // остаётся прежним.
        if (m.type === 'alive' || m.type === 'claim') leaderSeenAtTs = now();
        if (m.type !== 'claim') return;
        if (!runner.status().running) return;
        if (m.from > myId) {
          runner.stop();
          stopAlive();
          emit('standby', { by: m.from });
        } else if (m.from < myId) {
          channel.postMessage({ type: 'claim', from: myId });
        }
      };
    }

    // Настоящий idToken Polarmed даты рождения не содержит (проверено на живой
    // вкладке 2026-09-24: поля jti, exp, ua_ver, trusted, iat, sub, aud, amr,
    // sid, iss, ua_id, FirstName — birthdate/birth_date среди них нет).
    // Полис при этом в хранилище есть (persist:persist.persistOmsNumber).
    // Сам сайт берёт дату рождения из ответа GET /api-eip/v2/policy/list —
    // если её не нашлось в idToken, спрашиваем тот же список и берём дату из
    // полиса, чей omsNumber совпал с persistOmsNumber (в ответе может быть
    // несколько полисов, например старый и текущий). Дату рождения нигде не
    // сохраняем — она живёт только в session.identity() (в памяти), как и
    // раньше для явно введённой.
    async function birthFromPolicyList(oms) {
      if (!oms) return null; // сверять не с чем — не обращаемся вообще
      const r = await api.get('v2/policy/list');
      if (!r.ok || !r.json) return null;
      const policies = (r.json.payload && r.json.payload.policies) || [];
      const mine = policies.find((p) => p && p.omsNumber === oms);
      return (mine && String(mine.birthDate || '').slice(0, 10)) || null;
    }

    // Полис и дату рождения предпочтительно передают явно (opts.identity) —
    // например, их вводит пользователь в интерфейсе. Если их нет, пробуем
    // угадать из хранилища сайта, а если даты там нет — из policy/list; любая
    // ошибка разбора здесь не должна валить init() — просто вернём null и
    // вызывающий код попросит ввести их. Ошибка сессии (SessionError из
    // api.get) наоборот НЕ гасится — это не «не нашли данные», а настоящая
    // потеря входа, и она должна дойти до вызывающего кода как есть.
    async function identityFromStorage() {
      let oms = null;
      try { oms = JSON.parse(JSON.parse(storage.getItem('persist:persist')).persistOmsNumber); } catch (e) { oms = null; }
      let birth = null;
      try {
        const t = JSON.parse(JSON.parse(storage.getItem('persist:sessionAuth')).idToken);
        const payload = JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
        birth = (payload.birthdate || payload.birth_date || '').slice(0, 10) || null;
      } catch (e) { birth = null; }
      if (!birth) birth = await birthFromPolicyList(oms);
      return { oms, birth };
    }

    // Залогинен ли сам сайт. После выхода Polarmed стирает токены и полис, но
    // наша копия токенов (polarmedSlotHunter:auth) остаётся и session.read() её
    // принимает — без этой проверки человек видел бы «не нашла полис» вместо
    // «войдите».
    function siteLoggedIn() {
      try { return !!JSON.parse(JSON.parse(storage.getItem('persist:sessionAuth')).accessToken); } catch (e) { return false; }
    }

    async function init(opts = {}) {
      if (integration) return integration.init();
      // Бросает понятную ошибку, если входа в Polarmed нет вовсе — не глотаем.
      session.read();
      if (!opts.identity && !siteLoggedIn()) throw new Error('нет входа в Polarmed: войдите на сайте и попробуйте снова');
      const id = opts.identity || await identityFromStorage();
      if (!id.oms || !id.birth) {
        throw new IdentityError('не удалось определить полис и дату рождения — откройте раздел «Записи» на сайте и попробуйте снова');
      }
      session.setIdentity(id);
      return { ok: true };
    }

    // Список целей нормализуем перед передачей раннеру: keepImproving по
    // умолчанию включён (искать более удобный слот и после первой удачной
    // записи/переноса), кроме bookReferral — этот сценарий в v0.1 не
    // поддержан целиком (см. targets.js), «улучшать» там нечего. Явное
    // keepImproving: false в цели отключает поведение.
    function normalizeTarget(t) {
      if (integration && integration.normalizeTarget) return integration.normalizeTarget(t);
      return { ...t, keepImproving: t.keepImproving !== false && t.scenario !== 'bookReferral' };
    }

    return {
      init,
      reviewAttempt: () => integration && integration.reviewAttempt(),
      discover: () => discover.list(),
      setTargets: (list) => runner.setTargets(list.map(normalizeTarget)),
      dryRun: () => runner.dryRun(),
      confirmDryRun: (id) => runner.confirmDryRun(id),
      start: async () => {
        // Гейт холостого прогона проверяем ПЕРВЫМ: если runner.start() бросит
        // (прогон не подтверждён), claim в channel вообще не уходит — иначе
        // неудачная попытка старта во второй вкладке останавливала бы первую,
        // которая работает легитимно.
        await runner.start();
        if (channel) {
          channel.postMessage({ type: 'claim', from: myId });
          startAlive();
        }
        return { ok: true };
      },
      stop: () => { stopAlive(); return runner.stop(); },
      answer: (targetId, decision) => runner.answer(targetId, decision),
      status: () => runner.status(),
      leaderSeenAt: () => leaderSeenAtTs,
      on: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- userscript/ui-state.js ---- */
// userscript/ui-state.js — чистая логика мастера настройки (без DOM)
(function (root) {
  'use strict';

  const KEY = 'polarmedSlotHunter:config';
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // Цели визита для направления к врачу с needPurpose: true — сняты с сайта
  // emias.info 2026-09-24 (см. capture-2026-09-24-referral-doctor.md), это
  // единственные два варианта, которые сайт реально предложил для направления
  // к эндокринологу. 'unwell' — вариант по умолчанию.
  const INQUIRY_PURPOSES = {
    unwell: { inquiryPurposeId: 61, inquiryPurposeCode: 251, title: 'Плохое самочувствие или боль' },
    documents: { inquiryPurposeId: 63, inquiryPurposeCode: 255, title: 'Оформление документов' },
  };

  function createUiState() {
    const human = (iso) => {
      if (!iso) return '';
      const d = iso.slice(0, 10).split('-');
      return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}, ${iso.slice(11, 16)}`;
    };
    const stripCampus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim();
    const dayHuman = (ymd) => { const d = String(ymd).split('-'); return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}`; };

    function buildTarget(option, form) {
      // form.when — три взаимоисключающих варианта:
      //  - 'earlier': раньше текущей записи, день любой (onlyDay=null, anyTime=false);
      //  - 'sameDayEarlier': в тот же день, что текущая запись, но раньше неё
      //    (onlyDay = день текущей записи, anyTime=false; человек день не вводит);
      //  - 'onlyDay' (синоним 'anyTimeOnDay'): в выбранный человеком день, любое время
      //    (onlyDay = form.day, anyTime=true) — независимо от того, раньше или позже
      //    текущей записи выбранный день, иначе цель молча никогда ничего не находит.
      const currentDay = option.current ? String(option.current).slice(0, 10) : null;
      let onlyDay = null;
      let anyTime = false;
      if (form.when === 'sameDayEarlier') {
        onlyDay = currentDay;
      } else if (form.when === 'onlyDay' || form.when === 'anyTimeOnDay') {
        onlyDay = form.day || null;
        anyTime = true;
      }

      const deadline = option.deadline || null;
      // Искать за пределами срока действия направления бессмысленно — если человек
      // задал dateTo позже deadline (или deadline вообще не знал), обрезаем по deadline.
      const dateTo = !form.dateTo ? null : (deadline && deadline < form.dateTo ? deadline : form.dateTo);

      return {
        id: option.id, scenario: option.scenario, title: option.title, source: option.source,
        current: option.scenario === 'polarmedBook' && form.existingStart
          ? form.existingStart + ':00+03:00' : option.current || null,
        onlyDay,
        anyTime,
        dateFrom: form.dateFrom || null,
        dateTo,
        deadline,
        timeFrom: form.timeFrom || null,
        timeTo: form.timeTo || null,
        addressContains: form.where === 'sameCampus' ? stripCampus(option.address)
          : form.where === 'contains' ? (form.addressContains || null) : null,
        prefer: form.preferUntil ? { until: form.preferUntil, timeTo: form.preferTimeTo || null } : null,
        near: form.nearStart && form.nearEnd ? { start: form.nearStart, end: form.nearEnd } : null,
        respectTravel: option.scenario === 'polarmedBook' ? false : form.respectTravel !== false,
        travelMs: 60 * 60000,
        minLeadMs: 2 * 60 * 60000,
        keepImproving: option.scenario !== 'bookReferral' && option.scenario !== 'polarmedBook',
        mode: form.mode === 'confirm' ? 'confirm' : 'auto',
        purpose: (option.source && option.source.needPurpose) ? (() => {
          const chosen = INQUIRY_PURPOSES[form.purpose === 'documents' ? 'documents' : 'unwell'];
          return { inquiryPurposeId: chosen.inquiryPurposeId, inquiryPurposeCode: chosen.inquiryPurposeCode };
        })() : null,
      };
    }

    function purposeTitle(purpose) {
      const found = Object.values(INQUIRY_PURPOSES).find((p) => p.inquiryPurposeId === purpose.inquiryPurposeId);
      return found ? found.title : 'выбрана';
    }

    function describeTarget(t) {
      const parts = [];
      if (t.near) parts.push(`подгоняю ближе к ${human(t.near.start)}–${String(t.near.end).slice(11, 16)}`);
      else if (t.onlyDay && t.anyTime) parts.push(`любое время ${dayHuman(t.onlyDay)}`);
      else if (t.onlyDay && t.current) parts.push(`${dayHuman(t.onlyDay)}, раньше ${human(t.current)}`);
      else if (t.onlyDay) parts.push(`только ${dayHuman(t.onlyDay)}`);
      else if (t.current) parts.push(`раньше ${human(t.current)}`);

      // Если день не зафиксирован onlyDay, называем период поиска — иначе цель
      // без текущей записи (запись по направлению) не говорит о датах ничего.
      // Для bookDoctor и bookLdp дата уже называется в head ниже («…по направлению до …»).
      const byReferral = t.scenario === 'bookDoctor' || t.scenario === 'bookLdp';
      if (!t.onlyDay && !byReferral) {
        const last = t.dateTo || t.deadline || null;
        if (t.dateFrom && last) parts.push(`с ${dayHuman(t.dateFrom)} по ${dayHuman(last)}`);
        else if (t.dateFrom) parts.push(`с ${dayHuman(t.dateFrom)}`);
        else if (last) parts.push(`по ${dayHuman(last)}`);
        else if (!t.current && !t.near) parts.push('в ближайшие дни');
      }

      if (t.timeFrom || t.timeTo) parts.push(`время с ${t.timeFrom || '00:00'} до ${t.timeTo || '23:59'}`);
      if (t.addressContains) parts.push(`адрес: ${t.addressContains}`);
      if (t.prefer) {
        let preferText = `сначала предпочитаю до ${dayHuman(t.prefer.until)}`;
        if (t.prefer.timeTo) preferText += `, до ${t.prefer.timeTo}`;
        parts.push(preferText);
      }
      if (t.purpose) parts.push(`цель визита: ${purposeTitle(t.purpose)}`);
      if (t.respectTravel) parts.push('с запасом на дорогу');
      parts.push(t.mode === 'confirm' ? 'спрашиваю перед записью' : 'записываю сразу');

      // bookDoctor и bookLdp — запись по направлению без текущей записи, для неё
      // отдельная формулировка «Запишу к <специальность> / на <исследование> по
      // направлению до <дата>» вместо общего «<title>: …» — дата уже учтена в head.
      if (byReferral) {
        const last = t.dateTo || t.deadline || null;
        const head = `Запишу ${t.scenario === 'bookLdp' ? 'на' : 'к'} ${t.title} по направлению` + (last ? ` до ${dayHuman(last)}` : '');
        return parts.length ? `${head}, ${parts.join(', ')}` : head;
      }

      return `${t.title}: ${parts.join(', ')}`;
    }

    function describeDryRunItem(item) {
      const head = item.waiting
        ? `${item.title}: подходящих слотов сейчас нет, жду`
        : `${item.title}: взяла бы ${human(item.would.startTime)} — ${item.would.address}` +
          (item.would.doctorName ? ` — врач: ${item.would.doctorName}` : '');
      const warn = (item.warnings || []).map((w) => `\n  ⚠ ${w}`).join('');
      const notes = (item.notes || []).map((n) => `\n  · ${n}`).join('');
      return head + warn + notes;
    }

    const saveConfig = (storage, cfg) => storage.setItem(KEY, JSON.stringify(cfg));
    const loadConfig = (storage) => { try { return JSON.parse(storage.getItem(KEY)) || null; } catch (e) { return null; } };

    // C1: чистая функция слияния события 'booked' в сохранённые настройки —
    // без неё после успешного переноса keepImproving current/source/scenario
    // менялись только в памяти раннера (core/runner.js), а cfg.targets в
    // localStorage оставался со СТАРЫМИ значениями. На перезагрузке страницы,
    // при захвате лидерства standby-вкладкой или по кнопке «Продолжить в этой
    // вкладке» (startFromSavedConfig) ядро стартовало заново именно по
    // cfg.targets — и filters.pickSlots могло принять слот ХУЖЕ уже сделанного
    // переноса, но раньше устаревшего t.current, отправив запись НАЗАД.
    // confirmedFor намеренно не трогаем — это отпечаток целей ДО мутации (см.
    // gateFingerprint в core/runner.js), он и должен остаться прежним, иначе
    // обвязка ложно решила бы, что нужен новый холостой прогон.
    // Возвращает тот же объект cfg (по ссылке), если сохранять нечего —
    // вызывающий код (onBooked) по этому признаку решает, нужен ли saveConfig.
    function applyBookedUpdate(cfg, payload) {
      if (!cfg || !Array.isArray(cfg.targets) || !payload || payload.targetId == null) return cfg;
      let changed = false;
      const targets = cfg.targets.map((t) => {
        if (t.id !== payload.targetId) return t;
        changed = true;
        return { ...t, current: payload.current, source: payload.source, scenario: payload.scenario };
      });
      return changed ? { ...cfg, targets } : cfg;
    }

    return {
      buildTarget, describeTarget, describeDryRunItem, saveConfig, loadConfig, applyBookedUpdate, human, stripCampus, KEY,
      INQUIRY_PURPOSES,
    };
  }

  const api = { createUiState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PolarmedCore = root.PolarmedCore || {}; Object.assign(root.PolarmedCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- userscript/ui-dom.js ---- */
// userscript/ui-dom.js — видимый интерфейс: значок, мастер настройки из 4
// экранов и возобновление поиска после перезагрузки страницы. Единственный
// самозапускающийся модуль — все остальные части ядра только складывают
// себя в globalThis.PolarmedCore, а этот файл их использует и рисует DOM.
//
// Простых людей без технической подготовки в тексте интерфейса не должно
// пугать ни одно слово — весь пользовательский текст на обычном русском.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // На всякий случай не даём смонтироваться дважды (например, если скрипт
  // случайно оказался подключён более одного раза).
  if (window.__polarmedSlotHunterMounted) return;
  window.__polarmedSlotHunterMounted = true;

  const { create, createUiState } = globalThis.PolarmedCore;
  const ui = createUiState();
  const storage = window.localStorage;

  /* ==================== состояние мастера (переменная модуля) ==================== */
  // Ничего отсюда не пишется в хранилище раньше шага 3 — см. requirements.
  const wizard = {
    open: false,
    step: 0,
    options: [],        // результат discover()
    selected: [],        // выбранные варианты (option) с шага 1
    forms: {},           // option.id -> форма условий с шага 2
    report: null,         // результат dryRun() для текущих целей
    builtTargets: null,    // цели, переданные в core.setTargets перед прогоном
    checked: false,         // галочка «Я проверил(а)» на шаге 3
    loading: false,          // идёт discover()/dryRun()
    loadError: null,          // текст ошибки связи + что повторять
  };

  let core = null;
  let badgeState = { kind: 'init', text: '…', detail: '' };
  let panelMode = null; // 'wizard' | 'status' | 'recovery' | 'standby' | null
  const logEvents = [];
  const pendingConfirms = {}; // targetId -> { payload, expiresAt, tickId }
  // Узлы карточек «записать не удалось» (Task 12c minor): answerConfirm их
  // выводит УЖЕ после того, как отвязал карточку от pendingConfirms, и сама
  // держит на экране ещё RESULT_NOTE_MS — clearAllConfirmCards() их не
  // видит, если не следить за ними отдельно (см. ниже).
  const failedConfirmNodes = [];
  let statusRefreshId = null;
  let recoveryWatchId = null;
  let standbyRetryId = null;
  let finishedAll = false; // все цели завершились сами — поиск остановлен
  let preBookedBadge = null; // значок до последнего «Записано», чтобы вернуть текст, а не только цвет
  // C-1: отпечаток подтверждённых целей, по которым работает ЭТА вкладка.
  // Работающая вкладка сверяет его с настройками (startStatusRefresh) —
  // если другая вкладка перенастроила или остановила поиск, эта уступает.
  let runningFor = null;
  // I-1: номер попытки запуска по сохранённым настройкам. «Остановить»,
  // открытие мастера и новая попытка увеличивают его — старая попытка,
  // дождавшись холостого прогона, видит, что устарела, и не стартует.
  let startAttempt = 0;
  // I-3: временное пояснение к зелёному значку (например, «записать не
  // удалось»), чтобы обновление раз в 5 секунд не стирало его сразу.
  let badgeNote = null; // { text, until }
  const foundCount = {}; // targetId -> сколько событий found пришло (чтобы не дублировать лог)

  const dom = {}; // ссылки на элементы внутри shadowRoot

  /* ==================== маленький помощник для сборки DOM ==================== */
  // Строим элементы без innerHTML — так текст из ответов Polarmed (адреса,
  // названия) никогда не интерпретируется как разметка.
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function hhmm(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ==================== таймер ядра: Web Worker из Blob ==================== */
  // Ровно два метода — schedule(ms, fn) и cancel() — как требует core/index.js.
  // Если Worker создать не удалось (например, страница это запрещает через
  // Content-Security-Policy), тихо переключаемся на обычный setTimeout.
  function createWorkerTimer() {
    let worker = null;
    let cb = null;
    let lastMs = 0;
    let scheduledAt = 0;
    let fallbackId = null;
    let usingFallback = false;

    function fallbackSchedule(ms, fn) {
      cb = fn;
      fallbackId = setTimeout(fn, ms);
    }

    // I9: Worker может упасть уже после успешного создания (CSP, старый
    // Safari) — тогда проверки молча останавливались бы навсегда при
    // зелёном значке. Переключаемся на setTimeout и перепланируем именно
    // тот вызов, который уже был отложен в воркере, на оставшееся время.
    function switchToFallback() {
      if (usingFallback) return;
      usingFallback = true;
      try { if (worker) worker.terminate(); } catch (e) { /* воркер уже недоступен */ }
      worker = null;
      if (cb) {
        const remaining = Math.max(0, lastMs - (Date.now() - scheduledAt));
        fallbackSchedule(remaining, cb);
      }
    }

    try {
      const code = "let t=null; onmessage=function(e){ clearTimeout(t); var ms=e.data&&e.data.ms; if(typeof ms==='number'&&ms>=0){ t=setTimeout(function(){ postMessage(1); }, ms);} };";
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      // Minor: не оставляем blob-URL висеть — Worker уже получил код к этому
      // моменту, дальше URL не нужен.
      URL.revokeObjectURL(url);
      worker.onmessage = () => { if (cb) cb(); };
      worker.onerror = () => switchToFallback();
      return {
        schedule(ms, fn) {
          if (usingFallback) { fallbackSchedule(ms, fn); return; }
          cb = fn; lastMs = ms; scheduledAt = Date.now();
          worker.postMessage({ ms });
        },
        cancel() {
          cb = null;
          if (usingFallback) { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; return; }
          if (worker) worker.postMessage({ ms: -1 });
        },
      };
    } catch (e) {
      return {
        schedule(ms, fn) { fallbackSchedule(ms, fn); },
        cancel() { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; cb = null; },
      };
    }
  }

  /* ==================== звук и уведомление ==================== */
  function playBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (e) { /* звук необязателен, тихо игнорируем */ }
  }

  // I8: раньше звук и уведомление были только у booked — у needConfirm их не
  // было, хотя на ответ всего 60 секунд, а вкладка обычно фоновая. Общая
  // функция используется для обоих случаев.
  // Minor: Notification.requestPermission() в старых Safari может не
  // вернуть промис вовсе — проверяем это и оборачиваем в try/catch с .catch,
  // чтобы такой браузер не ронял обработчик целиком.
  function notify(title, body) {
    playBeep();
    if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return;
    const show = () => {
      try { new Notification(title, { body }); } catch (e) { /* уведомление необязательно */ }
    };
    try {
      if (Notification.permission === 'granted') { show(); return; }
      if (Notification.permission === 'denied') return;
      // Старый callback-стиль и новый promise-стиль могут сработать оба —
      // handled не даёт показать уведомление дважды.
      let handled = false;
      const onResult = (perm) => { if (handled) return; handled = true; if (perm === 'granted') show(); };
      const p = Notification.requestPermission(onResult);
      if (p && typeof p.then === 'function') p.then(onResult).catch(() => { /* уведомление необязательно */ });
    } catch (e) { /* уведомление необязательно */ }
  }

  /* ==================== стили значка и мастера (только внутри shadowRoot) ==================== */
  function styles() {
    return `
      :host, * { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .esh-root { position: fixed; right: 16px; bottom: 16px; z-index: 999999; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .esh-badge { cursor: pointer; border: none; border-radius: 20px; padding: 10px 16px; font-size: 14px; color: #fff; background: #5b6472; box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; }
      .esh-badge.k-idle, .esh-badge.k-init { background: #5b6472; }
      .esh-badge.k-running, .esh-badge.k-resuming { background: #2e9e5b; }
      .esh-badge.k-booked { background: #e08a2b; }
      .esh-badge.k-standby { background: #3a7bd5; }
      .esh-badge.k-paused { background: #8a6d3b; }
      .esh-badge.k-needLogin, .esh-badge.k-needIdentity, .esh-badge.k-sessionLost, .esh-badge.k-stale, .esh-badge.k-resumeError, .esh-badge.k-needDryRun { background: #d64545; }
      .esh-sub { display: block; font-size: 11px; opacity: .85; font-weight: normal; }
      .esh-card { width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box; max-height: 70vh; overflow: auto; background: #fff; color: #222; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.3); padding: 14px; }
      .esh-card h3 { margin: 0 0 8px; font-size: 16px; }
      .esh-card p { margin: 4px 0; font-size: 13px; line-height: 1.4; }
      .esh-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
      .esh-opt { border: 1px solid #e0e0e0; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
      .esh-opt.disabled { opacity: .55; }
      .esh-opt .title { font-weight: 600; font-size: 13px; }
      .esh-opt .meta { font-size: 12px; color: #666; }
      .esh-opt .reason { font-size: 12px; color: #a33; }
      .esh-field { display: block; font-size: 12px; margin: 6px 0 2px; color: #444; }
      .esh-card input[type=text], .esh-card input[type=date], .esh-card input[type=time] { width: 100%; padding: 4px 6px; margin-top: 4px; font-size: 13px; border: 1px solid #ccc; border-radius: 6px; }
      .esh-btns { display: flex; gap: 8px; margin-top: 12px; }
      .esh-btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; font-size: 13px; }
      .esh-btn.primary { background: #2e7dd7; color: #fff; border-color: #2e7dd7; }
      .esh-btn.primary:disabled { background: #a9c6ea; border-color: #a9c6ea; cursor: not-allowed; }
      .esh-btn.danger { background: #d64545; color: #fff; border-color: #d64545; }
      .esh-warn { color: #a33; font-size: 12px; }
      .esh-note { color: #666; font-size: 12px; }
      .esh-status-target { margin-bottom: 8px; }
      .esh-status-target p { margin: 2px 0; }
      .esh-confirm { width: 300px; max-width: calc(100vw - 32px); box-sizing: border-box; background: #fff8ea; border: 1px solid #e0b84b; border-radius: 10px; padding: 10px; margin-bottom: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
      .esh-slept { width: 300px; background: #eef2ff; border: 1px solid #98a6e0; border-radius: 10px; padding: 10px; display: flex; justify-content: space-between; gap: 8px; }
      /* .esh-slept задаёт свой display: flex — этим он перебивает display:
         none из стандартного правила [hidden] (авторское правило с любым
         указанным display выигрывает у правила User Agent), и пустая рамка
         остаётся видна поверх значка, пока карточку не заполнили текстом.
         Возвращаем скрытие явно. */
      .esh-slept[hidden] { display: none; }
      .esh-log { font-size: 12px; max-height: 160px; overflow: auto; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 6px; }
      .esh-log div { margin-bottom: 4px; }
      details.esh-more summary { cursor: pointer; font-size: 12px; color: #2e7dd7; margin-top: 6px; }
    `;
  }

  /* ==================== создание корневого элемента (один раз) ==================== */
  function mountBadge() {
    const host = document.createElement('div');
    host.id = 'polarmed-slot-hunter-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: styles() }));

    const root = h('div', { class: 'esh-root' });
    const badge = h('button', { class: 'esh-badge k-init', onclick: onBadgeClick, text: 'Polarmed: охотник за слотами' });
    const confirms = h('div', { class: 'esh-confirms' });
    const slept = h('div', { class: 'esh-slept', hidden: true });
    const panel = h('div', { class: 'esh-card', hidden: true });

    root.appendChild(confirms);
    root.appendChild(slept);
    root.appendChild(panel);
    root.appendChild(badge);
    shadow.appendChild(root);
    document.body.appendChild(host);

    Object.assign(dom, { shadow, root, badge, confirms, slept, panel });
  }

  /* ==================== значок ==================== */
  function setBadge(next) {
    badgeState = { ...badgeState, ...next };
    renderBadge(badgeState);
  }

  function renderBadge(status) {
    const b = dom.badge;
    b.className = 'esh-badge k-' + status.kind;
    clear(b);
    const launcherText = globalThis.PolarmedPlatform && status.kind === 'idle' && status.text === '🎯 Настроить'
      ? '🎯 Охотник: открыть настройки' : status.text;
    b.appendChild(document.createTextNode(launcherText));
    if (globalThis.PolarmedPlatform) {
      b.setAttribute('title', 'Нажмите, чтобы открыть настройки или состояние охотника');
      b.setAttribute('aria-label', 'Открыть охотника за талонами');
    }
    if (status.detail) b.appendChild(h('span', { class: 'esh-sub', text: status.detail }));
  }

  function onBadgeClick() {
    if (panelMode) { hidePanel(); return; }
    const kind = badgeState.kind;
    // C2 п.2: sessionLost/stale — мастер не открываем, только объяснение и
    // кнопка «Остановить поиск» (сама работа тем временем продолжается сама
    // по себе и восстановится молча через startRecoveryWatch()).
    if (kind === 'sessionLost' || kind === 'stale') { openRecoveryPanel(); return; }
    if (kind === 'needLogin' || kind === 'needIdentity') { retryLogin(); return; }
    if (kind === 'resumeError') { resumeIfEnabled(); return; }
    if (kind === 'standby') { openStandbyPanel(); return; }
    if (kind === 'booked') { acknowledgeBooked(); openStatusPanel(); return; }
    if (kind === 'needsReview') { openStatusPanel(); return; }
    if (kind === 'running' || kind === 'resuming') { openStatusPanel(); return; }
    // needDryRun и любой прочий случай — безопаснее всего начать настройку заново.
    openWizardGuarded(1);
  }

  // C2 п.2: открытие мастера, когда ядро всё ещё работает по старым целям
  // (например, кликнули «Настроить» мимо статус-панели), сначала
  // останавливает цикл — иначе setTargets() на шаге 3 обнулит подтверждение
  // прямо во время работающего поиска.
  //
  // C-1 п.2: заодно помечаем паузу в настройках — вкладки в standby не
  // должны подхватывать поиск по старым целям, пока здесь меняют условия, а
  // работающая вкладка (если поиск шёл не здесь) по этой метке уступает.
  // Пауза снимается в onStart после нового подтверждения.
  function openWizardGuarded(step) {
    startAttempt++; // незаконченная попытка возобновления больше не стартует (I-1)
    stopRecoveryWatch(); // M-2
    if (core.status().running) {
      core.stop();
      runningFor = null;
      stopStatusRefresh();
      clearAllConfirmCards();
      setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нужен новый холостой прогон' });
    }
    // Настройка идёт в этой вкладке — повтор standby не должен подменять
    // цели мастера в ядре и стартовать сам.
    if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
    if (badgeState.kind === 'standby') setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'идёт настройка' });
    const cfg = ui.loadConfig(storage);
    if (cfg && cfg.enabled && !cfg.paused) ui.saveConfig(storage, { ...cfg, paused: true, pausedAt: Date.now() });
    openWizard(step);
  }

  function showPanel() { dom.panel.hidden = false; }
  function hidePanel() { dom.panel.hidden = true; panelMode = null; wizard.open = false; }

  function openPreparationPanel(message) {
    panelMode = 'preparation';
    showPanel();
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Охотник за талонами: настройка' }));
    dom.panel.appendChild(h('p', { text: 'На самом сайте выберите поликлинику, пациента и специальность. Дождитесь списка врачей. Конкретного врача выбирать не нужно.' }));
    if (message) dom.panel.appendChild(h('p', { class: 'esh-warn', text: message }));
    dom.panel.appendChild(h('a', { class: 'esh-btn', href: '/signup/free/', text: 'Открыть свободную запись на сайте' }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Проверить выбор и открыть настройки', onclick: retryLogin }),
      h('button', { class: 'esh-btn', text: 'Закрыть', onclick: hidePanel }),
    ]));
  }

  /* ==================== панель объяснения при sessionLost/stale ==================== */
  function openRecoveryPanel() { panelMode = 'recovery'; showPanel(); renderRecoveryPanel(); }

  function renderRecoveryPanel() {
    clear(dom.panel);
    const isStale = badgeState.kind === 'stale';
    dom.panel.appendChild(h('h3', { text: isStale ? 'Давно нет ответа от Polarmed' : 'Нужно войти в Polarmed' }));
    dom.panel.appendChild(h('p', { text: globalThis.PolarmedPlatform
      ? 'Остановите поиск. Войдите на Polarmed и снова выберите пациента и специальность в этой вкладке, затем повторите настройку. Внутреннюю сессию сайта скрипт сам не продлевает.'
      : 'Войдите в Polarmed в соседней вкладке — поиск продолжится сам, ничего перезапускать не нужно.' }));
    if (badgeState.detail) dom.panel.appendChild(h('p', { class: 'esh-note', text: badgeState.detail }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn danger', text: 'Остановить поиск', onclick: onStop }),
    ]));
  }

  /* ==================== панель standby (эта вкладка уступила другой) ==================== */
  function openStandbyPanel() { panelMode = 'standby'; showPanel(); renderStandbyPanel(); }

  function renderStandbyPanel(note) {
    clear(dom.panel);
    const cfg = ui.loadConfig(storage);
    const paused = !!(cfg && cfg.paused);
    dom.panel.appendChild(h('h3', { text: paused ? 'Условия поиска меняют в другой вкладке' : 'Поиск идёт в другой вкладке' }));
    // C3: в этой вкладке остановить поиск нельзя — он не здесь работает, и
    // «Остановить поиск» тут не должно ни к чему предлагать, ни менять
    // enabled в настройках.
    dom.panel.appendChild(h('p', {
      text: paused
        ? 'Когда там нажмут «Запустить охоту», поиск продолжится по новым условиям. Можно и настроить поиск здесь заново.'
        : 'Чтобы остановить поиск, сделайте это в той вкладке Polarmed, где он сейчас работает.',
    }));
    if (note) dom.panel.appendChild(h('p', { class: 'esh-warn', text: note }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      paused
        ? h('button', { class: 'esh-btn primary', text: 'Настроить здесь', onclick: () => openWizardGuarded(1) })
        : h('button', { class: 'esh-btn primary', text: 'Продолжить в этой вкладке', onclick: onContinueHere }),
    ]));
  }

  // I11: по клику пробуем перехватить лидерство прямо сейчас — ядро само
  // решит спор вкладок (у чьего claim id больше).
  // C-1 п.1: стартуем только по свежим настройкам и только после нового
  // холостого прогона, совпавшего с подтверждённым (тот же путь, что и
  // resumeIfEnabled) — цели из памяти вкладки могли устареть.
  async function onContinueHere() {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Поиск идёт в другой вкладке' }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Проверяю условия поиска, подождите…' }));
    let r;
    try {
      r = await startFromSavedConfig();
    } catch (e) {
      if (panelMode === 'standby') renderStandbyPanel('Не удалось проверить: ' + ((e && e.message) || 'нет ответа от Polarmed'));
      return;
    }
    if (r.status === 'started') {
      if (!showBookedBadge()) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      startStatusRefresh();
      if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
      hidePanel();
    } else if (r.status === 'mismatch') {
      showReconfirm(r.cfg, r.report);
    } else if (r.status === 'off') {
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      hidePanel();
    } else if (panelMode === 'standby') {
      renderStandbyPanel();
    }
  }

  /* ==================== лог событий (для статус-панели) ==================== */
  function pushLog(entry) {
    logEvents.unshift(entry);
    if (logEvents.length > 40) logEvents.length = 40;
    if (panelMode === 'status') renderStatusPanel();
  }

  function renderLog(events) {
    const box = h('div', { class: 'esh-log' });
    for (const e of events.slice(0, 20)) box.appendChild(h('div', { text: `${hhmm(e.at)} · ${e.msg}` }));
    if (!events.length) box.appendChild(h('div', { class: 'esh-note', text: 'событий пока нет' }));
    return box;
  }

  function titleFor(targetId) {
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    return (t && t.title) || 'Запись';
  }

  /* ==================== статус-панель (что происходит сейчас) ==================== */
  function renderStatusPanel() {
    const st = core.status();
    const waiting = new Set(st.pending);
    // Под каждой целью — условия поиска теми же словами, что на шаге 3 мастера.
    // Берём сохранённые цели: в них current уже обновлён после переноса.
    const cfg = ui.loadConfig(storage);
    const saved = new Map(((cfg && cfg.targets) || []).map((x) => [x.id, x]));
    const lines = st.targets.map((t) => {
      const conditions = saved.has(t.id) ? describeConditions(saved.get(t.id)) : '';
      return h('div', { class: 'esh-status-target' }, [
        h('p', { text: `${t.title}: ${waiting.has(t.id) ? 'жду вашего решения' : describeState(t)}` }),
        conditions ? h('p', { class: 'esh-note', text: 'Условия: ' + conditions }) : null,
      ]);
    });
    // Панель перерисовывается целиком каждые 5 секунд (см. startStatusRefresh)
    // и на каждое новое событие лога — без этого позиция прокрутки в логе
    // сбрасывалась бы к началу при каждой перерисовке.
    const prevLog = dom.panel.querySelector('.esh-log');
    const logScrollTop = prevLog ? prevLog.scrollTop : 0;
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Что сейчас происходит' }));
    // M-1: время берём из lastCheckAt — его ставит только настоящая проверка.
    dom.panel.appendChild(h('p', { class: 'esh-note', text: `Последняя проверка: ${st.lastCheckAt ? hhmm(st.lastCheckAt) : 'ещё не было'}` }));
    dom.panel.appendChild(h('div', {}, lines));
    if (cfg && cfg.reviewMessage) dom.panel.appendChild(h('p', { class: 'esh-warn', text: cfg.reviewMessage }));
    const logBox = renderLog(logEvents);
    dom.panel.appendChild(logBox);
    logBox.scrollTop = logScrollTop;
    const stopBtn = h('button', { class: 'esh-btn danger', text: 'Остановить поиск', onclick: onStop });
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [stopBtn,
      !st.running ? h('button', { class: 'esh-btn', text: 'Настроить заново', onclick: () => openWizardGuarded(1) }) : null]));
  }

  function describeState(t) {
    if (t.state === 'stopped') return `остановлено (${t.note || 'причина неизвестна'})`;
    if (t.state === 'done') return 'готово';
    if (t.state === 'improving') return 'записано, ищу вариант получше';
    return 'проверяю расписание';
  }

  // describeTarget начинает с «<название>: …» — название уже есть строкой выше.
  function describeConditions(target) {
    const text = ui.describeTarget(target);
    const prefix = target.title + ': ';
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
  }

  function openStatusPanel() { panelMode = 'status'; showPanel(); renderStatusPanel(); }

  /* ==================== мастер: открытие и переключение шагов ==================== */
  function openWizard(step) {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = step;
    showPanel();
    if (step === 1) loadStep1();
    else if (step === 2) renderStep2(wizard.selected);
    else if (step === 3) loadStep3();
    else if (step === 4) renderStep4();
  }

  function renderLoading(title) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Спрашиваю Polarmed, подождите…' }));
  }

  function renderLoadError(title, message, onRetry) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-warn', text: message }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Повторить', onclick: onRetry }),
    ]));
  }

  /* ==================== шаг 1: выбор направлений и записей ==================== */
  async function loadStep1() {
    renderLoading('Шаг 1 из 3. За чем следить');
    try {
      const options = await core.discover();
      wizard.options = options;
      renderStep1(options);
    } catch (e) {
      renderLoadError('Шаг 1 из 3. За чем следить', e && e.message, loadStep1);
    }
  }

  function isSelected(option) { return wizard.selected.some((o) => o.id === option.id); }

  function toggleOption(option, on) {
    wizard.selected = wizard.selected.filter((o) => o.id !== option.id);
    if (on) wizard.selected.push(option);
    // Кнопка «Далее» рисуется один раз вместе со списком — без этого она
    // оставалась неактивной, пока мастер не перерисуют заново.
    if (dom.step1Next) dom.step1Next.disabled = wizard.selected.length === 0;
  }

  function renderOptionRow(option) {
    const supported = option.supported !== false;
    const box = h('div', { class: 'esh-opt' + (supported ? '' : ' disabled') });
    const checkbox = h('input', {
      type: 'checkbox', checked: isSelected(option), disabled: !supported,
      onchange: (e) => toggleOption(option, e.target.checked),
    });
    box.appendChild(h('label', { class: 'esh-row' }, [
      checkbox,
      h('div', {}, [
        h('div', { class: 'title', text: option.title }),
        h('div', { class: 'meta', text: describeOptionMeta(option) }),
        !supported ? h('div', { class: 'reason', text: option.unsupportedReason || 'пока не поддерживается' }) : null,
      ]),
    ]));
    return box;
  }

  function describeOptionMeta(option) {
    const parts = [];
    if (option.current) parts.push('сейчас записано на ' + ui.human(option.current));
    if (option.address) parts.push(ui.stripCampus(option.address));
    if (option.deadline) parts.push('направление действует по ' + option.deadline.slice(8, 10) + '.' + option.deadline.slice(5, 7));
    return parts.join(' · ') || (option.scenario === 'polarmedBook' ? 'новый талон к выбранному врачу' : 'запись по направлению');
  }

  function renderStep1(options) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 1 из 3. За чем следить' }));
    if (globalThis.PolarmedPlatform) {
      dom.panel.appendChild(h('p', { class: 'esh-warn', text: 'Выберите «Любой врач» для поиска по всей специальности либо конкретного врача, если он выбран на сайте. Беру первый найденный подходящий талон. Старые записи не отменяю. После попытки записи останавливаюсь до проверки результата.' }));
      dom.panel.appendChild(h('button', { class: 'esh-btn', text: 'Я проверил результат предыдущей попытки', onclick: async () => {
        if (!window.confirm('Проверьте личный кабинет: предыдущая попытка могла создать запись. Снять блокировку и разрешить новую попытку? Это не отменит ни одной записи.')) return;
        try { await core.reviewAttempt(); await loadStep1(); }
        catch (e) { renderLoadError('Проверка результата', e.message, loadStep1); }
      } }));
    }
    if (!options.length) {
      dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Направлений и записей, с которыми можно работать, не найдено.' }));
    }
    const list = h('div', {}, options.map(renderOptionRow));
    dom.panel.appendChild(list);
    const next = h('button', {
      class: 'esh-btn primary', text: 'Далее', disabled: wizard.selected.length === 0,
      onclick: () => openWizard(2),
    });
    dom.step1Next = next;
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [next]));
  }

  /* ==================== шаг 2: условия для каждого выбранного пункта ==================== */
  function ensureForm(option) {
    if (!wizard.forms[option.id]) {
      wizard.forms[option.id] = {
        // Для новой записи 'earlier' показывается как «как можно раньше».
        when: 'earlier',
        day: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '',
        existingStart: '',
        where: option.address ? 'sameCampus' : 'any', addressContains: '',
        respectTravel: option.scenario !== 'polarmedBook', mode: 'auto', purpose: 'unwell',
      };
    }
    return wizard.forms[option.id];
  }

  // Направление к врачу с needPurpose: true — сайт требует выбрать цель визита
  // (см. capture-2026-09-24-referral-doctor.md), иначе расписание и запись
  // отклоняются. Для остальных целей поле form.purpose ни на что не влияет.
  function purposeField(option, form, update) {
    if (!(option.source && option.source.needPurpose)) return null;
    const opts = [
      ['unwell', ui.INQUIRY_PURPOSES.unwell.title],
      ['documents', ui.INQUIRY_PURPOSES.documents.title],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'purpose-' + option.id, checked: (form.purpose || 'unwell') === val, onchange: () => update({ purpose: val }) }),
      h('span', { text }),
    ])));
    return h('div', {}, [h('label', { class: 'esh-field', text: 'Цель визита' }), group]);
  }

  function whenField(option, form, update, quiet) {
    const opts = [
      ['earlier', option.current ? 'раньше, чем сейчас записано' : 'как можно раньше'],
      ...(option.current ? [['sameDayEarlier', 'в тот же день, но раньше']] : []),
      ['onlyDay', 'в выбранный день, в любое время'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'when-' + option.id, checked: form.when === val, onchange: () => update({ when: val }) }),
      h('span', { text }),
    ])));
    const dayInput = form.when === 'onlyDay' ? h('input', {
      type: 'date', value: form.day, onchange: (e) => quiet({ day: e.target.value }),
    }) : null;
    return h('div', {}, [group, dayInput]);
  }

  function whereField(option, form, update, quiet) {
    const opts = [
      ...(option.address ? [['sameCampus', 'в этом же здании']] : []),
      ['any', option.scenario === 'polarmedBook' ? 'в выбранной поликлинике' : 'где угодно'],
      ['contains', 'адрес содержит:'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'where-' + option.id, checked: form.where === val, onchange: () => update({ where: val }) }),
      h('span', { text }),
    ])));
    const addrInput = form.where === 'contains' ? h('input', {
      type: 'text', value: form.addressContains, placeholder: 'например, Ленина',
      oninput: (e) => quiet({ addressContains: e.target.value }),
    }) : null;
    return h('div', {}, [group, addrInput]);
  }

  function advancedFields(form, quiet) {
    const field = (label, type, key) => h('label', { class: 'esh-field' }, [
      label, h('input', { type, value: form[key], onchange: (e) => quiet({ [key]: e.target.value }) }),
    ]);
    // Раскрыт ли блок, помним в форме: шаг перерисовывается при выборе любого
    // переключателя, и без этого блок каждый раз схлопывался заново.
    return h('details', { class: 'esh-more', open: !!form.moreOpen, ontoggle: (e) => { form.moreOpen = e.target.open; } }, [
      h('summary', { text: 'Дополнительно: даты и время' }),
      field('Не раньше какого дня', 'date', 'dateFrom'),
      field('Не позже какого дня', 'date', 'dateTo'),
      field('Время не раньше', 'time', 'timeFrom'),
      field('Время не позже', 'time', 'timeTo'),
    ]);
  }

  function renderTargetCard(option) {
    const form = ensureForm(option);
    const update = (patch) => { Object.assign(form, patch); renderStep2(wizard.selected); };
    // Поля ввода (даты, время, адрес) меняют форму без перерисовки шага.
    // Браузер шлёт change у поля даты уже на первой цифре года («0002»), и
    // перерисовка подставляла этот год в новое поле и уводила курсор, так что
    // год с клавиатуры было не набрать. Обновляем только ошибку и «Далее».
    const quiet = (patch) => { Object.assign(form, patch); refreshStepTwoState(); };
    const card = h('div', { class: 'esh-opt' });
    card.appendChild(h('div', { class: 'title', text: option.title }));
    if (option.scenario === 'polarmedBook') {
      card.appendChild(h('label', { class: 'esh-field' }, [
        'Если уже есть запись: её дата и время (необязательно, по Мурманску)',
        h('input', { type: 'datetime-local', value: form.existingStart,
          onchange: (e) => quiet({ existingStart: e.target.value }) }),
      ]));
      card.appendChild(h('p', { class: 'esh-note', text: 'В обычном режиме ищу раньше указанного времени. Это только фильтр: существующий талон не изменится и не отменится.' }));
    }
    card.appendChild(h('label', { class: 'esh-field', text: 'Когда' }));
    card.appendChild(whenField(option, form, update, quiet));
    card.appendChild(h('label', { class: 'esh-field', text: 'Где' }));
    card.appendChild(whereField(option, form, update, quiet));
    const purpose = purposeField(option, form, update);
    if (purpose) card.appendChild(purpose);
    if (option.scenario === 'polarmedBook') {
      card.appendChild(h('p', { class: 'esh-warn', text: 'Другие записи и время на дорогу автоматически не учитываются. Проверьте пересечения сами. ' +
        (option.source.anyDoctor ? 'Проверяю врачей выбранной специальности в этой поликлинике по порядку; беру первый подходящий талон.' : 'Поиск ограничен выбранным врачом и поликлиникой.') }));
    } else card.appendChild(h('label', { class: 'esh-row' }, [
      h('input', { type: 'checkbox', checked: form.respectTravel, onchange: (e) => update({ respectTravel: e.target.checked }) }),
      h('span', { text: 'Учитывать время на дорогу между записями' }),
    ]));
    card.appendChild(h('label', { class: 'esh-field', text: 'Как записывать' }));
    card.appendChild(h('div', {}, [
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'auto', onchange: () => update({ mode: 'auto' }) }),
        h('span', { text: 'сразу, без вопросов' }),
      ]),
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'confirm', onchange: () => update({ mode: 'confirm' }) }),
        h('span', { text: 'сначала спрашивать' }),
      ]),
    ]));
    card.appendChild(advancedFields(form, quiet));
    const error = stepTwoError(option, form);
    const errorEl = h('p', { class: 'esh-warn', text: error || '', hidden: !error });
    errorEl.dataset.optionId = option.id;
    card.appendChild(errorEl);
    return card;
  }

  function stepTwoError(option, form) {
    if (option.scenario === 'polarmedBook' && form.existingStart &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.existingStart) || !Number.isFinite(Date.parse(form.existingStart + ':00+03:00')))) {
      return 'укажите корректную дату и время существующей записи';
    }
    if (form.when === 'onlyDay' && !form.day) return 'выберите день';
    if (form.where === 'contains' && !form.addressContains.trim()) return 'укажите часть адреса';
    return null;
  }

  // «Назад» на шаге 1: варианты уже получены discover()-ом при первом входе
  // на шаг 1 в этом сеансе мастера — рисуем из wizard.options, не ходим в
  // сеть повторно.
  function backToStep1() {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = 1;
    showPanel();
    renderStep1(wizard.options);
  }

  function renderStep2(selected) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 2 из 3. Условия поиска' }));
    dom.panel.appendChild(h('div', {}, selected.map(renderTargetCard)));
    const hasErrors = selected.some((o) => stepTwoError(o, ensureForm(o)));
    const back = h('button', { class: 'esh-btn', text: 'Назад', onclick: backToStep1 });
    const next = h('button', { class: 'esh-btn primary', text: 'Далее', disabled: hasErrors, onclick: () => openWizard(3) });
    next.dataset.role = 'step2-next';
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [back, next]));
  }

  // Обновляет ошибки карточек и кнопку «Далее» на шаге 2 без перерисовки.
  function refreshStepTwoState() {
    let hasErrors = false;
    for (const o of wizard.selected) {
      const error = stepTwoError(o, ensureForm(o));
      if (error) hasErrors = true;
      const el = [...dom.panel.querySelectorAll('p.esh-warn')].find((p) => p.dataset.optionId === String(o.id));
      if (el) { el.textContent = error || ''; el.hidden = !error; }
    }
    const next = dom.panel.querySelector('[data-role="step2-next"]');
    if (next) next.disabled = hasErrors;
  }

  /* ==================== шаг 3: холостой прогон и запуск ==================== */
  async function loadStep3() {
    renderLoading('Шаг 3 из 3. Проверка перед запуском');
    wizard.builtTargets = wizard.selected.map((o) => ui.buildTarget(o, ensureForm(o)));
    core.setTargets(wizard.builtTargets);
    try {
      wizard.report = await core.dryRun();
      wizard.checked = false;
      renderStep3(wizard.report);
    } catch (e) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, loadStep3);
    }
  }

  function renderReportItem(item) {
    const text = ui.describeDryRunItem(item);
    const [head, ...rest] = text.split('\n');
    const box = h('div', { class: 'esh-opt' });
    box.appendChild(h('p', { text: head }));
    for (const line of rest) {
      const warn = line.trim().startsWith('⚠');
      box.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text: line.trim() }));
    }
    return box;
  }

  function renderStep3(report) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 3 из 3. Проверка перед запуском' }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Это холостой прогон: скрипт проверил расписание и показывает, что сделал бы прямо сейчас. Ничего не записано и не перенесено.' }));
    dom.panel.appendChild(h('div', {}, report.items.map(renderReportItem)));
    const checkbox = h('input', {
      type: 'checkbox', checked: wizard.checked,
      onchange: (e) => { wizard.checked = e.target.checked; renderStep3(wizard.report); },
    });
    dom.panel.appendChild(h('label', { class: 'esh-row' }, [checkbox, h('span', { text: 'Я проверил(а) результаты холостого прогона' })]));
    const btns = [];
    if (wizard.selected.length) btns.push(h('button', { class: 'esh-btn', text: 'Назад', onclick: () => openWizard(2) }));
    btns.push(h('button', { class: 'esh-btn primary', text: 'Запустить охоту', disabled: !wizard.checked, onclick: onStart }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, btns));
  }

  /* ==================== шаг 4: подтверждение запуска ==================== */
  function renderStep4() {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Готово' }));
    dom.panel.appendChild(h('p', {}, 'Слежу за расписанием. Значок будет зелёным, пока идёт поиск.'));
    const titles = (wizard.builtTargets || []).map((t) => t.title).join(', ');
    if (titles) dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Слежу за: ' + titles }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Понятно', onclick: hidePanel }),
    ]));
  }

  async function onStart() {
    // C1: защита от запуска по пустому списку целей (например, если сюда
    // всё же попали с испорченным состоянием мастера) — без неё в настройки
    // тихо сохранился бы targets: [] при зелёном значке.
    if (!wizard.builtTargets || !wizard.builtTargets.length) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', 'Список целей пуст — нечего запускать. Начните заново с шага 1.', () => openWizardGuarded(1));
      return;
    }
    try {
      core.confirmDryRun(wizard.report.id);
      await core.start();
      // C-1 п.2: новое подтверждение снимает паузу (новый объект настроек
      // без paused/pausedAt).
      ui.saveConfig(storage, { enabled: true, paused: false, targets: wizard.builtTargets, confirmedFor: wizard.report.targetsHash });
      runningFor = wizard.report.targetsHash;
      // Minor: сразу после старта проверок ещё не было — не выдумываем время
      // последней проверки.
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: 'первая проверка скоро' });
      startStatusRefresh();
      openWizard(4);
    } catch (e) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, () => renderStep3(wizard.report));
    }
  }

  function onStop() {
    startAttempt++; // I-1: идущая попытка возобновления после прогона не стартует
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch(); // M-2
    if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
    clearAllConfirmCards(); // I6: живые карточки «спросить» после остановки не нужны
    const cfg = ui.loadConfig(storage) || {};
    ui.saveConfig(storage, { ...cfg, enabled: false });
    setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
    hidePanel();
  }

  /* ==================== запросы на подтверждение слота (mode: confirm) ==================== */
  function renderConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    const card = h('div', { class: 'esh-confirm' });
    // I7: должно быть видно, что именно отдаётся — для переноса называем и
    // текущее время записи, и найденное, а не только найденное.
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    const current = t && t.current;
    const headText = current && !globalThis.PolarmedPlatform
      ? `${p.payload.title}: перенесу с ${ui.human(current)} на ${ui.human(p.payload.slot.startTime)}`
      : `${p.payload.title}: запишу на ${ui.human(p.payload.slot.startTime)}`;
    card.appendChild(h('p', { text: headText }));
    if (p.payload.slot.doctorName) card.appendChild(h('p', { text: 'Врач: ' + p.payload.slot.doctorName }));
    if (globalThis.PolarmedPlatform) card.appendChild(h('p', { class: 'esh-note', text: 'Создам новый талон. Старые записи останутся без изменений.' }));
    if (p.payload.address) card.appendChild(h('p', { class: 'esh-note', text: ui.stripCampus(p.payload.address) }));
    card.appendChild(h('p', { class: 'esh-note', text: `Осталось ${left} с` }));
    card.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn', text: 'Пропустить', onclick: () => answerConfirm(targetId, 'skip') }),
      h('button', { class: 'esh-btn primary', text: 'Записать', onclick: () => answerConfirm(targetId, 'book') }),
    ]));
    if (p.node) dom.confirms.replaceChild(card, p.node);
    else dom.confirms.appendChild(card);
    p.node = card;
  }

  // I6: карточки режима «спросить» надо чистить и при остановке, и при
  // standby — иначе остаётся живой отсчёт и кнопки, которые уже ничего не
  // делают (answer() на остановленном раннере просто отклонится).
  function clearAllConfirmCards() {
    for (const targetId of Object.keys(pendingConfirms)) removeConfirmCard(targetId);
    // Task 12c minor: карточка «записать не удалось» уже не в
    // pendingConfirms (answerConfirm удаляет её оттуда сразу после ответа),
    // но сам узел ещё несколько секунд на экране — без этого списка она
    // пережила бы остановку/standby и провисела бы впустую до RESULT_NOTE_MS.
    for (const entry of failedConfirmNodes.splice(0)) {
      clearTimeout(entry.timeoutId);
      if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    }
  }

  function onNeedConfirm(payload) {
    // I8: окно ответа всего 60 секунд, а вкладка обычно фоновая — без звука
    // и уведомления человек может просто не заметить запрос вовремя.
    const where = payload.address ? ` — ${ui.stripCampus(payload.address)}` : '';
    const doctor = payload.slot.doctorName ? ' — врач: ' + payload.slot.doctorName : '';
    notify('Polarmed: нужно решение', `${payload.title}: ${ui.human(payload.slot.startTime)}${where}${doctor} — 60 секунд на ответ`);
    const targetId = payload.targetId;
    const tickId = setInterval(() => {
      const p = pendingConfirms[targetId];
      if (!p || Date.now() >= p.expiresAt) { removeConfirmCard(targetId); return; }
      renderConfirmCard(targetId);
    }, 1000);
    pendingConfirms[targetId] = { payload, expiresAt: payload.expiresAt, tickId, node: null };
    renderConfirmCard(targetId);
  }

  function removeConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    clearInterval(p.tickId);
    if (p.node && p.node.parentNode) p.node.parentNode.removeChild(p.node);
    delete pendingConfirms[targetId];
  }

  // I5/I-3: результат core.answer() показываем человеку на месте карточки:
  // пока ждём ответа — «Записываю…», при неудаче — понятный итог на
  // несколько секунд и то же в пояснении к значку. Дубля в логе избегаем
  // сравнением foundCount до/после core.answer(), а не перечислением
  // исходов: в большинстве неудач runner.js:finish() сам шлёт found с тем
  // же текстом, и onFound уже его залогировал, — но не всегда (например,
  // при res.action === 'relogin' finish() шлёт sessionLost, а не found, и
  // foundCount не растёт). Счётчик учитывает это сам: alreadyLogged
  // окажется false, и текст залогируется здесь, в answerConfirm, — без
  // догадок о том, какие именно исходы finish() уже успел залогировать.
  const RESULT_NOTE_MS = 7000;

  function showCardNote(node, text, warn) {
    clear(node);
    node.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text }));
  }

  async function answerConfirm(targetId, decision) {
    const title = titleFor(targetId);
    const bookDecision = decision === 'book';
    const p = pendingConfirms[targetId];
    const node = p && p.node;
    // Отвязываем карточку от отсчёта, но сам элемент пока оставляем на месте.
    if (p) { clearInterval(p.tickId); delete pendingConfirms[targetId]; }
    const dropNode = () => { if (node && node.parentNode) node.parentNode.removeChild(node); };
    if (!bookDecision) {
      dropNode();
      try { await core.answer(targetId, 'skip'); } catch (e) { /* пропуск ничего не отправляет */ }
      return;
    }
    if (node) showCardNote(node, `${title}: записываю…`, false);
    const foundBefore = foundCount[targetId] || 0;
    let failText = null;
    let alreadyLogged = false;
    try {
      const res = await core.answer(targetId, 'book');
      if (!res || !res.ok || !res.verified) {
        failText = (res && res.message) || 'слот уже не актуален';
        alreadyLogged = (foundCount[targetId] || 0) > foundBefore;
      }
    } catch (e) {
      failText = (e && e.message) || 'неизвестная ошибка';
    }
    if (!failText) { dropNode(); return; }
    const text = `${title}: записать не удалось — ${failText}`;
    if (!alreadyLogged) pushLog({ at: Date.now(), msg: text });
    if (node) {
      showCardNote(node, text, true);
      const entry = { node, timeoutId: null };
      entry.timeoutId = setTimeout(() => {
        dropNode();
        const i = failedConfirmNodes.indexOf(entry);
        if (i !== -1) failedConfirmNodes.splice(i, 1);
      }, RESULT_NOTE_MS);
      failedConfirmNodes.push(entry);
    }
    showBadgeNote('записать не удалось: ' + failText);
  }

  function showBadgeNote(text) {
    const prevDetail = badgeState.detail;
    badgeNote = { text, until: Date.now() + RESULT_NOTE_MS };
    setBadge({ detail: text });
    setTimeout(() => {
      if (badgeState.detail !== text) return; // значок уже сменился по другой причине
      setBadge({ detail: badgeState.kind === 'running' ? runningDetail() : prevDetail });
    }, RESULT_NOTE_MS);
  }

  /* ==================== плашка «компьютер спал» ==================== */
  function onSlept(payload) {
    clear(dom.slept);
    dom.slept.hidden = false;
    dom.slept.appendChild(h('p', { text: `Компьютер спал с ${hhmm(payload.from)} по ${hhmm(payload.to)}` }));
    dom.slept.appendChild(h('button', { class: 'esh-btn', text: '✕', onclick: () => { dom.slept.hidden = true; } }));
  }

  // Minor/M-1: сразу после старта/возобновления показываем «первая проверка
  // через минуту», а не выдуманное «проверено в <время старта>» — реальное
  // время берём из core.status().lastCheckAt: его ставит только настоящая
  // проверка (lastTickAt ядро взводит и при start()).
  function runningDetail() {
    if (badgeNote && Date.now() < badgeNote.until) return badgeNote.text;
    badgeNote = null;
    const t = core.status().lastCheckAt;
    return t ? 'проверено в ' + hhmm(t) : 'первая проверка скоро';
  }

  /* ==================== события ядра ==================== */
  // core.init() двух родов ошибок: настоящее «не вошли на сайте» (кидает
  // SessionError или обычную ошибку из core/session.js read()) и «вошли, но
  // не удалось само определить полис/дату рождения» (IdentityError из
  // core/index.js — идентификатор не нашёлся ни в idToken, ни в
  // /api-eip/v2/policy/list). Раньше оба случая показывали один и тот же
  // текст «🔒 Войдите в Polarmed» — по клику ядро пробовало снова, падало с той
  // же IdentityError и человек читал ровно то же самое сообщение по кругу,
  // хотя вход-то как раз есть. Текст для IdentityError отдельный и говорит,
  // что реально сделать (полис в хранилище сайта появляется, когда открыт
  // раздел «Полисы ОМС»).
  function initErrorBadge(e) {
    if (globalThis.PolarmedPlatform) return { kind: 'needLogin', text: '🎯 Охотник: открыть настройки', detail: e && e.message };
    if (e && e.name === 'IdentityError') {
      return { kind: 'needIdentity', text: '🔒 Не нашла полис и дату рождения', detail: 'Откройте на сайте раздел «Полисы ОМС», дождитесь загрузки и нажмите ещё раз' };
    }
    return { kind: 'needLogin', text: '🔒 Войдите в Polarmed', detail: e && e.message };
  }

  // Если в настройках поиск включён и не на паузе, после входа просто
  // возобновляем его (как при загрузке страницы), а не открываем мастер —
  // иначе открытие мастера поставило бы на паузу поиск и в других вкладках.
  let checkingContext = false;
  let contextCheckCount = 0;
  async function retryLogin(event) {
    if (checkingContext) return;
    checkingContext = true;
    const button = event && event.currentTarget;
    const previousText = button && button.textContent;
    if (button) { button.disabled = true; button.textContent = 'Проверяю выбор…'; }
    if (globalThis.PolarmedPlatform && panelMode === 'preparation') {
      dom.panel.appendChild(h('p', { class: 'esh-note', role: 'status', 'aria-live': 'polite', text: 'Проверяю выбранную специальность…' }));
    }
    let timeout;
    try {
      const init = core.init();
      if (globalThis.PolarmedPlatform) {
        await Promise.race([init, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('P_TIMEOUT: Проверка не завершилась за 10 секунд. Обновите страницу и повторите выбор специальности.')), 10000);
        })]);
      } else await init;
      const cfg = ui.loadConfig(storage);
      if (cfg && cfg.enabled && !cfg.paused && Array.isArray(cfg.targets) && cfg.targets.length) { hidePanel(); await resumeIfEnabled(); return; }
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      openWizardGuarded(1);
    } catch (e) {
      setBadge(initErrorBadge(e));
      if (globalThis.PolarmedPlatform) openPreparationPanel('Проверка №' + (++contextCheckCount) + ' не пройдена. ' + (e && e.message));
    } finally {
      if (timeout) clearTimeout(timeout);
      checkingContext = false;
      if (button) { button.disabled = false; button.textContent = previousText; }
    }
  }

  function onBooked(payload) {
    const where = payload.address ? ` — ${ui.stripCampus(payload.address)}` : '';
    const doctor = payload.slot.doctorName ? ' — врач: ' + payload.slot.doctorName : '';
    notify('Polarmed: записано', `${payload.title}: ${ui.human(payload.slot.startTime)}${where}${doctor}`);
    pushLog({ at: Date.now(), msg: `Записано: ${payload.title} — ${ui.human(payload.slot.startTime)}${doctor}` });
    // C1: раннер меняет current/source/scenario цели (перенос keepImproving)
    // только у себя в памяти — без этого сохранённые настройки (cfg.targets)
    // оставались бы со старыми полями, и следующий запуск по ним (перезагрузка
    // страницы, standby-вкладка, «Продолжить в этой вкладке») мог бы перенести
    // уже улучшенную запись НАЗАД. confirmedFor не трогаем — applyBookedUpdate
    // меняет только сами targets.
    const cfg = ui.loadConfig(storage);
    const nextCfg = ui.applyBookedUpdate(cfg, payload);
    // lastBooked держит оранжевый значок, пока человек его не увидит (клик),
    // в том числе после перезагрузки страницы.
    if (nextCfg) ui.saveConfig(storage, { ...nextCfg, lastBooked: { title: payload.title + doctor, startTime: payload.slot.startTime, address: payload.address || null } });
    // Minor: раньше при возврате из «Записано» цвет менялся обратно, а текст
    // оставался старым («🟠 Записано: …») — запоминаем значок целиком (а не
    // только его kind), чтобы вернуть и текст тоже.
    if (badgeState.kind !== 'booked') preBookedBadge = { ...badgeState };
    if (!showBookedBadge()) setBadge({ kind: 'booked', text: '🟠 Записано: ' + payload.title, detail: '' });
    if (globalThis.PolarmedPlatform) onTargetDone({ title: payload.title, message: payload.message });
  }

  // Раньше значок «Записано» через 8 секунд сам возвращался к «Ищу слоты», и
  // если человек не смотрел на экран, о переносе он не узнавал. Теперь значок
  // остаётся оранжевым, пока по нему не кликнут (и после перезагрузки тоже).
  function showBookedBadge() {
    const cfg = ui.loadConfig(storage);
    const b = cfg && cfg.lastBooked;
    if (!b) return false;
    setBadge({ kind: 'booked', text: '🟠 Записано: ' + b.title, detail: b.startTime ? 'на ' + ui.human(b.startTime) + ' — нажмите, чтобы посмотреть' : '' });
    return true;
  }

  function acknowledgeBooked() {
    const cfg = ui.loadConfig(storage);
    if (cfg && cfg.lastBooked) { const next = { ...cfg }; delete next.lastBooked; ui.saveConfig(storage, next); }
    if (core.status().running) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
    else if (finishedAll) setBadge({ kind: 'idle', text: '✅ Готово', detail: 'все цели выполнены' });
    else if (preBookedBadge) setBadge(preBookedBadge);
  }

  // Цель завершена сама (например, до записи осталось мало времени) — если
  // так завершились все цели, поиск останавливаем: ходить в Polarmed незачем.
  // Раннер перевёл цель новой записи в перенос уже существующей записи по
  // направлению. Сохраняем новые поля так же, как после 'booked', но без
  // уведомления «Записано»: записи в этот момент никто не делал.
  function onTargetUpdated(payload) {
    const cfg = ui.loadConfig(storage);
    const nextCfg = ui.applyBookedUpdate(cfg, payload);
    if (nextCfg !== cfg) ui.saveConfig(storage, nextCfg);
  }

  function onTargetDone(payload) {
    pushLog({ at: Date.now(), msg: `${payload.title}: ${payload.message}` });
    const all = core.status().targets || [];
    if (!all.length || !all.every((t) => t.state === 'done' || t.state === 'stopped')) return;
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    const cfg = ui.loadConfig(storage) || {};
    const needsReview = !!globalThis.PolarmedPlatform && all.some((t) => t.state === 'stopped');
    ui.saveConfig(storage, { ...cfg, enabled: false, ...(needsReview ? { reviewMessage: payload.message } : {}) });
    finishedAll = true;
    if (needsReview) {
      notify('Polarmed: проверьте результат', payload.message);
      setBadge({ kind: 'needsReview', text: '🟠 Проверьте результат', detail: payload.message });
      return;
    }
    notify('Polarmed: поиск завершён', 'Все цели выполнены, охотник остановился');
    if (!showBookedBadge()) setBadge({ kind: 'idle', text: '✅ Готово', detail: 'все цели выполнены' });
  }

  function onFound(payload) {
    if (payload && payload.targetId) foundCount[payload.targetId] = (foundCount[payload.targetId] || 0) + 1;
    pushLog({ at: Date.now(), msg: `${titleFor(payload.targetId)}: ${payload.warning || 'проверила расписание'}` });
  }

  function onLog(payload) { pushLog(payload); }

  function onSessionLost(payload) {
    // Minor: текст payload.message раньше нигде не показывался — теперь он
    // идёт в пояснение к значку (и в панель объяснения, см. renderRecoveryPanel).
    setBadge({ kind: 'sessionLost', text: '🔴 Нужно войти в другой вкладке', detail: (payload && payload.message) || '' });
    startRecoveryWatch();
  }

  function onStale(payload) {
    setBadge({ kind: 'stale', text: '🔴 Давно нет ответа от Polarmed', detail: 'с ' + hhmm(payload.since) });
    startRecoveryWatch();
  }

  function onStandby(payload) {
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch(); // M-2
    clearAllConfirmCards(); // I6
    setBadge({ kind: 'standby', text: '↔ Поиск идёт в другой вкладке', detail: '' });
    startStandbyRetry(); // I11
  }

  // C2 п.1: раннер сам останавливается и просит новый холостой прогон, если
  // цели изменились уже во время работающего цикла (например, обошли
  // openWizardGuarded). UI-обработчику остаётся только честно это показать —
  // сам поиск в этот момент уже не идёт.
  function onNeedDryRun(payload) {
    runningFor = null;
    stopStatusRefresh();
    clearAllConfirmCards();
    setBadge({ kind: 'needDryRun', text: '🔴 Нужен новый холостой прогон', detail: (payload && payload.message) || '' });
  }

  // I10: исключение в любом обработчике не должно вылетать из emit() внутри
  // tick() и останавливать поиск навсегда при зелёном значке.
  function safe(fn) {
    return (payload) => {
      try { fn(payload); } catch (e) { try { console.error('polarmed-slot-hunter: обработчик события упал', e); } catch (e2) { /* даже это необязательно */ } }
    };
  }

  function subscribeCore() {
    core.on('log', safe(onLog));
    core.on('found', safe(onFound));
    core.on('booked', safe(onBooked));
    core.on('targetUpdated', safe(onTargetUpdated));
    core.on('targetDone', safe(onTargetDone));
    core.on('needConfirm', safe(onNeedConfirm));
    core.on('sessionLost', safe(onSessionLost));
    core.on('stale', safe(onStale));
    core.on('slept', safe(onSlept));
    core.on('standby', safe(onStandby));
    core.on('needDryRun', safe(onNeedDryRun));
  }

  /* ==================== обновление «время последней проверки» и восстановление ==================== */
  function startStatusRefresh() {
    stopStatusRefresh();
    statusRefreshId = setInterval(() => {
      if (yieldIfReconfigured()) return;
      if (badgeState.kind !== 'running' && badgeState.kind !== 'resuming') return;
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      if (panelMode === 'status') renderStatusPanel();
    }, 5000);
  }

  function stopStatusRefresh() { if (statusRefreshId) clearInterval(statusRefreshId); statusRefreshId = null; }

  // C-1 п.3: работающая вкладка сверяет настройки со своими. Если поиск
  // выключили, поставили на паузу (открыли мастер) или подтвердили другие
  // цели в другой вкладке — останавливаемся. В настройки при этом ничего не
  // пишем: это решение другой вкладки. Дальше ведём себя как в standby —
  // раз в минуту смотрим, не пора ли продолжить по новым условиям.
  function yieldIfReconfigured() {
    if (!core.status().running) return false;
    const cfg = ui.loadConfig(storage);
    const same = cfg && cfg.enabled && !cfg.paused && runningFor && cfg.confirmedFor === runningFor;
    if (same) return false;
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch();
    clearAllConfirmCards();
    if (!cfg || !cfg.enabled) {
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: 'поиск остановили в другой вкладке' });
      if (panelMode === 'status' || panelMode === 'recovery') hidePanel();
      return true;
    }
    setBadge({ kind: 'standby', text: '↔ Поиск перенастраивается в другой вкладке', detail: '' });
    if (panelMode === 'status' || panelMode === 'recovery') hidePanel();
    startStandbyRetry();
    return true;
  }

  // M-2: наблюдение за восстановлением после sessionLost/stale не должно
  // переживать остановку, standby и открытие мастера — иначе оно вернуло бы
  // зелёный значок, когда поиск уже не идёт.
  function stopRecoveryWatch() { if (recoveryWatchId) clearInterval(recoveryWatchId); recoveryWatchId = null; }

  // После sessionLost/stale ждём, пока раннер сам не сделает успешную
  // проверку (lastOkAt сдвинется вперёд) — тогда молча возвращаем зелёный
  // значок, без перезапуска поиска человеком.
  function startRecoveryWatch() {
    const since = core.status().lastOkAt;
    if (recoveryWatchId) clearInterval(recoveryWatchId);
    recoveryWatchId = setInterval(() => {
      const st = core.status();
      if (st.lastOkAt > since) {
        clearInterval(recoveryWatchId);
        recoveryWatchId = null;
        setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
        startStatusRefresh();
      }
    }, 5000);
  }

  // I11: standby — не конечное состояние. Если вкладку-лидера закрыли, эта
  // вкладка не должна навсегда остаться на «поиск идёт в другой вкладке» —
  // раз в минуту, пока в настройках enabled, пробуем start() заново; ядро
  // само уладит спор вкладок через channel.
  // C-1 п.1: стартуем не по целям из памяти вкладки, а по свежим настройкам
  // и только после нового холостого прогона, совпавшего с подтверждённым
  // (startFromSavedConfig). На паузе (в другой вкладке открыт мастер) или
  // при несовпадении отпечатка — молча ждём следующей минуты.
  // Task 12c: пока лидер жив, дорогой startFromSavedConfig() (реальные
  // запросы к Polarmed по всем целям, затем мгновенный проигрыш спора вкладок
  // и возврат в standby) звать незачем — значок на миг показывал «Ищу
  // слоты» при живой вкладке-лидере. Лидер раз в 20 с шлёт в channel
  // heartbeat (core.leaderSeenAt()); повторную попытку делаем, только если
  // от него давно ничего не слышно (порог намного больше периода
  // heartbeat — переживает пропуск одного-двух сигналов). Если недавно
  // слышали — молча ждём следующей минуты, ничего не запрашивая.
  const LEADER_SILENCE_MS = 90000;
  let standbyRetryBusy = false;
  function startStandbyRetry() {
    if (standbyRetryId) clearInterval(standbyRetryId);
    standbyRetryId = setInterval(async () => {
      if (badgeState.kind !== 'standby') { clearInterval(standbyRetryId); standbyRetryId = null; return; }
      if (standbyRetryBusy || wizard.open) return;
      const cfg = ui.loadConfig(storage);
      if (!cfg || !cfg.enabled) {
        // Поиск выключили в другой вкладке — ждать больше нечего. Это
        // дешёвая проверка настроек (localStorage), а не сеть — её незачем
        // придерживать гейтом лидера ниже.
        clearInterval(standbyRetryId);
        standbyRetryId = null;
        setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
        if (panelMode === 'standby') hidePanel();
        return;
      }
      if (cfg.paused) return;
      // Дорогой путь ниже (холостой прогон по сети) — только если от лидера
      // давно не было вестей; сама эта проверка и всё выше — не в сеть.
      if (Date.now() - core.leaderSeenAt() <= LEADER_SILENCE_MS) return;
      standbyRetryBusy = true;
      try {
        const r = await startFromSavedConfig();
        if (r.status !== 'started') return;
        if (standbyRetryId) clearInterval(standbyRetryId);
        standbyRetryId = null;
        setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
        startStatusRefresh();
        if (panelMode === 'standby') hidePanel();
      } catch (e) {
        /* нет связи или другая вкладка ещё жива — попробуем через минуту снова */
      } finally {
        standbyRetryBusy = false;
      }
    }, 60000);
  }

  /* ==================== запуск по сохранённым настройкам ==================== */
  // Единый путь для возобновления после перезагрузки, повтора в standby и
  // кнопки «Продолжить в этой вкладке» (C-1 п.1):
  //   перечитать настройки → setTargets(cfg.targets) → холостой прогон →
  //   сверить отпечаток с cfg.confirmedFor → только при совпадении
  //   confirmDryRun + start.
  // I-1: после прогона (он идёт по сети, это секунды) ещё раз проверяем, что
  // попытка не устарела (не нажали «Остановить», не открыли мастер) и что
  // настройки за это время не поменялись в другой вкладке.
  // Возвращает { status } — 'started' | 'mismatch' (с cfg и report) |
  // 'off' (поиск выключен/целей нет) | 'paused' | 'superseded'.
  // Ошибки связи пробрасывает наружу.
  function sameSavedConfig(a, b) {
    return !!(a && b) && a.enabled === b.enabled && !!a.paused === !!b.paused &&
      a.confirmedFor === b.confirmedFor && JSON.stringify(a.targets) === JSON.stringify(b.targets);
  }

  async function startFromSavedConfig() {
    const attempt = ++startAttempt;
    const cfg = ui.loadConfig(storage);
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.targets) || !cfg.targets.length) return { status: 'off' };
    if (cfg.paused) return { status: 'paused', cfg };
    core.setTargets(cfg.targets);
    const report = await core.dryRun();
    if (attempt !== startAttempt) return { status: 'superseded' };
    const fresh = ui.loadConfig(storage);
    if (!sameSavedConfig(cfg, fresh)) {
      if (!fresh || !fresh.enabled) return { status: 'off' };
      if (fresh.paused) return { status: 'paused', cfg: fresh };
      return { status: 'superseded' };
    }
    if (report.targetsHash !== cfg.confirmedFor) return { status: 'mismatch', cfg, report };
    core.confirmDryRun(report.id);
    await core.start();
    runningFor = cfg.confirmedFor;
    return { status: 'started', cfg };
  }

  // Условия за пределами мастера изменились (например, структура записей
  // на сайте) — не запускаем молча, показываем новый холостой прогон на
  // шаге 3, чтобы человек подтвердил его ещё раз.
  // C1: цели уже переданы в ядро и отчёт уже снят (report — по cfg.targets) —
  // рисуем renderStep3(report) напрямую, не трогая wizard.selected и не
  // вызывая openWizard(3)/loadStep3(), которые пересобрали бы цели из пустого
  // wizard.selected и стёрли бы их в core.setTargets([]).
  // I-2: значок при этом не должен оставаться зелёным — поиск не идёт.
  function showReconfirm(cfg, report) {
    setBadge({ kind: 'needDryRun', text: '🔴 Подтвердите условия заново', detail: 'поиск не идёт, пока вы не подтвердите' });
    wizard.builtTargets = cfg.targets;
    wizard.report = report;
    wizard.checked = false;
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = 3;
    showPanel();
    renderStep3(report);
  }

  /* ==================== возобновление после перезагрузки страницы ==================== */
  async function resumeIfEnabled() {
    setBadge({ kind: 'init', text: '…', detail: '' });
    try {
      await core.init();
    } catch (e) {
      setBadge(initErrorBadge(e));
      return;
    }

    const cfg = ui.loadConfig(storage);
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.targets) || !cfg.targets.length) {
      if (globalThis.PolarmedPlatform && cfg && cfg.reviewMessage) {
        setBadge({ kind: 'needsReview', text: '🟠 Проверьте результат', detail: cfg.reviewMessage });
        return;
      }
      if (globalThis.PolarmedPlatform && showBookedBadge()) return;
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      return;
    }
    if (cfg.paused) {
      // Мастер открывали (здесь или в другой вкладке) и новые условия ещё
      // не подтвердили — по старым целям молча не стартуем.
      setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нажмите, чтобы настроить заново' });
      return;
    }

    setBadge({ kind: 'resuming', text: '🟢 Возобновляю поиск…', detail: '' });
    let r;
    try {
      r = await startFromSavedConfig();
    } catch (e) {
      setBadge({ kind: 'resumeError', text: '🔴 Не удалось проверить, нажмите для повтора', detail: e && e.message });
      return;
    }

    if (r.status === 'started') {
      if (!showBookedBadge()) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      startStatusRefresh();
    } else if (r.status === 'mismatch') {
      showReconfirm(r.cfg, r.report);
    } else if (r.status === 'off') {
      // I-1: пока шёл прогон, поиск выключили (здесь или в другой вкладке).
      if (badgeState.kind === 'resuming') setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
    } else if (r.status === 'paused') {
      if (badgeState.kind === 'resuming') setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нажмите, чтобы настроить заново' });
    } else if (r.status === 'superseded' && badgeState.kind === 'resuming') {
      // Настройки поменялись в другой вкладке во время прогона — пробуем
      // заново уже по новым.
      resumeIfEnabled();
    }
    // superseded из-за «Остановить»/мастера в этой вкладке: значок уже
    // выставлен ими, ничего не трогаем.
  }

  /* ==================== запуск ==================== */
  async function boot() {
    mountBadge();
    const timer = createWorkerTimer();
    let channel = null;
    try { channel = new BroadcastChannel('polarmed-slot-hunter'); } catch (e) { channel = null; }
    core = create({ storage, fetch: window.fetch.bind(window), now: () => Date.now(), timer, channel,
      platform: globalThis.PolarmedPlatform });
    subscribeCore();
    await resumeIfEnabled();
  }

  boot();
})();

})();
