// Read-only helpers shared by the Calendar read script and the Calendar write
// script (concatenated after the prelude by src/adapters/jxa.js). Getters only.
// `calendarIdentifier` is declared as text in the dictionary but did not convert on
// the tested Mac, so the id is also derived from the specifier's own reference
// form (calendars.byId("...")), which was observed to work.
function calendarId(ref) {
  try {
    var direct = ref.calendarIdentifier();
    if (typeof direct === 'string' && direct.length > 0) { return direct; }
  } catch (e) {
    var n = errno(e);
    if (isHard(n)) { throw fatal(n, 'item'); }
  }
  var m = /\.calendars\.byId\("([^"\\]+)"\)$/.exec(String(Automation.getDisplayString(ref)));
  if (m) { return m[1]; }
  throw fatal(null, 'item');
}

function allCalendars(a) {
  var refs;
  try { refs = a.calendars(); } catch (e) { throw fatal(errno(e), 'app'); }
  var out = [];
  for (var i = 0; i < refs.length; i++) {
    var un = [];
    out.push({
      ref: refs[i],
      id: calendarId(refs[i]),
      name: str(rd(refs[i], 'name', un, 'name')),
      writable: bool(rd(refs[i], 'writable', un, 'writable')),
    });
  }
  return out;
}

// A missing value (no repeat rule) is "not recurring"; only a failed read is unknown.
function isRecurring(text, unavailable) {
  if (unavailable) { return null; }
  return text !== null && text.length > 0;
}

function event(ref, cal, un, withDescription) {
  return {
    id: String(req(ref, 'uid', 'item')),
    title: str(rd(ref, 'summary', un, 'title')),
    calendar_id: cal.id,
    calendar_name: cal.name,
    location: str(rd(ref, 'location', un, 'location')),
    start: iso(rd(ref, 'startDate', un, 'start')),
    end: iso(rd(ref, 'endDate', un, 'end')),
    all_day: bool(rd(ref, 'alldayEvent', un, 'all_day')),
    recurring: isRecurring(str(rd(ref, 'recurrence', un, 'recurring')), un.indexOf('recurring') !== -1),
    description: withDescription ? str(rd(ref, 'description', un, 'description')) : undefined,
    unavailable: un,
  };
}

