'use strict';

// 100% fictional data. Nothing here comes from, or is shared with, a real app.
const BAIT_NOTE_TEXT = 'ISCA-SENHA-NAO-PODE-SER-LIDA-7731';

function buildData() {
  const touched = { bait: 0 };
  const baitNote = (extra) => {
    const n = { ...extra };
    Object.defineProperty(n, 'text', {
      enumerable: true,
      get() { touched.bait++; return BAIT_NOTE_TEXT; },
    });
    return n;
  };
  return {
    touched,
    contacts: {
      people: [
        { id: 'p1', name: 'Ana Souza', emails: ['ana@example.com', 'ana.souza@trabalho.example'], phones: ['+55 11 90000-0001'], groups: ['g1'] },
        { id: 'p2', name: "José D'Ávila", emails: ['jose@example.com'], phones: [], groups: [] },
        { id: 'p3', name: 'Maria "Mimi" $Silva', emails: [], phones: ['(21) 98888-0002'], groups: ['g1'] },
        { id: 'p4', name: 'Linha\nQuebrada', emails: ['quebra@example.com'], phones: [], groups: [] },
        { id: 'p5', name: 'Zoë Müller', emails: ['zoe@example.com'], phones: ['+49 30 1234'], groups: ['g2'] },
      ],
      groups: ['g1', 'g2'],
    },
    reminders: {
      lists: [
        { id: 'L1', name: 'Casa', account_id: 'RA1', account_name: 'iCloud' },
        { id: 'L2', name: 'Casa', account_id: 'RA2', account_name: 'No meu Mac' },
        { id: 'L3', name: 'Trabalho', account_id: 'RA1', account_name: 'iCloud' },
      ],
      items: [
        { id: 'r1', title: 'Pagar conta de luz', list_id: 'L1', completed: false, due: '2026-10-05T12:00:00Z', allday_due: null, body: 'Vence dia 5.\nUsar o app do banco.' },
        { id: 'r2', title: 'Ligar para Ana', list_id: 'L1', completed: false, due: null, allday_due: null, body: null },
        { id: 'r3', title: 'Reunião às 00h', list_id: 'L3', completed: false, due: '2026-10-03T03:00:00Z', allday_due: null, body: null },
        { id: 'r4', title: 'Comprar $$ café ☕', list_id: 'L2', completed: true, due: '2026-10-01T15:00:00Z', allday_due: null, body: null },
        { id: 'r5', title: 'Dia inteiro', list_id: 'L3', completed: false, due: null, allday_due: '2026-10-04T03:00:00Z', body: null },
        { id: 'r6', title: 'Aspas "duplas" e \'simples\'\nsegunda linha', list_id: 'L2', completed: false, due: '2026-10-10T00:00:00Z', allday_due: null, body: 'x'.repeat(900) },
        { id: 'r7', title: 'Fim do intervalo', list_id: 'L1', completed: false, due: '2026-10-06T03:00:00Z', allday_due: null, body: null },
      ],
    },
    calendar: {
      calendars: [
        { id: 'C1', name: 'Pessoal', writable: true },
        { id: 'C2', name: 'Pessoal', writable: false },
        { id: 'C3', name: 'Trabalho', writable: true },
      ],
      events: [
        { id: 'e1', calendar_id: 'C1', title: 'Dentista', start: '2026-10-05T17:00:00Z', end: '2026-10-05T18:00:00Z', all_day: false, location: 'Clínica "Sorriso"', recurrence: '', description: 'Levar exames.\nAcesso pela rua $5.' },
        { id: 'e2', calendar_id: 'C2', title: 'Aniversário da Ana', start: '2026-10-06T03:00:00Z', end: '2026-10-07T03:00:00Z', all_day: true, location: null, recurrence: 'FREQ=YEARLY', description: null },
        { id: 'e3', calendar_id: 'C3', title: 'Reunião semanal', start: '2026-10-05T12:00:00Z', end: '2026-10-05T13:00:00Z', all_day: false, location: 'Sala 2', recurrence: 'FREQ=WEEKLY', description: null },
        { id: 'e4', calendar_id: 'C1', title: 'Viagem longa', start: '2026-10-01T00:00:00Z', end: '2026-10-10T00:00:00Z', all_day: false, location: null, recurrence: '', description: null },
        { id: 'e5', calendar_id: 'C3', title: 'Fora da janela', start: '2026-12-01T12:00:00Z', end: '2026-12-01T13:00:00Z', all_day: false, location: null, recurrence: '', description: null },
        { id: 'e7', calendar_id: 'C3', title: 'Reunião com convidados', start: '2026-10-08T14:00:00Z', end: '2026-10-08T15:00:00Z', all_day: false, location: null, recurrence: '', description: null, attendees: 2 },
        { id: 'e6', calendar_id: 'C1', title: 'Café $especial\nlinha2', start: '2026-10-07T12:00:00Z', end: '2026-10-07T13:00:00Z', all_day: false, location: 'Padaria', recurrence: '', description: null },
      ],
    },
    created: [],
    notes: {
      accounts: [{ id: 'NA1', name: 'iCloud' }, { id: 'NA2', name: 'No meu Mac' }],
      folders: [
        { id: 'F1', name: 'Pessoal', account_id: 'NA1', shared: false },
        { id: 'F2', name: 'Trabalho', account_id: 'NA1', shared: false },
        { id: 'F3', name: 'Pessoal', account_id: 'NA2', shared: false },
      ],
      items: [
        { id: 'n1', title: 'Lista de compras', folder_id: 'F1', protected: false, text: 'leite\npão\nCafé com $açúcar e "aspas"', modified: '2026-09-30T10:00:00Z', created: '2026-09-01T10:00:00Z', shared: false },
        baitNote({ id: 'n2', title: 'Ideias secretas', folder_id: 'F1', protected: true, modified: '2026-09-29T10:00:00Z', created: '2026-09-02T10:00:00Z', shared: false }),
        { id: 'n3', title: 'Reunião com Ana', folder_id: 'F2', protected: false, text: 'Pauta: orçamento 2026. Falar com Ana sobre o projeto novo.', modified: '2026-10-01T10:00:00Z', created: '2026-09-03T10:00:00Z', shared: false },
        { id: 'n4', title: 'Receita', folder_id: 'F3', protected: false, text: 'bolo de cenoura', modified: '2026-08-01T10:00:00Z', created: '2026-08-01T10:00:00Z', shared: false },
        baitNote({ id: 'n5', title: 'Sem marcador', folder_id: 'F3', protected: null, modified: null, created: null, shared: null }),
        { id: 'n6', title: 'Nota longa', folder_id: 'F2', protected: false, text: `${'x'.repeat(3000)} alvo-final`, modified: '2026-10-02T10:00:00Z', created: '2026-10-02T10:00:00Z', shared: false },
      ],
    },
  };
}

function bulkContacts(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `Pessoa ${String(i).padStart(4, '0')}`, emails: [`p${i}@example.com`], phones: [], groups: [] }));
}

module.exports = { buildData, bulkContacts, BAIT_NOTE_TEXT };
