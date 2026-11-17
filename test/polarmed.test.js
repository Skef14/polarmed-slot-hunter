const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { parseSlots, parseDoctors, bookingFields, sameOriginAction, inspectPage } = require('../adapters/polarmed');

const day = '2030-05-20';
const ticket = (id, start = '10:00', end = '10:15') => ({
  id, date_start: { iso: day + 'T' + start + ':00', time: start },
  date_end: { iso: day + 'T' + end + ':00', time: end },
});
const response = (entries) => ({ success: true, response: { [day]: entries } });

test('Polarmed: талоны сгруппированы по дню, сортируются по времени UTC+3', () => {
  const slots = parseSlots(response([ticket('later', '12:00', '12:15'), ticket('early')]));
  assert.deepEqual(slots.map((slot) => slot.id), ['early', 'later']);
  assert.equal(slots[0].startTime, day + 'T10:00:00+03:00');
});

test('Polarmed: deny пропускается, одинаковые талоны не дублируются', () => {
  assert.equal(parseSlots(response([ticket('one'), ticket('one'), { deny: true }])).length, 1);
  assert.throws(() => parseSlots(response([ticket('one'), ticket('one', '12:00', '12:15')])));
});

test('Polarmed: общее расписание нельзя принять за свободные талоны', () => {
  assert.throws(() => parseSlots({ success: true, response: [[ticket('one')]] }), /общее расписание/);
  assert.throws(() => parseSlots({ success: true, response: [] }));
  assert.deepEqual(parseSlots({ success: true, response: {} }), []);
});

test('Polarmed: ошибки и незнакомая структура не маскируются пустым расписанием', () => {
  for (const value of [null, {}, { success: false }, { success: true },
    { success: true, response: { [day]: {} } }, response([{}]), response([null])]) {
    assert.throws(() => parseSlots(value));
  }
  assert.throws(() => parseSlots({ success: false, error: { ErrorDescription: 'PRIVATE-DETAIL' } }),
    (error) => !error.message.includes('PRIVATE-DETAIL'));
});

test('Polarmed: неизвестные даты, разные дни, часовые пояса и нулевые интервалы отклоняются', () => {
  for (const change of [
    { date_start: { iso: 'not-a-date' } },
    { date_start: { iso: '2030-05-21T10:00:00' } },
    { date_start: { iso: day + 'T10:00:00Z', time: '10:00' } },
    { date_end: { iso: day + 'T10:00:00', time: '10:00' } },
    { id: NaN },
  ]) assert.throws(() => parseSlots(response([{ ...ticket('one'), ...change }])));
  const invalidDay = '2030-02-31';
  assert.throws(() => parseSlots({ success: true, response: {
    [invalidDay]: [{ id: 'bad', date_start: { iso: invalidDay + 'T10:00:00' }, date_end: { iso: invalidDay + 'T10:15:00' } }],
  } }));
});

test('Polarmed: явное UTC-время принимается только при совпадении с местным временем', () => {
  const entry = ticket('one');
  entry.date_start.iso = day + 'T07:00:00Z';
  entry.date_end.iso = day + 'T07:15:00Z';
  assert.equal(parseSlots(response([entry]))[0].startTime, day + 'T07:00:00Z');
});

test('Polarmed: врач определяется по IdDoc, счётчик не считается талоном', () => {
  assert.deepEqual(parseDoctors({ success: true, response: [{ IdDoc: 'doc-a', Name: 'Врач', CountFreeParticipantIE: 3 }] }),
    [{ id: 'doc-a', name: 'Врач', freeCount: 3 }]);
  assert.throws(() => parseDoctors({ success: true, response: {} }));
  assert.throws(() => parseDoctors({ success: true, response: [{ Name: 'Врач' }] }));
});

test('Polarmed: поля подтверждения повторяют collectData(), без посторонних данных', () => {
  const fields = bookingFields({ clinicId: 'clinic-a', historyId: 'history-a', patientId: 'patient-a',
    appointmentId: 'ticket-a', session: 'session-a', sessionExpires: 'expiry-a', csrf: 'csrf-a', unexpected: 'ignored' });
  assert.equal(fields['appointment_form-appointment_id'], 'ticket-a');
  assert.equal(fields['appointment_form-referal_id'], '');
  assert.equal(fields.csrfmiddlewaretoken, 'csrf-a');
  assert.equal(Object.keys(fields).length, 8);
  assert.throws(() => bookingFields({}));
});

