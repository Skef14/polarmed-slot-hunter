const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const contract = require('../adapters/polarmed');
const { makePlatform, readSiteData } = require('../adapters/polarmed-platform');
const { createUtil } = require('../core/util');
const { createFilters } = require('../core/filters');
const { create } = require('../core/index');
const { createUiState } = require('../userscript/ui-state');
const modules = Object.assign({}, require('../core/util'), require('../core/errors'),
  require('../core/filters'), require('../core/runner'));

const DAY = '2030-05-20';
const TIME = Date.parse('2030-05-19T09:00:00+03:00');
const available = () => ({ success: true, response: { [DAY]: [{ id: 'ticket-a',
  date_start: { iso: DAY + 'T10:00:00', time: '10:00' },
  date_end: { iso: DAY + 'T10:15:00', time: '10:15' },
}] } });

function environment() {
  const c = { patientId: 'patient-secret', historyId: 'history-secret', clinicId: 'clinic-a', doctorId: 'doctor-a',
    specialityId: 'speciality-a', session: 'session-secret', sessionExpires: 'expiry-secret', csrf: 'csrf-secret',
    doctorName: 'Тестовый врач', clinicName: 'Тестовая клиника', specialityName: 'Терапевт',
    patientFio: 'private-name', address: 'Тестовая улица, 1',
    listAction: '/api/appointment_list/', bookingAction: '/api/signup/', doctorsAction: '/api/doctor_list/' };
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) || null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  const requests = [];
  let lock = Promise.resolve();
  const withLock = (fn) => {
    const next = lock.then(fn);
    lock = next.catch(() => {});
    return next;
  };
  const e = { c, storage, values, requests, clock: TIME, active: true,
    slots: available(), verified: true, signup: { success: true },
    register: '', status: 200, throwSignup: false, throwList: false,
    doctors: { success: true, response: [{ IdDoc: 'doctor-a', Name: 'Тестовый врач' }] }, slotsByDoctor: {} };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    let body;
    if (url === '/api/doctor_list/') body = e.doctors;
    else if (url === '/api/appointment_list/') {
      if (e.throwList) throw new Error('Network unavailable');
      body = e.slotsByDoctor[new URLSearchParams(options.body).get('doctor_form-doctor_id')] || e.slots;
    } else if (url === '/api/signup/') {
      if (e.throwSignup) throw new Error('Connection lost after mutation');
      body = e.signup;
    } else if (url === '/signup/create-appointment/') body = e.register;
    else if (url === '/profile/') body = 'profile';
    else throw new Error('Unexpected request');
    return { ok: e.status < 400, status: e.status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  };
  e.fetch = fetch;
  e.platform = makePlatform({ contract, readContext: () => ({ ...c }),
    scopeOf: async (current) => current.patientId === 'patient-secret' ? 'scope-a' : 'scope-b',
    withLock, verifyProfile: () => e.verified });
  const filters = createFilters(createUtil());
  e.runtime = () => e.platform.create({ storage, fetch, now: () => e.clock, filters });
  e.integration = e.runtime();
  e.core = () => create({ storage, fetch, now: () => e.clock, modules, platform: e.platform,
    timer: e.timer = { callback: null, schedule(ms, fn) { this.ms = ms; this.callback = fn; }, cancel() { this.callback = null; } } });
  e.target = async () => {
    const options = await e.integration.discover.list();
    return createUiState().buildTarget(options[0], { mode: 'auto', respectTravel: true });
  };
  e.anyTarget = async () => {
    const options = await e.integration.discover.list();
    return createUiState().buildTarget(options.find((o) => o.source.anyDoctor), { mode: 'auto' });
  };
  e.ctx = () => ({ now: e.clock, appointments: [], isActive: () => e.active });
  e.candidate = async (target) => (await e.integration.targets.search(target, e.ctx())).candidates[0];
  return e;
}

