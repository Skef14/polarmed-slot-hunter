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
        // Сессия сайта cookie+n3, а не токены ЕМИАС. Продление ЕСИА не эмулируем.
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
