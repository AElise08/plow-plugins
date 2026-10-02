// Calendar (bundle id confirmed from Info.plist: com.apple.iCal; dictionary file iCal.sdef).
// Read-only. Reads: calendar id (see calendarId)/name/writable and event.uid/summary/
// start date/end date/allday event/location/recurrence, plus description only for
// `show`. Attendees, alarms, URLs and the `show`/`reload calendars` commands are never used.
var BUNDLE = 'com.apple.iCal';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function calendars(p) {
  var list = allCalendars(app());
  var out = [];
  for (var i = 0; i < list.length; i++) {
    out.push({ id: list[i].id, name: list[i].name, writable: list[i].writable });
  }
  return { calendars: out };
}

// Events overlapping [from, to). How Calendar reports recurring events through
// this filter is not assumed: the caller declares recurring occurrences as not expanded.
function scan(p) {
  var a = app();
  var cals = allCalendars(a);
  var scoped = cals;
  if (p.calendar_id) {
    scoped = cals.filter(function (c) { return c.id === p.calendar_id; });
    if (scoped.length === 0) { throw fatal(-1728, 'scope'); }
  }
  var from = new Date(p.from_iso);
  var to = new Date(p.to_iso);
  var deadline = Date.now() + p.soft_deadline_ms;
  var entries = [];
  var stopped = null;
  for (var i = 0; i < scoped.length; i++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    var coll = scoped[i].ref.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] });
    var refs;
    try { refs = coll(); } catch (e) { throw fatal(errno(e), 'app'); }
    for (var k = 0; k < refs.length; k++) { entries.push({ ref: refs[k], cal: scoped[i] }); }
  }
  var total = entries.length;
  var n = Math.min(total, p.scan_limit);
  var records = [];
  for (var m = 0; m < n; m++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    records.push(event(entries[m].ref, entries[m].cal, [], false));
  }
  return { total: total, scanned: records.length, stopped: stopped, records: records };
}

function show(p) {
  var a = app();
  var cals = allCalendars(a);
  for (var i = 0; i < cals.length; i++) {
    var ref = cals[i].ref.events.byId(p.id);
    var found = false;
    try { req(ref, 'uid', 'item'); found = true; } catch (e) {
      if (e && e.fatal === true && isHard(e.number)) { throw e; }
    }
    if (found) { return { record: event(ref, cals[i], [], true) }; }
  }
  throw fatal(-1728, 'item');
}

function run(argv) { return entry(argv, { calendars: calendars, scan: scan, show: show }); }