test('Polarmed: контекст связывает цель с пациентом, в настройках нет сессии или персональных полей', async () => {
  const e = environment();
  const target = await e.target();
  assert.equal(target.scenario, 'polarmedBook');
  assert.equal(target.keepImproving, false);
  assert.equal(target.respectTravel, false);
  assert.doesNotMatch(JSON.stringify(target), /patient-secret|history-secret|session-secret|csrf-secret|private-name/);
  e.c.patientId = 'another-patient';
  await assert.rejects(() => e.integration.targets.search(target, e.ctx()), /изменились/);
  assert.equal(e.requests.length, 0);
});

test('Polarmed: без истории обращения работают настройка, поиск по специальности и новая запись', async () => {
  for (const history of [undefined, null, '', '   ']) {
    const e = environment();
    e.c.historyId = history;
    delete e.c.doctorId;
    const h = e.core();
    await h.init();
    const [option] = await h.discover();
    assert.equal(option.source.anyDoctor, true);
    h.setTargets([createUiState().buildTarget(option, {})]);
    const report = await h.dryRun();
    assert.ok(report.items[0].would);
    h.confirmDryRun(report.id);
    await h.start();
    await e.timer.callback();
    assert.equal(h.status().targets[0].state, 'done');
    const prefixes = { '/api/doctor_list/': 'speciality_form', '/api/appointment_list/': 'doctor_form',
      '/api/signup/': 'appointment_form' };
    for (const request of e.requests) {
      const prefix = prefixes[request.url];
      if (!prefix) continue;
      const fields = new URLSearchParams(request.options.body);
      assert.equal(fields.get(prefix + '-history_id'), '');
      assert.equal(fields.get(prefix + '-patient_id'), 'patient-secret');
      assert.equal(fields.get(prefix + '-n3_session'), 'session-secret');
    }
  }
});

test('Polarmed: необязательная история обращения не ослабляет проверку пациента и защитных полей', async () => {
  for (const key of ['patientId', 'clinicId', 'specialityId', 'session', 'sessionExpires', 'csrf']) {
    const e = environment();
    delete e.c.historyId;
    delete e.c[key];
    await assert.rejects(() => e.integration.init(), /P_FIELDS/);
    assert.equal(e.requests.length, 0);
  }
});

test('Polarmed: для всей специальности конкретного врача выбирать не требуется', async () => {
  const e = environment();
  delete e.c.doctorId;
  delete e.c.doctorName;
  await e.integration.init();
  const options = await e.integration.discover.list();
  assert.equal(options.length, 1);
  assert.equal(options[0].source.anyDoctor, true);
  const t = await e.anyTarget();
  const result = await e.integration.targets.search(t, e.ctx());
  assert.equal(result.candidates[0].resourceId, 'doctor-a');
  assert.equal(result.candidates[0].slot.doctorName, 'Тестовый врач');
  const fields = new URLSearchParams(e.requests[0].options.body);
  assert.equal(e.requests[0].url, '/api/doctor_list/');
  assert.equal(fields.get('speciality_form-speciality_id'), 'speciality-a');
  assert.equal(fields.get('speciality_form-patient_id'), 'patient-secret');
  assert.ok(!Object.hasOwn(t.source, 'doctorId'));
});

test('Polarmed: первый подходящий врач, а не глобально самое раннее время; нулевой счётчик не исключает врача', async () => {
  const e = environment();
  e.doctors.response = [
    { IdDoc: 'doctor-a', Name: 'Первый врач', CountFreeParticipantIE: 0 },
    { IdDoc: 'doctor-b', Name: 'Второй врач', CountFreeParticipantIE: 4 },
    { IdDoc: 'doctor-c', Name: 'Третий врач', CountFreeParticipantIE: 8 },
  ];
  e.slotsByDoctor['doctor-a'] = { success: true, response: {} };
  const result = await e.integration.targets.search(await e.anyTarget(), e.ctx());
  assert.equal(result.candidates[0].resourceId, 'doctor-b');
  assert.deepEqual(e.requests.filter((r) => r.url === '/api/appointment_list/')
    .map((r) => new URLSearchParams(r.options.body).get('doctor_form-doctor_id')), ['doctor-a', 'doctor-b']);
  e.requests.length = 0;
  e.slotsByDoctor['doctor-a'] = available();
  assert.equal((await e.integration.targets.search(await e.anyTarget(), e.ctx())).candidates[0].resourceId, 'doctor-a');
  assert.equal(e.requests.filter((r) => r.url === '/api/appointment_list/').length, 1);
});

