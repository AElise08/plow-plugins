// Notes (bundle id confirmed from Info.plist: com.apple.Notes).
// Read-only. Reads: account.id/name, folder.id/name/shared, note.id/name/
// modification date/creation date/shared/password protected, and note.plaintext
// ONLY when `password protected` is strictly false. The HTML `body`, attachments,
// the unlock command and any database are never used.
var BUNDLE = 'com.apple.Notes';
var TEXT_CAP = 50000;
var MAX_DEPTH = 8;

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function walk(coll, aid, aname, depth, seen, out) {
  if (depth > MAX_DEPTH) { return; }
  var refs;
  try { refs = coll(); } catch (e) { throw fatal(errno(e), 'app'); }
  for (var i = 0; i < refs.length; i++) {
    var id = String(req(refs[i], 'id', 'item'));
    if (cacheFind(seen, id) === undefined) {
      seen.push([id, true]);
      var un = [];
      out.push({
        ref: refs[i], id: id, name: str(rd(refs[i], 'name', un, 'name')),
        shared: bool(rd(refs[i], 'shared', un, 'shared')), aid: aid, aname: aname,
      });
      walk(refs[i].folders, aid, aname, depth + 1, seen, out);
    }
  }
}

// Accounts -> folders (nested too, de-duplicated by id) so every folder is
// known together with its account, without walking up through `container`.
function catalog(a) {
  var accounts;
  try { accounts = a.accounts(); } catch (e) { throw fatal(errno(e), 'app'); }
  var folders = [];
  var accountIds = [];
  var seen = [];
  for (var i = 0; i < accounts.length; i++) {
    var un = [];
    var aid = String(req(accounts[i], 'id', 'item'));
    var aname = str(rd(accounts[i], 'name', un, 'name'));
    accountIds.push(aid);
    walk(accounts[i].folders, aid, aname, 0, seen, folders);
  }
  return { folders: folders, accountIds: accountIds };
}

function folders(p) {
  var cat = catalog(app());
  var out = [];
  for (var i = 0; i < cat.folders.length; i++) {
    var f = cat.folders[i];
    out.push({ id: f.id, name: f.name, account_id: f.aid, account_name: f.aname, shared: f.shared });
  }
  return { folders: out };
}

function findFolder(list, id) {
  for (var i = 0; i < list.length; i++) { if (list[i].id === id) { return list[i]; } }
  return null;
}

// text is read only when protection is proven absent.
function readText(ref, prot, wanted, cap, un) {
  if (!wanted || prot !== false) { return { text: null, length: null }; }
  var t = str(rd(ref, 'plaintext', un, 'text'));
  if (t === null) { return { text: null, length: null }; }
  return { text: t.length > cap ? t.slice(0, cap) : t, length: t.length };
}

function scan(p) {
  var a = app();
  var cat = catalog(a);
  var scoped = cat.folders;
  if (p.folder_id) {
    var f = findFolder(cat.folders, p.folder_id);
    if (f === null) { throw fatal(-1728, 'scope'); }
    scoped = [f];
  } else if (p.account_id) {
    if (cat.accountIds.indexOf(p.account_id) === -1) { throw fatal(-1728, 'scope'); }
    scoped = cat.folders.filter(function (x) { return x.aid === p.account_id; });
  }
  var deadline = Date.now() + p.soft_deadline_ms;
  var entries = [];
  var stopped = null;
  for (var i = 0; i < scoped.length; i++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    var refs;
    try { refs = scoped[i].ref.notes(); } catch (e) { throw fatal(errno(e), 'app'); }
    for (var k = 0; k < refs.length; k++) { entries.push({ ref: refs[k], f: scoped[i] }); }
  }
  var total = entries.length;
  var n = Math.min(total, p.scan_limit);
  var records = [];
  for (var m = 0; m < n; m++) {
    if (pastDeadline(deadline)) { stopped = 'time'; break; }
    var un = [];
    var ref = entries[m].ref;
    var id = String(req(ref, 'id', 'item'));
    var title = str(rd(ref, 'name', un, 'title'));
    var prot = bool(rd(ref, 'passwordProtected', un, 'protected'));
    var modified = iso(rd(ref, 'modificationDate', un, 'modified'));
    var t = readText(ref, prot, p.with_text, TEXT_CAP, un);
    records.push({
      id: id, title: title, folder_id: entries[m].f.id, folder_name: entries[m].f.name,
      account_id: entries[m].f.aid, account_name: entries[m].f.aname, modified: modified,
      protected: prot, text: t.text, text_length: t.length, unavailable: un,
    });
  }
  return { total: total, scanned: records.length, stopped: stopped, records: records };
}

function show(p) {
  var a = app();
  var ref = a.notes.byId(p.id);
  var un = [];
  var id = String(req(ref, 'id', 'item'));
  var fid = null;
  var fname = null;
  var aid = null;
  var aname = null;
  if (p.read_folder) {
    try {
      var c = ref.container();
      fid = String(c.id());
      fname = str(c.name());
      var f = findFolder(catalog(a).folders, fid);
      if (f !== null) { aid = f.aid; aname = f.aname; }
    } catch (e) {
      var n = errno(e);
      if (isHard(n)) { throw fatal(n, 'item'); }
      un.push('folder');
    }
  }
  var title = str(rd(ref, 'name', un, 'title'));
  var prot = bool(rd(ref, 'passwordProtected', un, 'protected'));
  var t = readText(ref, prot, p.read_text, p.text_cap, un);
  return {
    record: {
      id: id, title: title, folder_id: fid, folder_name: fname, account_id: aid, account_name: aname,
      modified: iso(rd(ref, 'modificationDate', un, 'modified')), protected: prot,
      text: t.text, text_length: t.length,
      created: iso(rd(ref, 'creationDate', un, 'created')), shared: bool(rd(ref, 'shared', un, 'shared')),
      unavailable: un,
    },
  };
}

function run(argv) { return entry(argv, { folders: folders, scan: scan, show: show }); }
