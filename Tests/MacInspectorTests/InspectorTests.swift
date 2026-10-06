import AppKit
// SPDX-License-Identifier: MIT
import XCTest

@testable import MacInspector

private final class FlippedRoot: NSView { override var isFlipped: Bool { true } }

final class InspectorTests: XCTestCase {
  func testTextContentAndInputValues() throws {
    let (window, _, inspector, _) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    let label = NSTextField(labelWithString: "Read-only label")
    label.identifier = .init("label")
    let input = NSTextField(string: "Input value")
    input.identifier = .init("input")
    let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 180, height: 80))
    text.identifier = .init("editor")
    text.string = "First line\nSecond line"
    for view in [label, input, text] as [NSView] { window.contentView!.addSubview(view) }
    func snapshot(_ identifier: String) -> [String: Any] {
      (inspector.snapshot()["nodes"] as! [[String: Any]]).first {
        ($0["attributes"] as? [String: String])?["id"] == identifier
      }!
    }
    XCTAssertEqual(snapshot("label")["textMode"] as? String, "content")
    XCTAssertEqual(snapshot("input")["textMode"] as? String, "value")
    let editor = snapshot("editor")
    let id = editor["id"] as! Int
    XCTAssertEqual(editor["textMode"] as? String, "content")
    XCTAssertEqual(editor["text"] as? String, "First line\nSecond line")
    let original = try inspector.handle("attribute-state", ["node": id, "key": "text"])
    XCTAssertEqual(original["key"] as? String, "text")
    _ = try inspector.handle("attribute", ["node": id, "key": "text", "value": "Edited\ntext"])
    XCTAssertEqual(text.string, "Edited\ntext")
    XCTAssertEqual(snapshot("editor")["text"] as? String, text.string)
    _ = try inspector.handle(
      "attribute", ["node": id, "key": "text", "value": original["value"] as! String])
    XCTAssertEqual(text.string, "First line\nSecond line")
  }
  func fixture(flipped: Bool = false) -> (NSWindow, NSButton, NativeInspector, Int) {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 220), styleMask: [.titled],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    if flipped {
      window.contentView = FlippedRoot(frame: NSRect(x: 0, y: 0, width: 300, height: 220))
    }
    let button = NSButton(frame: NSRect(x: 40, y: 40, width: 140, height: 40))
    button.title = "Actual AppKit"
    button.identifier = .init("test-button")
    window.contentView!.addSubview(button)
    window.orderFront(nil)
    let inspector = NativeInspector(window: window)
    let nodes = inspector.snapshot()["nodes"] as! [[String: Any]]
    let id =
      nodes.first { ($0["attributes"] as? [String: String])?["id"] == "test-button" }!["id"] as! Int
    return (window, button, inspector, id)
  }
  func testNativeStylesResetAndStaleIdentity() throws {
    let (window, button, inspector, id) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    _ = try inspector.handle("style", ["node": id, "key": "opacity", "value": "0.4"])
    XCTAssertEqual(button.alphaValue, 0.4, accuracy: 0.001)
    _ = try inspector.handle("style", ["node": id, "key": "opacity", "reset": true])
    XCTAssertEqual(button.alphaValue, 1)
    XCTAssertThrowsError(
      try inspector.handle(
        "styles",
        [
          "node": id,
          "operations": [
            ["key": "opacity", "value": "0.3"], ["key": "font-size", "value": "invalid"],
          ],
        ]))
    XCTAssertEqual(button.alphaValue, 1, "A rejected declaration must roll back the whole edit")
    _ = try inspector.handle("style", ["node": id, "key": "background", "value": "#ff0000"])
    XCTAssertEqual(
      NSColor(cgColor: button.layer!.backgroundColor!)!.usingColorSpace(.deviceRGB)!.redComponent, 1
    )
    XCTAssertThrowsError(
      try inspector.handle("style", ["node": id, "key": "opacity", "value": "NaN"]))
    XCTAssertEqual(button.alphaValue, 1)
    button.removeFromSuperview()
    XCTAssertThrowsError(
      try inspector.handle("style", ["node": id, "key": "opacity", "value": "0.5"]))
    let replacement = NSButton(frame: button.frame)
    window.contentView!.addSubview(replacement)
    let ids = (inspector.snapshot()["nodes"] as! [[String: Any]]).map { $0["id"] as! Int }
    XCTAssertFalse(ids.contains(id))
  }
  func testPickerConsumesWholeGestureAndRestoresInput() throws {
    let (window, _, inspector, id) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    window.acceptsMouseMovedEvents = false
    var events: [(String, [String: Any])] = []
    inspector.emit = { events.append(($0, $1)) }
    func mouse(_ type: NSEvent.EventType) -> NSEvent {
      NSEvent.mouseEvent(
        with: type, location: NSPoint(x: 80, y: 60), modifierFlags: [], timestamp: 0,
        windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
    }
    inspector.beginInspection(owner: "first")
    XCTAssertTrue(window.acceptsMouseMovedEvents)
    XCTAssertNil(inspector.handleEvent(mouse(.leftMouseDown)))
    XCTAssertEqual(events.last?.0, "picked")
    XCTAssertEqual(events.last?.1["node"] as? Int, id)
    XCTAssertNil(inspector.handleEvent(mouse(.leftMouseDragged)))
    inspector.cancelInspection()
    XCTAssertNil(inspector.handleEvent(mouse(.leftMouseUp)))
    XCTAssertFalse(window.acceptsMouseMovedEvents)
    XCTAssertNotNil(inspector.handleEvent(mouse(.leftMouseDown)))
    inspector.beginInspection(owner: "second")
    let escape = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, characters: "\u{1b}",
      charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
    XCTAssertNil(inspector.handleEvent(escape))
    XCTAssertEqual(events.last?.0, "inspectCanceled")
    XCTAssertFalse(window.acceptsMouseMovedEvents)
  }
  func testFlippedContentViewUsesWindowCoordinatesForHitTesting() throws {
    let (window, _, inspector, id) = fixture(flipped: true)
    defer {
      inspector.stop()
      window.close()
    }
    let located = try inspector.handle("locate", ["x": 80.0, "y": 60.0])
    XCTAssertEqual(located["node"] as? Int, id)
    var picked = 0
    inspector.emit = { method, params in
      if method == "picked" { picked = params["node"] as? Int ?? 0 }
    }
    inspector.beginInspection(owner: "flipped")
    let location = window.contentView!.convert(NSPoint(x: 80, y: 60), to: nil)
    let event = NSEvent.mouseEvent(
      with: .leftMouseDown, location: location, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
    XCTAssertNil(inspector.handleEvent(event))
    XCTAssertEqual(picked, id)
    let release = NSEvent.mouseEvent(
      with: .leftMouseUp, location: location, modifierFlags: [], timestamp: 0,
      windowNumber: window.windowNumber, context: nil, eventNumber: 2, clickCount: 1, pressure: 0)!
    XCTAssertNil(inspector.handleEvent(release))
  }
}