test('Polarmed: неподходящие по фильтрам талоны первого врача не мешают проверить следующего', async () => {
  const e = environment();
  e.doctors.response.push({ IdDoc: 'doctor-b', Name: 'Второй врач' });
  e.slotsByDoctor['doctor-a'] = available();
  e.slotsByDoctor['doctor-a'].response[DAY][0].date_start = { iso: DAY + 'T08:00:00', time: '08:00' };
  e.slotsByDoctor['doctor-a'].response[DAY][0].date_end = { iso: DAY + 'T08:15:00', time: '08:15' };
  const result = await e.integration.targets.search({ ...await e.anyTarget(), timeFrom: '09:00' }, e.ctx());
  assert.equal(result.candidates[0].resourceId, 'doctor-b');
  assert.equal(result.rejected.length, 1);
});

test('Polarmed: подтверждение не подменяет врача, даже если у предыдущего появились талоны', async () => {
  const e = environment();
  delete e.c.doctorId;
  e.doctors.response.push({ IdDoc: 'doctor-b', Name: 'Второй врач' });
  e.slotsByDoctor['doctor-a'] = { success: true, response: {} };
  const t = await e.anyTarget();
  const candidate = (await e.integration.targets.search(t, e.ctx())).candidates[0];
  assert.equal(candidate.resourceId, 'doctor-b');
  e.slotsByDoctor['doctor-a'] = available();
  const result = await e.integration.targets.act(t, candidate, e.ctx());
  assert.equal(result.verified, true);
  const registered = e.requests.find((r) => r.url === '/signup/create-appointment/');
  const fields = new URLSearchParams(registered.options.body);
  assert.equal(fields.get('doctor_id'), 'doctor-b');
  assert.equal(fields.get('doctor'), 'Второй врач');
});

test('Polarmed: пропавший из специальности врач не бронируется; чужого врача нельзя подставить кандидатом', async () => {
  const e = environment();
  const t = await e.anyTarget();
  const candidate = (await e.integration.targets.search(t, e.ctx())).candidates[0];
  const forged = { ...candidate, resourceId: 'other-doctor' };
  assert.equal((await e.integration.targets.act(t, forged, e.ctx())).ok, false);
  e.doctors.response = [];
  assert.equal((await e.integration.targets.act(t, candidate, e.ctx())).ok, false);
  assert.ok(!e.requests.some((r) => r.url === '/api/signup/'));
});

test('Polarmed: в режиме всей специальности выбор другого врача не меняет цель, а смена специальности блокируется', async () => {
  const e = environment();
  const t = await e.anyTarget();
  e.c.doctorId = 'different-selected-doctor';
  assert.equal((await e.integration.targets.search(t, e.ctx())).candidates.length, 1);
  e.c.specialityId = 'different-speciality';
  await assert.rejects(() => e.integration.targets.search(t, e.ctx()), /изменились/);
});

test('Polarmed: ограничение сервера останавливает обход врачей сразу, а остановка поиска не начинает обход', async () => {
  const e = environment();
  e.doctors.response.push({ IdDoc: 'doctor-b', Name: 'Второй врач' });
  const t = await e.anyTarget();
  const originalFetch = e.fetch;
  const runtime = e.platform.create({ storage: e.storage, now: () => e.clock, filters: createFilters(createUtil()),
    fetch: async (url, opts) => url === '/api/appointment_list/'
      ? (e.requests.push({ url, options: opts }), { ok: false, status: 429, text: async () => '' })
      : originalFetch(url, opts) });
  await assert.rejects(() => runtime.targets.search(t, e.ctx()));
  assert.equal(e.requests.filter((r) => r.url === '/api/appointment_list/').length, 1);
  e.active = false;
  e.requests.length = 0;
  const stopped = await e.integration.targets.search(t, e.ctx());
  assert.equal(stopped.candidates.length, 0);
  assert.ok(!e.requests.some((r) => r.url === '/api/appointment_list/'));
});

