// SPDX-License-Identifier: MIT
#if canImport(AppKit)
import AppKit
import ObjectiveC

enum NativeEvents {
  static func listeners(_ object: NSObject) -> [[String: Any]] {
    var result: [[String: Any]] = []
    func append(
      _ action: Selector?, target explicit: AnyObject?, sender: AnyObject,
      type: String, kind: String, enabled: Bool
    ) {
      guard let action else { return }
      let target = NSApp.target(forAction: action, to: explicit, from: sender) as? NSObject
      var item: [String: Any] = [
        "type": type, "kind": kind, "selector": NSStringFromSelector(action),
        "target": target.map { NSStringFromClass(Swift.type(of: $0)) } ?? "Unresolved responder",
        "dispatch": explicit == nil ? "responder chain" : "explicit target", "enabled": enabled,
      ]
      if let target, let method = class_getInstanceMethod(Swift.type(of: target), action) {
        let address = unsafeBitCast(method_getImplementation(method), to: UInt.self)
        item["address"] = "0x" + String(address, radix: 16)
      }
      result.append(item)
    }
    if let control = object as? NSControl {
      append(
        control.action, target: control.target as AnyObject?, sender: control,
        type: "action", kind: "control", enabled: control.isEnabled)
    } else if let item = object as? NSMenuItem, !item.isSeparatorItem {
      append(
        item.action, target: item.target as AnyObject?, sender: item,
        type: "action", kind: "menu item", enabled: item.isEnabled)
    }
    if let view = object as? NSView {
      for gesture in view.gestureRecognizers.prefix(128) {
        append(
          gesture.action, target: gesture.target as AnyObject?, sender: gesture,
          type: NSStringFromClass(Swift.type(of: gesture)), kind: "gesture",
          enabled: gesture.isEnabled)
      }
    }
    return result
  }
}
#endif
