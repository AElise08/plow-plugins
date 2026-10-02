// Reminders (bundle id confirmed from Info.plist: com.apple.reminders).
// Read-only. Reads: account.id/name, list.id/name, reminder.id/name/completed/
// due date/allday due date, and body only for `show`. Nothing is completed or edited.
var BUNDLE = 'com.apple.reminders';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function lists(p) {
  var a = app();
  var accounts;
  try { accounts = a.accounts(); } catch (e) { throw fatal(errno(e), 'app'); }
  var out = [];
  for (var i = 0; i < accounts.length; i++) {
    var un = [];
    var aid = String(req(accounts[i], 'id', 'item'));
    var aname = str(rd(accounts[i], 'name', un, 'account_name'));
    var refs;
    try { refs = accounts[i].lists(); } catch (e) { throw fatal(errno(e), 'app'); }
    for (var j = 0; j < refs.length; j++) {
      var lu = [];
      out.push({
        id: String(req(refs[j], 'id', 'item')),
        name: str(rd(refs[j], 'name', lu, 'name')),
        account_id: aid,
        account_name: aname,
      });
    }
  }
  return { lists: out };
}

function reminder(ref, listId, listName, un, withBody) {
  return {
    id: String(req(ref, 'id', 'item')),
    title: str(rd(ref, 'name', un, 'title')),
    list_id: listId,
    list_name: listName,
    completed: bool(rd(ref, 'completed', un, 'completed')),
    due: iso(rd(ref, 'dueDate', un, 'due')),
    allday_due: iso(rd(ref, 'alldayDueDate', un, 'allday_due')),
    body: withBody ? str(rd(ref, 'body', un, 'body')) : undefined,
    unavailable: un,
  };
}

function scan(p) {
  var a = app();
  var targets;
  if (p.list_id) {
    var one = a.lists.byId(p.list_id);
    req(one, 'id', 'scope');
    targets = [one];
  } else {
    try { targets = a.lists(); } catch (e) { throw fatal(errno(e), 'app'); }
  }
  var deadline = Date.now() + p.soft_deadline_ms;
  var entries = [];
  var stopped = null;
  for (var i = 0; i < targets.length; i++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    var lu = [];
    var lid = String(req(targets[i], 'id', 'item'));
    var lname = str(rd(targets[i], 'name', lu, 'list'));
    var coll = targets[i].reminders;
    if (p.status === 'pending') { coll = coll.whose({ completed: false }); }
    if (p.status === 'completed') { coll = coll.whose({ completed: true }); }
    var refs;
    try { refs = coll(); } catch (e) { throw fatal(errno(e), 'app'); }
    for (var k = 0; k < refs.length; k++) { entries.push({ ref: refs[k], lid: lid, lname: lname }); }
  }
  var total = entries.length;
  var n = Math.min(total, p.scan_limit);
  var records = [];
  for (var m = 0; m < n; m++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    var un = [];
    records.push(reminder(entries[m].ref, entries[m].lid, entries[m].lname, un, false));
  }
  return { total: total, scanned: records.length, stopped: stopped, records: records };
}

function show(p) {
  var a = app();
  var ref = a.reminders.byId(p.id);
  var un = [];
  var lid = null;
  var lname = null;
  if (p.read_container) {
    try {
      var c = ref.container();
      lid = String(c.id());
      lname = str(c.name());
    } catch (e) {
      var n = errno(e);
      if (isHard(n)) { throw fatal(n, 'item'); }
      un.push('list');
    }
  }
  return { record: reminder(ref, lid, lname, un, true) };
}

function run(argv) { return entry(argv, { lists: lists, scan: scan, show: show }); }