test('Polarmed: смена врача, специальности или поликлиники требует новой настройки', async () => {
  for (const key of ['doctorId', 'specialityId', 'clinicId']) {
    const e = environment();
    const t = await e.target();
    e.c[key] = 'changed';
    await assert.rejects(() => e.integration.targets.search(t, e.ctx()), /изменились/);
    assert.equal(e.requests.length, 0);
  }
});

test('Polarmed: неизвестный action формы блокирует работу; travel нельзя молча игнорировать', async () => {
  const e = environment();
  const t = await e.target();
  e.c.bookingAction = '/api/other/';
  await assert.rejects(() => e.integration.init(), /Формы/);
  e.c.bookingAction = '/api/signup/';
  await assert.rejects(() => e.integration.targets.search({ ...t, respectTravel: true }, e.ctx()), /дорогу|записей/);
});

test('Polarmed: поиск использует appointment_list, текущую сессию и фильтры исходного проекта', async () => {
  const e = environment();
  const t = await e.target();
  const result = await e.integration.targets.search(t, e.ctx());
  assert.equal(result.candidates.length, 1);
  const { url, options } = e.requests[0];
  assert.equal(url, '/api/appointment_list/');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['X-CSRFToken'], 'csrf-secret');
  assert.equal(new URLSearchParams(options.body).get('doctor_form-patient_id'), 'patient-secret');
  assert.equal((await e.integration.targets.search({ ...t, timeFrom: '11:00' }, e.ctx())).candidates.length, 0);
  assert.equal((await e.integration.targets.search({ ...t, addressContains: 'other' }, e.ctx())).candidates.length, 0);
});

test('Polarmed: время старой записи используется только как фильтр более ранних талонов', async () => {
  const e = environment();
  const [option] = await e.integration.discover.list();
  const ui = createUiState();
  const later = ui.buildTarget(option, { existingStart: DAY + 'T11:00' });
  assert.equal(later.current, DAY + 'T11:00:00+03:00');
  assert.equal((await e.integration.targets.search(later, e.ctx())).candidates.length, 1);
  const earlier = ui.buildTarget(option, { existingStart: DAY + 'T09:00' });
  assert.equal((await e.integration.targets.search(earlier, e.ctx())).candidates.length, 0);
  assert.ok(e.requests.every((r) => r.url === '/api/appointment_list/'));
});

test('Polarmed: сквозной путь сохраняет холостой прогон, гейт, минимальный интервал и новую запись без переноса', async () => {
  const e = environment();
  const h = e.core();
  await h.init();
  const options = await h.discover();
  h.setTargets([createUiState().buildTarget(options[0], {})]);
  const report = await h.dryRun();
  assert.ok(report.items[0].would);
  assert.ok(e.requests.every((r) => r.url === '/api/appointment_list/'));
  await assert.rejects(() => h.start(), /холостой прогон/);
  h.confirmDryRun(report.id);
  await h.start();
  assert.ok(e.timer.ms >= 20000);
  await e.timer.callback();
  assert.equal(h.status().targets[0].state, 'done');
  const signup = e.requests.find((r) => r.url === '/api/signup/');
  assert.equal(new URLSearchParams(signup.options.body).get('appointment_form-appointment_id'), 'ticket-a');
  assert.deepEqual(e.requests.slice(-3).map((r) => r.url), ['/api/signup/', '/signup/create-appointment/', '/profile/']);
  assert.ok(!e.requests.some((r) => /cancel|claim|shift|emias|api-eip/.test(r.url)));
  assert.doesNotMatch(JSON.stringify([...e.values]), /patient-secret|history-secret|session-secret|private-name/);
  assert.equal(JSON.parse([...e.values.values()][0]).status, 'verified');
});

