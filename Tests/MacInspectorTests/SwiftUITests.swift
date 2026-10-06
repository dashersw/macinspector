// SPDX-License-Identifier: MIT
import AppKit
import SwiftUI
import XCTest

@testable import MacInspector

final class SwiftUITests: XCTestCase {
  func testOptionalDimensionSupportsIntrinsicSizeAndReset() throws {
    var width: CGFloat? = nil
    let binding = Binding(get: { width }, set: { width = $0 })
    let node = SwiftUIInspectionNode(
      id: "frame", tag: "SwiftUI.Rectangle", parent: nil,
      properties: [.dimension("width", binding)], action: nil)
    XCTAssertEqual(node.styles["width"], "auto")
    try node.apply([["key": "width", "value": "120px"]])
    XCTAssertEqual(width, 120)
    try node.apply([["key": "width", "value": "auto"]])
    XCTAssertNil(width)
    try node.apply([["key": "width", "reset": true]])
    XCTAssertNil(width)
  }

  func testReplacingTheRootProbeDoesNotDisconnectItsWindowAndOverridesRollback() throws {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let registry = SwiftUIInspectionRegistry()
    let old = NSView()
    let replacement = NSView()
    window.contentView!.addSubview(replacement)
    registry.connect(window, port: 0, probe: old)
    registry.connect(window, port: 0, probe: replacement)
    registry.connect(nil, port: 0, probe: old)
    XCTAssertTrue(SwiftUIInspectionRegistry.find(window) === registry)
    let model = Model()
    let node = SwiftUIInspectionNode(
      id: "tile", tag: "SwiftUI.Rectangle", parent: nil,
      properties: [.numberStyle("width", model.binding(\.width))], action: nil)
    node.probe = replacement
    registry.register(node)
    let inspector = NativeInspector(window: window)
    let document: [String: Any] = [
      "version": 1,
      "edits": [
        [
          "target": ["id": "tile", "tag": "SwiftUI.Rectangle"],
          "styles": [["name": "width", "value": "110px"]],
        ]
      ],
    ]
    try inspector.applyOverrides(JSONSerialization.data(withJSONObject: document))
    XCTAssertEqual(model.width, 110)
    var invalid = document
    invalid["edits"] = [
      [
        "target": ["id": "tile", "tag": "SwiftUI.Rectangle"],
        "styles": [["name": "width", "value": "150px"], ["name": "opacity", "value": "0.5"]],
      ]
    ]
    XCTAssertThrowsError(
      try inspector.applyOverrides(JSONSerialization.data(withJSONObject: invalid)))
    XCTAssertEqual(model.width, 110)
    registry.connect(nil, port: 0, probe: replacement)
    XCTAssertNil(SwiftUIInspectionRegistry.find(window))
    XCTAssertThrowsError(try inspector.object(inspector.id(node)))
  }

  private final class Model {
    var width = 72.0
    var radius = 14.0
    var color = Color.blue
    var title = "Original"
    var enabled = true
    var choice = "Berlin"
    var count = 0
    func binding<T>(_ key: ReferenceWritableKeyPath<Model, T>) -> Binding<T> {
      Binding(get: { self[keyPath: key] }, set: { self[keyPath: key] = $0 })
    }
  }

