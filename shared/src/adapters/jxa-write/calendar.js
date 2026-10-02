// WRITE script for Calendar (bundle id confirmed from Info.plist: com.apple.iCal).
// Three modes; every one refuses read-only calendars, repeating events and events
// with attendees (changing those could affect other people or other occurrences):
//   create  - exactly one new event, no attendees (the single `.events.push(` below)
//   update  - set only the fields given, on one existing event, after an identity guard
//   destroy - delete one existing event by id, after an identity guard
// Guard refusals use fixed reason tokens; nothing is changed when a guard trips.
var BUNDLE = 'com.apple.iCal';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function locate(a, id) {
  var cals = allCalendars(a);
  for (var i = 0; i < cals.length; i++) {
    var ref = cals[i].ref.events.byId(id);
    var found = false;
    try { req(ref, 'uid', 'item'); found = true; } catch (e) {
      if (e && e.fatal === true && isHard(e.number)) { throw e; }
    }
    if (found) { return { ref: ref, cal: cals[i] }; }
  }
  throw fatal(-1728, 'item');
}

function guardExisting(found, expectTitle) {
  if (found.cal.writable !== true) { throw refuse('read_only_calendar'); }
  var un = [];
  var title = str(rd(found.ref, 'summary', un, 'title'));
  if (title === null) { throw refuse('title_unreadable'); }
  if (!titleMatches(title, expectTitle)) { throw refuse('title_mismatch'); }
  var rec = str(rd(found.ref, 'recurrence', un, 'recurring'));
  if (un.indexOf('recurring') !== -1 || (rec !== null && rec.length > 0)) { throw refuse('recurring_event'); }
  try {
    if (found.ref.attendees().length > 0) { throw refuse('has_attendees'); }
  } catch (e) {
    if (e && e.fatal === true) { throw e; }
    throw refuse('attendees_unknown');
  }
}

function create(p) {
  var a = app();
  var cals = allCalendars(a).filter(function (c) { return c.id === p.calendar_id; });
  if (cals.length === 0) { throw fatal(-1728, 'scope'); }
  var cal = cals[0];
  if (cal.writable !== true) { throw refuse('read_only_calendar'); }
  var props = Object.assign(
    { summary: p.title, startDate: new Date(p.start_iso), endDate: new Date(p.end_iso), alldayEvent: p.all_day },
    p.location === null ? {} : { location: p.location },
    p.description === null ? {} : { description: p.description }
  );
  var made = a.Event(props);
  cal.ref.events.push(made);
  try {
    return { record: event(made, cal, [], true) };
  } catch (e) {
    throw fatal(e && e.fatal === true ? e.number : errno(e), 'post');
  }
}

function update(p) {
  var a = app();
  var found = locate(a, p.id);
  guardExisting(found, p.expect_title);
  var ref = found.ref;
  var un = [];
  if (bool(rd(ref, 'alldayEvent', un, 'all_day')) === true && (p.start_iso !== null || p.end_iso !== null)) {
    throw refuse('all_day_time_change');
  }
  var changed = [];
  if (p.title !== null) { ref.summary = p.title; changed.push('title'); }
  if (p.location !== null) { ref.location = p.location; changed.push('location'); }
  if (p.description !== null) { ref.description = p.description; changed.push('description'); }
  var oldEnd = rd(ref, 'endDate', un, 'end');
  var movesLater = p.start_iso !== null && oldEnd instanceof Date && new Date(p.start_iso) >= oldEnd;
  if (movesLater && p.end_iso !== null) { ref.endDate = new Date(p.end_iso); changed.push('end'); }
  if (p.start_iso !== null) { ref.startDate = new Date(p.start_iso); changed.push('start'); }
  if (!movesLater && p.end_iso !== null) { ref.endDate = new Date(p.end_iso); changed.push('end'); }
  try {
    return { record: event(ref, found.cal, [], true), changed: changed };
  } catch (e) {
    throw fatal(e && e.fatal === true ? e.number : errno(e), 'post');
  }
}

function destroy(p) {
  var a = app();
  var found = locate(a, p.id);
  guardExisting(found, p.expect_title);
  var id = String(req(found.ref, 'uid', 'item'));
  var title = str(rd(found.ref, 'summary', [], 'title'));
  a.delete(found.ref);
  return { id: id, title: title, verified_gone: isGone(found.ref), remaining_folder: null };
}

function run(argv) { return entry(argv, { create: create, update: update, delete: destroy }); }