test('Polarmed: режим подтверждения ничего не пишет до решения пользователя', async () => {
  const e = environment();
  const h = e.core();
  await h.init();
  const [option] = await h.discover();
  h.setTargets([createUiState().buildTarget(option, { mode: 'confirm' })]);
  const report = await h.dryRun();
  h.confirmDryRun(report.id);
  await h.start();
  await e.timer.callback();
  assert.equal(h.status().pending.length, 1);
  assert.ok(!e.requests.some((r) => r.url === '/api/signup/'));
  await h.answer(option.id, 'book');
  assert.equal(h.status().targets[0].state, 'done');
});

test('Polarmed: таймаут записи блокирует ВСЕ новые талоны до ручной проверки, включая перезапуск', async () => {
  const e = environment();
  const t = await e.target();
  const candidate = await e.candidate(t);
  e.throwSignup = true;
  const result = await e.integration.targets.act(t, candidate, e.ctx());
  assert.equal(result.action, 'stopTarget');
  assert.equal(result.verified, false);
  e.clock += 3600000;
  e.slots.response[DAY][0].id = 'different-ticket';
  const freshRuntime = e.runtime();
  const blocked = await freshRuntime.targets.search(t, e.ctx());
  assert.equal(blocked.action, 'stopTarget');
  assert.equal(e.requests.filter((r) => r.url === '/api/signup/').length, 1);
  await freshRuntime.reviewAttempt();
  assert.equal((await freshRuntime.targets.search(t, e.ctx())).candidates.length, 1);
});

test('Polarmed: отсутствие независимого подтверждения не выдаётся за успешную запись', async () => {
  const e = environment();
  e.verified = false;
  const t = await e.target();
  const result = await e.integration.targets.act(t, await e.candidate(t), e.ctx());
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.action, 'stopTarget');
  assert.equal(e.values.size, 1);
});

test('Polarmed: бизнес-отказ сайта не вызывает отмену старого талона или повтор signup', async () => {
  const e = environment();
  e.signup = { success: false, error: { ErrorDescription: 'PRIVATE-SERVER-TEXT' } };
  const t = await e.target();
  const result = await e.integration.targets.act(t, await e.candidate(t), e.ctx());
  assert.equal(result.action, 'stopTarget');
  assert.doesNotMatch(result.message, /PRIVATE/);
  assert.equal(e.requests.filter((r) => r.url === '/api/signup/').length, 1);
  assert.ok(!e.requests.some((r) => r.url === '/signup/create-appointment/'));
});

test('Polarmed: талон исчез или пользователь остановил поиск — signup не отправляется', async () => {
  for (const stopped of [false, true]) {
    const e = environment();
    const t = await e.target();
    const candidate = await e.candidate(t);
    if (stopped) e.active = false;
    else e.slots = { success: true, response: {} };
    const result = await e.integration.targets.act(t, candidate, e.ctx());
    assert.equal(result.ok, false);
    assert.ok(!e.requests.some((r) => r.url === '/api/signup/'));
    assert.equal(e.values.size, 0);
  }
});

test('Polarmed: запрет сохранения журнала предотвращает запрос записи', async () => {
  const e = environment();
  const t = await e.target();
  const candidate = await e.candidate(t);
  e.storage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(() => e.integration.targets.act(t, candidate, e.ctx()));
  assert.ok(!e.requests.some((r) => r.url === '/api/signup/'));
});

test('Polarmed: две вкладки под общей блокировкой не могут выполнить две записи', async () => {
  const e = environment();
  const second = e.runtime();
  const t = await e.target();
  const candidate = await e.candidate(t);
  await Promise.all([e.integration.targets.act(t, candidate, e.ctx()), second.targets.act(t, candidate, e.ctx())]);
  assert.equal(e.requests.filter((r) => r.url === '/api/signup/').length, 1);
});