test('Polarmed: история обращения необязательна, но идентификатор пациента и токены обязательны', () => {
  const base = { clinicId: 'clinic-a', patientId: 'patient-a', appointmentId: 'ticket-a',
    session: 'session-a', sessionExpires: 'expiry-a', csrf: 'csrf-a' };
  for (const historyId of [undefined, null, '', '   ']) {
    assert.equal(bookingFields({ ...base, historyId })['appointment_form-history_id'], '');
  }
  assert.equal(bookingFields({ ...base, historyId: 'history-a' })['appointment_form-history_id'], 'history-a');
  assert.equal(bookingFields({ ...base, historyId: 0 })['appointment_form-history_id'], '0');
  assert.throws(() => bookingFields({ ...base, historyId: {} }));
  for (const key of ['clinicId', 'patientId', 'appointmentId', 'session', 'sessionExpires', 'csrf']) {
    assert.throws(() => bookingFields({ ...base, [key]: undefined }));
  }
});

test('Polarmed: действия допускаются только на исходном HTTPS-сайте', () => {
  assert.equal(sameOriginAction('/some-form/'), '/some-form/');
  for (const action of ['https://example.org/api/', '//example.org/', 'http://reg.polarmed.ru/',
    'https://user:pass@reg.polarmed.ru/', 'javascript:alert(1)', '/api/#fragment']) {
    assert.throws(() => sameOriginAction(action));
  }
});

function fakePage() {
  const field = (name) => ({
    getAttribute(key) { assert.equal(key, 'name'); return name; },
    get value() { throw new Error('Нельзя читать значения полей'); },
  });
  const container = { getAttribute(key) { assert.equal(key, 'data-view'); return 'SingUpValidateFormView'; } };
  const form = {
    closest(selector) { assert.equal(selector, '[data-view]'); return container; },
    getAttribute(key) { return { action: '/api/confirm/?token=SECRET', method: 'post' }[key]; },
    querySelectorAll() { return [field('appointment_form-patient_id'), field('csrfmiddlewaretoken'), field('patient_123')]; },
  };
  return {
    get cookie() { throw new Error('Нельзя читать cookies'); },
    get body() { throw new Error('Нельзя читать текст страницы'); },
    querySelectorAll(selector) {
      if (selector === 'form') return [form];
      if (selector === 'a[href]') return [
        { getAttribute() { return '/signup/shift/123/?patient=PRIVATE'; } },
        { getAttribute() { return '/signup/shift/456/?token=SECRET'; } },
        { getAttribute() { return '/login/esia/'; } },
      ];
      if (selector === '[data-view]') return [container];
      if (selector === 'script[src]') return [
        { getAttribute() { return '/static/js/app/singup-built.js?secret=PRIVATE'; } },
        { getAttribute() { return 'https://external.example/tracker.js?private=SECRET'; } },
      ];
      throw new Error('Неожиданный селектор');
    },
  };
}

test('Polarmed: сборщик экспортирует схему, не читая значений, cookies и текста', () => {
  const report = inspectPage(fakePage(), '/profile/123/?patient=SECRET#PRIVATE');
  assert.equal(report.page, '/profile/[value]/');
  assert.equal(report.forms[0].action, '/api/confirm/');
  assert.equal(report.forms[0].method, 'POST');
  assert.deepEqual(report.forms[0].fields, ['appointment_form-patient_id', 'csrfmiddlewaretoken', '[nonstandard-name]']);
  assert.deepEqual(report.scripts, ['/static/js/app/singup-built.js', '[external]']);
  assert.deepEqual(report.links, ['/signup/shift/[value]/']);
  const text = JSON.stringify(report);
  assert.ok(!/SECRET|PRIVATE|123/.test(text));
});

test('Polarmed: сборка инспектора отдельная, без зависимостей от файлов пользователя', () => {
  const root = path.join(__dirname, '..');
  execFileSync(process.execPath, ['scripts/build-inspector.js'], { cwd: root });
  const output = fs.readFileSync(path.join(root, 'dist/polarmed-site-inspector.user.js'), 'utf8');
  assert.ok(output.startsWith('// ==UserScript=='));
  assert.match(output, /@match\s+https:\/\/reg\.polarmed\.ru\/\*/);
  assert.doesNotMatch(output, /@(?:updateURL|downloadURL)/);
  assert.doesNotMatch(output, /fetch\s*\(|XMLHttpRequest|data-site\//);
  new vm.Script(output);
});