  func testBindingTransactionsRestoreTypedBaselinesAndRejectUnregisteredStyles() throws {
    let model = Model()
    let node = SwiftUIInspectionNode(
      id: "tile", tag: "SwiftUI.Rectangle", parent: nil,
      properties: [
        .numberStyle("width", model.binding(\.width)),
        .numberStyle("border-radius", model.binding(\.radius)),
        .color("background-color", model.binding(\.color)),
      ], action: nil)
    try node.apply([["key": "width", "value": "120px"], ["key": "background", "value": "red"]])
    XCTAssertEqual(model.width, 120)
    XCTAssertEqual(node.styles["background-color"], "rgba(255, 0, 0, 1.0)")
    XCTAssertThrowsError(
      try node.apply([
        ["key": "width", "value": "150px"],
        ["key": "border-radius", "value": "NaN"],
      ]))
    XCTAssertEqual(model.width, 120, "A rejected edit rolls back every binding")
    XCTAssertThrowsError(try node.apply([["key": "position", "value": "absolute"]]))
    try node.apply([["key": "width", "reset": true], ["key": "background-color", "reset": true]])
    XCTAssertEqual(model.width, 72)
    XCTAssertEqual(model.color, .blue, "Restores the typed Color, including semantic colors")
    model.radius = 36
    XCTAssertEqual(node.styles["border-radius"], "36.0px", "App writes appear on the next snapshot")
  }

  func testTextAndControlBindingsValidateAndWriteActualState() throws {
    let model = Model()
    let node = SwiftUIInspectionNode(
      id: "control", tag: "SwiftUI.Text", parent: nil,
      properties: [
        .text(model.binding(\.title)), .checked(model.binding(\.enabled)),
        .value(model.binding(\.choice), choices: ["Berlin", "London"]),
      ], action: nil)
    try node.setAttribute("text", value: "Edited")
    try node.setAttribute("checked", value: "false")
    try node.setAttribute("value", value: "London")
    XCTAssertEqual(model.title, "Edited")
    XCTAssertFalse(model.enabled)
    XCTAssertEqual(model.choice, "London")
    XCTAssertThrowsError(try node.setAttribute("value", value: "Unknown"))
    XCTAssertThrowsError(try node.setAttribute("checked", value: "maybe"))
    XCTAssertFalse(model.enabled)
    node.properties = [.text("Derived text")]
    XCTAssertThrowsError(try node.setAttribute("text", value: "Cannot overwrite derived state"))
  }

  func testRegistryRejectsDuplicateIDsAndDetachedTargetsAndProjectsOnlyLogicalNodes() throws {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 200),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let registry = SwiftUIInspectionRegistry()
    registry.window = window
    let model = Model()
    let root = SwiftUIInspectionNode(
      id: "root", tag: "SwiftUI.VStack", parent: nil,
      properties: [], action: nil)
    let node = SwiftUIInspectionNode(
      id: "label", tag: "SwiftUI.Text", parent: "root",
      properties: [.text(model.binding(\.title))], action: nil)
    let rootProbe = NSView(frame: window.contentView!.bounds)
    let probe = NSView(frame: NSRect(x: 30, y: 40, width: 80, height: 20))
    window.contentView!.addSubview(rootProbe)
    window.contentView!.addSubview(probe)
    root.probe = rootProbe
    node.probe = probe
    registry.register(root)
    registry.register(node)
    let inspector = NativeInspector(window: window)
    let tree = registry.snapshot(id: { inspector.id($0) }, measure: { $0.frame })
    XCTAssertEqual(tree.nodes.count, 2)
    XCTAssertEqual(tree.nodes[1]["parent"] as? Int, inspector.id(root))
    XCTAssertEqual(registry.pick(NSPoint(x: 50, y: 50), in: window.contentView!), node)
    let duplicate = SwiftUIInspectionNode(
      id: "label", tag: "SwiftUI.Text", parent: nil,
      properties: [], action: nil)
    duplicate.probe = probe
    registry.register(duplicate)
    XCTAssertThrowsError(try node.setAttribute("text", value: "Ambiguous"))
    XCTAssertEqual(model.title, "Original")
    registry.remove(duplicate)
    try node.setAttribute("text", value: "Unique")
    XCTAssertEqual(model.title, "Unique")
    probe.removeFromSuperview()
    XCTAssertThrowsError(try inspector.object(inspector.id(node)))
    XCTAssertEqual(
      registry.snapshot(id: { inspector.id($0) }, measure: { $0.frame }).nodes.count, 1)
  }
}
