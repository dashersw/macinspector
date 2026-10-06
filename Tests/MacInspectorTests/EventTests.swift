// SPDX-License-Identifier: MIT
import AppKit
import XCTest

@testable import MacInspector

private final class ActionTarget: NSObject {
  var calls = 0
  @objc func activate(_ sender: Any?) { calls += 1 }
}

final class EventTests: XCTestCase {
  func testControlMenuAndGestureHandlersAreReadOnlyAndFollowLiveTargets() throws {
    _ = NSApplication.shared
    let target = ActionTarget()
    let button = NSButton(title: "Run", target: target, action: #selector(ActionTarget.activate))
    let control = NativeEvents.listeners(button)
    XCTAssertEqual(control.count, 1)
    XCTAssertEqual(control[0]["type"] as? String, "action")
    XCTAssertEqual(control[0]["selector"] as? String, "activate:")
    XCTAssertEqual(control[0]["dispatch"] as? String, "explicit target")
    XCTAssertTrue((control[0]["target"] as! String).hasSuffix("ActionTarget"))
    XCTAssertNotNil(UInt((control[0]["address"] as! String).dropFirst(2), radix: 16))
    button.isEnabled = false
    XCTAssertEqual(NativeEvents.listeners(button)[0]["enabled"] as? Bool, false)
    button.action = nil
    XCTAssertTrue(NativeEvents.listeners(button).isEmpty)

    let menu = NSMenuItem(title: "Run", action: #selector(ActionTarget.activate), keyEquivalent: "")
    menu.target = target
    XCTAssertEqual(NativeEvents.listeners(menu)[0]["kind"] as? String, "menu item")
    XCTAssertTrue(NativeEvents.listeners(NSMenuItem.separator()).isEmpty)

    let view = NSView()
    let gesture = NSClickGestureRecognizer(target: target, action: #selector(ActionTarget.activate))
    view.addGestureRecognizer(gesture)
    XCTAssertEqual(NativeEvents.listeners(view)[0]["type"] as? String, "NSClickGestureRecognizer")
    gesture.isEnabled = false
    XCTAssertEqual(NativeEvents.listeners(view)[0]["enabled"] as? Bool, false)
    view.removeGestureRecognizer(gesture)
    XCTAssertTrue(NativeEvents.listeners(view).isEmpty)
    XCTAssertEqual(target.calls, 0, "Inspecting registrations must never execute a handler")
  }

  func testSDKAdvertisesEventsAndRejectsDetachedNodes() throws {
    let (window, button, inspector, node) = InspectorTests().fixture()
    defer {
      inspector.stop()
      window.close()
    }
    let target = ActionTarget()
    button.target = target
    button.action = #selector(ActionTarget.activate)
    XCTAssertTrue((inspector.snapshot()["capabilities"] as! [String]).contains("event-listeners"))
    let result = try inspector.handle("event-listeners", ["node": node])
    let listeners = result["listeners"] as! [[String: Any]]
    XCTAssertEqual(listeners.filter { $0["selector"] as? String == "activate:" }.count, 1)
    button.removeFromSuperview()
    XCTAssertThrowsError(try inspector.handle("event-listeners", ["node": node]))
    XCTAssertEqual(target.calls, 0)
  }
}
