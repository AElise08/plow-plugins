// WRITE script for Reminders. Two modes, one mutation each:
//   create  - exactly one new reminder (the single `.reminders.push(` below)
//   destroy - exactly one existing reminder by id, after an identity guard
// Nothing is edited, completed or moved. Bundle id confirmed from Info.plist.
// Read-back errors are tagged 'post' so the caller can say the outcome is unknown.
var BUNDLE = 'com.apple.reminders';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function dueProps(p) {
  if (p.due_kind === 'datetime') { return { dueDate: new Date(p.due_iso) }; }
  if (p.due_kind === 'day') { return { alldayDueDate: new Date(p.due_iso) }; }
  return {};
}

function create(p) {
  var a = app();
  var list = p.list_id ? a.lists.byId(p.list_id) : req(a, 'defaultList', 'scope');
  var listId = String(req(list, 'id', 'scope'));
  var un = [];
  var listName = str(rd(list, 'name', un, 'list'));
  var props = Object.assign({ name: p.title }, p.body === null ? {} : { body: p.body }, dueProps(p));
  var made = a.Reminder(props);
  list.reminders.push(made);
  try {
    var after = [];
    return {
      record: {
        id: String(req(made, 'id', 'post')),
        title: str(rd(made, 'name', after, 'title')),
        list_id: listId,
        list_name: listName,
        completed: bool(rd(made, 'completed', after, 'completed')),
        due: iso(rd(made, 'dueDate', after, 'due')),
        allday_due: iso(rd(made, 'alldayDueDate', after, 'allday_due')),
        body: str(rd(made, 'body', after, 'body')),
        unavailable: after,
      },
    };
  } catch (e) {
    throw fatal(e && e.fatal === true ? e.number : errno(e), 'post');
  }
}

function destroy(p) {
  var a = app();
  var ref = a.reminders.byId(p.id);
  var id = String(req(ref, 'id', 'item'));
  var un = [];
  var title = str(rd(ref, 'name', un, 'title'));
  if (title === null) { throw refuse('title_unreadable'); }
  if (!titleMatches(title, p.expect_title)) { throw refuse('title_mismatch'); }
  a.delete(ref);
  return { id: id, title: title, verified_gone: isGone(ref), remaining_folder: null };
}

function run(argv) { return entry(argv, { create: create, delete: destroy }); }