test('Polarmed: сетевая ошибка и HTTP 429 устанавливают паузу; 403 означает потерю сессии', async () => {
  for (const status of [0, 429, 403]) {
    const e = environment();
    const t = await e.target();
    e.status = status;
    e.throwList = status === 0;
    await assert.rejects(() => e.integration.targets.search(t, e.ctx()),
      status === 403 ? { name: 'SessionError' } : undefined);
    if (status !== 403) {
      assert.ok(e.integration.api.backoffUntil() > e.clock);
      await assert.rejects(() => e.integration.targets.search(t, e.ctx()));
      assert.equal(e.requests.length, 1);
    }
  }
});

test('Polarmed: отдельная сборка содержит интерфейс и адаптер, без автообновлений ЕМИАС', () => {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, ['scripts/build-polarmed.js'], { cwd: root });
  const output = fs.readFileSync(path.join(root, 'dist/polarmed-slot-hunter.user.js'), 'utf8');
  assert.ok(output.startsWith('// ==UserScript=='));
  assert.match(output, /@match\s+https:\/\/reg\.polarmed\.ru\/\*/);
  assert.match(output, /polarmedSlotHunter:config/);
  assert.match(output, /PolarmedPlatform/);
  assert.doesNotMatch(output, /@(?:downloadURL|updateURL)|data-site\//);
  assert.doesNotMatch(output, /fetch\(['"]\/api-eip\/|['"]EI-Token['"]/);
  new vm.Script(output);
});

test('Polarmed: собранный адаптер работает с моделью app, cookie и DOM сайта без фабрик-заглушек', async () => {
  const e = environment();
  const data = {
    clinic: { id: e.c.clinicId, title: e.c.clinicName, data: { title: e.c.clinicName, address: e.c.address } },
    doctor: { id: e.c.doctorId, title: e.c.doctorName },
    speciality: { id: e.c.specialityId, title: e.c.specialityName },
    preset: { first_name: 'private-name', additional: { patient_id: e.c.patientId, history_id: e.c.historyId } },
  };
  const attrs = { 'data-appointment-id': 'ticket-a', 'data-patient-id': e.c.patientId, 'data-clinic-id': e.c.clinicId };
  const sandbox = vm.createContext({
    URL, URLSearchParams, TextEncoder, AbortSignal, crypto: require('node:crypto').webcrypto,
    navigator: { locks: { request: async (name, options, fn) => fn() } },
    requirejs: (name) => { assert.equal(name, 'app'); return { view: { getVerboseData: () => data } }; },
    // window отсутствует: загрузка проверяет адаптер без монтирования UI.
    document: {
      cookie: 'other=ignored; csrftoken=csrf-secret',
      getElementById: (id) => ({ value: id.includes('expired') ? e.c.sessionExpires : e.c.session }),
      querySelector: (selector) => ({ getAttribute: () => selector.includes('DoctorFormView') ? e.c.listAction
        : selector.includes('SpecialityFormView') ? e.c.doctorsAction : e.c.bookingAction }),
    },
    DOMParser: class { parseFromString() { return { querySelectorAll: () => [{ getAttribute: (name) => attrs[name] }] }; } },
  });
  const bundle = fs.readFileSync(path.join(__dirname, '../dist/polarmed-slot-hunter.user.js'), 'utf8');
  vm.runInContext(bundle, sandbox);
  const h = sandbox.PolarmedCore.create({ platform: sandbox.PolarmedPlatform,
    storage: e.storage, fetch: e.fetch, now: () => e.clock,
    timer: { schedule(ms, fn) { this.callback = fn; }, cancel() {} } });
  await h.init();
  const [option] = await h.discover();
  assert.match(option.source.scope, /^[a-f0-9]{64}$/);
  assert.equal(option.title, e.c.doctorName);
  h.setTargets([sandbox.PolarmedCore.createUiState().buildTarget(option, {})]);
  const report = await h.dryRun();
  assert.ok(report.items[0].would);
  // Проверяем штатный browserVerify также на чужом пациенте.
  const runtime = sandbox.PolarmedPlatform.create({ storage: e.storage, fetch: e.fetch,
    now: () => e.clock, filters: createFilters(createUtil()) });
  const t = sandbox.PolarmedCore.createUiState().buildTarget(option, {});
  const candidate = (await runtime.targets.search(t, e.ctx())).candidates[0];
  attrs['data-patient-id'] = 'wrong-patient';
  const result = await runtime.targets.act(t, candidate, e.ctx());
  assert.equal(result.verified, false);
  assert.equal(result.action, 'stopTarget');
  assert.equal(e.requests.filter((request) => request.url === '/api/signup/').length, 1);
  await runtime.reviewAttempt();
  attrs['data-patient-id'] = e.c.patientId;
  const verified = await runtime.targets.act(t, candidate, e.ctx());
  assert.equal(verified.ok, true);
  assert.equal(verified.verified, true);
  data.doctor = null;
  await runtime.init();
  const [speciality] = await runtime.discover.list();
  assert.equal(speciality.source.anyDoctor, true);
});

test('Polarmed: плашка — явная кнопка, по клику без готового контекста открывается окно инструкции', async () => {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
    get firstChild() { return this.children[0]; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return (this.text || '') + this.children.map((node) => node.textContent).join(''); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    attachShadow() { this.shadowRoot = new Element('shadow'); return this.shadowRoot; }
  }
  const body = new Element('body');
  const sandbox = vm.createContext({
    document: { body, createElement: (tag) => new Element(tag),
      createTextNode: (text) => Object.assign(new Element('text'), { text }) },
    localStorage: { getItem: () => null }, fetch: async () => { throw new Error('Сеть не должна вызываться'); },
    navigator: { locks: {} }, crypto: require('node:crypto').webcrypto,
    URL, TextEncoder,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  });
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/polarmed-slot-hunter.user.js'), 'utf8'), sandbox);
  await new Promise(setImmediate);
  const root = body.children[0].shadowRoot.children[1];
  const badge = root.children.find((node) => node.tagName === 'button');
  assert.match(badge.textContent, /Охотник: открыть настройки/);
  assert.equal(badge.attributes['aria-label'], 'Открыть охотника за талонами');
  badge.listeners.click();
  await new Promise(setImmediate);
  const panel = root.children.find((node) => node.className === 'esh-card');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Конкретного врача выбирать не нужно/);
  const buttons = panel.children.flatMap((node) => node.children).filter((node) => node.tagName === 'button');
  assert.ok(buttons.some((node) => node.textContent === 'Проверить выбор и открыть настройки'));
  const check = buttons.find((node) => node.textContent === 'Проверить выбор и открыть настройки');
  const promise = check.listeners.click({ currentTarget: check });
  assert.equal(check.disabled, true);
  assert.equal(check.textContent, 'Проверяю выбор…');
  await promise;
  assert.match(panel.textContent, /Проверка №2 не пройдена/);
  assert.match(panel.textContent, /P_CONTEXT/);
  assert.equal(check.disabled, false);

  // Исправление выбора должно действительно открыть мастер, а не снова
  // показать инструкцию. Модуль доступен как app, но requirejs по-прежнему нет.
  sandbox.app = { view: { getVerboseData: () => ({
    clinic: { id: 'clinic-a', title: 'Поликлиника', data: { title: 'Поликлиника', address: 'Тестовая улица' } },
    speciality: { id: 'speciality-a', title: 'Терапевт' },
    preset: { additional: { patient_id: 'patient-a', history_id: 'history-a' } },
  }) } };
  sandbox.crypto = { subtle: { digest: async () => new Uint8Array(32).buffer } };
  sandbox.document.cookie = 'csrftoken=test-token';
  sandbox.document.getElementById = () => ({ value: 'session-field' });
  sandbox.document.querySelector = (selector) => ({ getAttribute: () => selector.includes('DoctorFormView')
    ? '/api/appointment_list/' : selector.includes('SpecialityFormView') ? '/api/doctor_list/' : '/api/signup/' });
  const retry = panel.children.flatMap((node) => node.children)
    .find((node) => node.tagName === 'button' && node.textContent === 'Проверить выбор и открыть настройки');
  await retry.listeners.click({ currentTarget: retry });
  await new Promise(setImmediate);
  assert.match(panel.textContent, /Шаг 1 из 3/);
  assert.match(panel.textContent, /Любой врач: Терапевт/);
});

