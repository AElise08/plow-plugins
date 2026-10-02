// WRITE script for Notes. Two modes, one mutation each:
//   create  - exactly one new note from HTML the caller already escaped
//             (the single `.notes.push(` below); no existing note is read
//   destroy - exactly one existing note by id, only if it is provably NOT password
//             protected and its title matches; its text is never read
// Nothing is edited, moved or unlocked. Bundle id confirmed from Info.plist.
var BUNDLE = 'com.apple.Notes';

function app() {
  try { return Application(BUNDLE); } catch (e) { throw fatal(errno(e), 'app'); }
}

function create(p) {
  var a = app();
  var account = p.folder_id ? null : req(a, 'defaultAccount', 'scope');
  var folder = p.folder_id ? a.folders.byId(p.folder_id) : req(account, 'defaultFolder', 'scope');
  var folderId = String(req(folder, 'id', 'scope'));
  var un = [];
  var folderName = str(rd(folder, 'name', un, 'folder'));
  var accountId = account === null ? null : String(req(account, 'id', 'scope'));
  var accountName = account === null ? null : str(rd(account, 'name', un, 'account'));
  var made = a.Note({ body: p.html });
  folder.notes.push(made);
  try {
    var after = [];
    return {
      record: {
        id: String(req(made, 'id', 'post')),
        title: str(rd(made, 'name', after, 'title')),
        folder_id: folderId,
        folder_name: folderName,
        account_id: accountId,
        account_name: accountName,
        modified: iso(rd(made, 'modificationDate', after, 'modified')),
        protected: bool(rd(made, 'passwordProtected', after, 'protected')),
        text: null,
        text_length: null,
        created: iso(rd(made, 'creationDate', after, 'created')),
        shared: bool(rd(made, 'shared', after, 'shared')),
        unavailable: after,
      },
    };
  } catch (e) {
    throw fatal(e && e.fatal === true ? e.number : errno(e), 'post');
  }
}

function destroy(p) {
  var a = app();
  var ref = a.notes.byId(p.id);
  var id = String(req(ref, 'id', 'item'));
  var un = [];
  var prot = bool(rd(ref, 'passwordProtected', un, 'protected'));
  if (prot === null) { throw refuse('protection_unknown'); }
  if (prot === true) { throw refuse('protected_note'); }
  var title = str(rd(ref, 'name', un, 'title'));
  if (title === null) { throw refuse('title_unreadable'); }
  if (!titleMatches(title, p.expect_title)) { throw refuse('title_mismatch'); }
  a.delete(ref);
  var gone = isGone(ref);
  var where = null;
  if (!gone) {
    // Notes keeps deleted notes in a trash folder; say where the note ended up.
    try { where = str(ref.container().name()); } catch (e) { where = null; }
  }
  return { id: id, title: title, verified_gone: gone, remaining_folder: where };
}

function run(argv) { return entry(argv, { create: create, delete: destroy }); }
