// Contacts (bundle id confirmed from Info.plist: com.apple.AddressBook).
// Read-only. Reads: person.id, person.name, person.emails.value, person.phones.value.
// Notes, birthday, addresses and photo are intentionally never touched.
var BUNDLE = 'com.apple.AddressBook';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function values(owner, elementName, un, key) {
  try {
    var arr = owner[elementName].value();
    var out = [];
    for (var i = 0; i < arr.length; i++) { if (typeof arr[i] === 'string') { out.push(arr[i]); } }
    return out;
  } catch (e) {
    var n = errno(e);
    if (isHard(n)) { throw fatal(n, 'item'); }
    un.push(key);
    return null;
  }
}

function person(ref) {
  var un = [];
  var id = String(req(ref, 'id', 'item'));
  var name = str(rd(ref, 'name', un, 'name'));
  var emails = values(ref, 'emails', un, 'emails');
  var phones = values(ref, 'phones', un, 'phones');
  return { id: id, name: name, emails: emails, phones: phones, unavailable: un };
}

function scan(p) {
  var a = app();
  var scope = p.group_id ? a.groups.byId(p.group_id).people : a.people;
  var refs;
  try { refs = scope(); } catch (e) { throw fatal(errno(e), 'scope'); }
  var total = refs.length;
  var n = Math.min(total, p.scan_limit);
  var deadline = Date.now() + p.soft_deadline_ms;
  var records = [];
  var stopped = null;
  for (var i = 0; i < n; i++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    records.push(person(refs[i]));
  }
  return { total: total, scanned: records.length, stopped: stopped, records: records };
}

function show(p) {
  var a = app();
  return { record: person(a.people.byId(p.id)) };
}

function run(argv) { return entry(argv, { scan: scan, show: show }); }