test('Polarmed: доступ к app не зависит только от requirejs, незаполненный чужой шаг не ломает чтение', () => {
  const data = { clinic: { id: 'clinic-a' }, speciality: { id: 'speciality-a' }, preset: { additional: { patient_id: 'patient-a' } } };
  assert.equal(readSiteData({ app: { view: { getVerboseData: () => data } } }), data);
  assert.equal(readSiteData({ require: () => ({ view: { getVerboseData: () => data } }) }), data);
  const view = { getVerboseData: () => { throw new Error('Unselected time'); },
    forms: Object.entries(data).map(([key, value]) => ({ settings: { modelValueName: key },
      getVerboseData: () => ({ key, data: value }) })) };
  assert.deepEqual(readSiteData({ app: { view } }), data);
});

function domContextFixture() {
  const route = [{ clinic: 'clinic-a' }, { preset: 'chosen' }, { speciality: 'speciality-a' }];
  const preset = { first_name: 'private-name', additional: { patient_id: 'patient-a', history_id: 'history-a' } };
  const saved = { data: { chosen: preset, other: { additional: { patient_id: 'wrong-patient' } } }, expires: Date.now() + 60000 };
  const node = (id, text) => ({ textContent: text,
    getAttribute: (key) => key === 'data-id' ? id : key === 'data-address' ? 'Тестовая улица' : null,
    querySelector: () => ({ textContent: 'Поликлиника' }) });
  const fields = { 'id_clinic_form-clinic_id': 'clinic-a', 'id_speciality_form-speciality_id': 'speciality-a' };
  const e = {
    location: { hash: '#' + encodeURIComponent(JSON.stringify(route)) },
    localStorage: { getItem: (key) => { assert.equal(key, '__amplify__presets'); return JSON.stringify(saved); } },
    document: {
      getElementById: (id) => ({ value: fields[id] || '' }),
      querySelectorAll: (selector) => selector.includes('clinic_list') ? [node('clinic-a', 'Поликлиника')]
        : selector.includes('speciality_list') ? [node('speciality-a', 'Специальность')] : [],
    },
  };
  return { e, saved, fields, preset };
}

test('Polarmed: DOM+hash+Amplify восстанавливают только явно выбранного пациента, без requirejs', () => {
  const { e, preset } = domContextFixture();
  const data = readSiteData(e);
  assert.deepEqual(data.preset, preset);
  assert.equal(data.clinic.id, 'clinic-a');
  assert.equal(data.speciality.id, 'speciality-a');
  assert.equal(data.doctor, null);
});

test('Polarmed: резервное чтение не угадывает пациента при устаревших, недоступных или противоречивых данных', () => {
  for (const failure of ['expired', 'missing', 'route', 'transition', 'ambiguous']) {
    const { e, saved, fields } = domContextFixture();
    if (failure === 'expired') saved.expires = Date.now() - 1;
    if (failure === 'missing') delete saved.data.chosen;
    if (failure === 'route') e.location.hash = '#invalid';
    if (failure === 'transition') fields['id_clinic_form-clinic_id'] = 'different-clinic';
    if (failure === 'ambiguous') e.sessionStorage = { getItem: () => JSON.stringify({ data: { chosen: { additional: { patient_id: 'different-patient' } } } }) };
    assert.throws(() => readSiteData(e), /P_PATIENT|P_CONTEXT|P_TRANSITION|P_AMBIGUOUS/);
  }
});
