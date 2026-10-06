// SPDX-License-Identifier: MIT
#if canImport(UIKit)
  import UIKit
  import ObjectiveC

  enum NativeEvents {
    static func listeners(_ object: NSObject) -> [[String: Any]] {
      guard let control = object as? UIControl else { return [] }
      let events: [(UIControl.Event, String)] = [
        (.touchDown, "touchDown"), (.touchDownRepeat, "touchDownRepeat"),
        (.touchDragInside, "touchDragInside"), (.touchDragOutside, "touchDragOutside"),
        (.touchDragEnter, "touchDragEnter"), (.touchDragExit, "touchDragExit"),
        (.touchUpInside, "touchUpInside"), (.touchUpOutside, "touchUpOutside"),
        (.touchCancel, "touchCancel"), (.valueChanged, "valueChanged"),
        (.primaryActionTriggered, "primaryActionTriggered"), (.editingDidBegin, "editingDidBegin"),
        (.editingChanged, "editingChanged"), (.editingDidEnd, "editingDidEnd"),
        (.editingDidEndOnExit, "editingDidEndOnExit"),
      ]
      var result: [[String: Any]] = []
      for target in control.allTargets.prefix(128) {
        let explicit = (target.base as? NSObject).flatMap { $0 is NSNull ? nil : $0 }
        for (event, name) in events where control.allControlEvents.contains(event) {
          for action in control.actions(forTarget: explicit, forControlEvent: event) ?? [] {
            let selector = NSSelectorFromString(action)
            let resolved =
              explicit ?? control.target(forAction: selector, withSender: control) as? NSObject
            var item: [String: Any] = [
              "type": name, "kind": "control", "selector": action,
              "target": resolved.map { NSStringFromClass(type(of: $0)) } ?? "Unresolved responder",
              "dispatch": explicit == nil ? "responder chain" : "explicit target",
              "enabled": control.isEnabled,
            ]
            if let resolved, let method = class_getInstanceMethod(type(of: resolved), selector) {
              item["address"] =
                "0x"
                + String(unsafeBitCast(method_getImplementation(method), to: UInt.self), radix: 16)
            }
            result.append(item)
          }
        }
      }
      return result
    }
  }
#endif
