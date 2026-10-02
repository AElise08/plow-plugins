import Foundation
import OSAKit

// Experiment: an osascript-like helper. usage: osa <JavaScript|AppleScript> <source> [args...]
// Compiles the source and calls its `run(argv)` handler with the remaining args, printing the result.
let a = CommandLine.arguments
guard a.count >= 3, let lang = OSALanguage(forName: a[1]) else { print("usage: osa <language> <source> [args]"); exit(2) }
let script = OSAScript(source: a[2], language: lang)
var err: NSDictionary?
if !script.compileAndReturnError(&err) { print("COMPILE ERR \((err?[OSAScriptErrorNumber] as? Int) ?? 0)"); exit(1) }
let args = Array(a.dropFirst(3))
let r = script.executeHandler(withName: "run", arguments: [args], error: &err)
if let e = err { print("ERR \((e[OSAScriptErrorNumber] as? Int) ?? (e["OSAScriptErrorNumber"] as? Int) ?? 0)"); exit(1) }
print(r?.stringValue ?? "")
