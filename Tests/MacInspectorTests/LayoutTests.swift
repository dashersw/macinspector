// SPDX-License-Identifier: MIT
import AppKit
import XCTest

@testable import MacInspector

final class LayoutTests: XCTestCase {
  func testNativeAttributeStateNormalizesAliasesAndDropdownSelection() throws {
    let (window, inspector, _, _, _) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    let button = NSButton(title: "Original title", target: nil, action: nil)
    button.identifier = .init("button")
    button.allowsMixedState = true
    button.state = .mixed
    let popup = NSPopUpButton()
    popup.identifier = .init("popup")
    popup.addItems(withTitles: ["First", "Second", "Third"])
    popup.selectItem(at: 0)
    window.contentView!.addSubview(button)
    window.contentView!.addSubview(popup)
    let nodes = inspector.snapshot()["nodes"] as! [[String: Any]]
    let buttonID =
      nodes.first { ($0["attributes"] as? [String: String])?["id"] == "button" }!["id"] as! Int
    let popupID =
      nodes.first { ($0["attributes"] as? [String: String])?["id"] == "popup" }!["id"] as! Int
    let itemID =
      nodes.first {
        $0["tag"] as? String == "NSMenuItem"
          && ($0["attributes"] as? [String: String])?["title"] == "Second"
      }!["id"] as! Int
    let alias = try inspector.handle("attribute-state", ["node": buttonID, "key": "value"])
    XCTAssertEqual(alias["key"] as? String, "title")
    XCTAssertEqual(alias["value"] as? String, "Original title")
    XCTAssertEqual(
      try inspector.handle("attribute-state", ["node": buttonID, "key": "checked"])["value"]
        as? String, "mixed")
    _ = try inspector.handle("attribute", ["node": buttonID, "key": "checked", "value": "false"])
    _ = try inspector.handle("attribute", ["node": buttonID, "key": "checked", "value": "mixed"])
    XCTAssertEqual(button.state, .mixed)
    let original = try inspector.handle("attribute-state", ["node": itemID, "key": "selected"])
    XCTAssertEqual(original["node"] as? Int, popupID)
    XCTAssertEqual(original["key"] as? String, "selected-index")
    XCTAssertEqual(original["value"] as? String, "0")
    _ = try inspector.handle("attribute", ["node": itemID, "key": "selected", "value": "true"])
    XCTAssertEqual(popup.indexOfSelectedItem, 1)
    _ = try inspector.handle("attribute", original)
    XCTAssertEqual(popup.indexOfSelectedItem, 0)
    _ = try inspector.handle(
      "attribute", ["node": popupID, "key": "selected-index", "value": "-1"])
    XCTAssertEqual(popup.indexOfSelectedItem, -1)
  }

  private func fixture() -> (NSWindow, NativeInspector, NSView, NSLayoutConstraint, Int) {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
      styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let view = NSTextField(labelWithString: "Layout subject")
    view.identifier = .init("subject")
    view.translatesAutoresizingMaskIntoConstraints = false
    window.contentView!.addSubview(view)
    let width = view.widthAnchor.constraint(equalToConstant: 120)
    width.identifier = "subject.width"
    NSLayoutConstraint.activate([
      width, view.heightAnchor.constraint(equalToConstant: 30),
      view.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
      view.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
    ])
    window.contentView!.layoutSubtreeIfNeeded()
    let inspector = NativeInspector(window: window)
    let nodes = inspector.snapshot()["nodes"] as! [[String: Any]]
    let node =
      nodes.first { ($0["attributes"] as? [String: String])?["id"] == "subject" }!["id"] as! Int
    return (window, inspector, view, width, node)
  }

  func testRealConstraintsPrioritiesDeactivationAndHighlights() throws {
    let (window, inspector, view, width, node) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    let result = try inspector.handle("layout", ["node": node])
    XCTAssertFalse(result["ambiguous"] as! Bool)
    XCTAssertFalse(result["translatesAutoresizingMask"] as! Bool)
    XCTAssertGreaterThan((result["intrinsic"] as! [String: CGFloat])["width"]!, 0)
    let constraints = result["constraints"] as! [[String: Any]]
    let entry = constraints.first { $0["identifier"] as? String == "subject.width" }!
    let id = entry["id"] as! String
    XCTAssertEqual(result["name"] as? String, "NSTextField #subject")
    XCTAssertEqual(entry["firstLabel"] as? String, "NSTextField #subject")
    XCTAssertEqual(entry["key"] as? String, "id:subject.width")
    XCTAssertEqual(entry["direct"] as? Bool, true)
    _ = try inspector.handle(
      "layout-edit", ["node": node, "constraint": id, "constant": 180, "priority": 999])
    XCTAssertEqual(width.constant, 180)
    XCTAssertEqual(width.priority.rawValue, 999)
    XCTAssertEqual(view.alignmentRect(forFrame: view.frame).width, 180, accuracy: 0.01)
    _ = try inspector.handle("layout-edit", ["node": node, "constraint": id, "active": false])
    XCTAssertFalse(width.isActive)
    XCTAssertTrue(
      (try inspector.handle("layout", ["node": node])["constraints"] as! [[String: Any]]).contains {
        $0["id"] as? String == id
      })
    _ = try inspector.handle(
      "layout-edit", ["node": node, "constraint": id, "active": true, "priority": 1000])
    XCTAssertTrue(width.isActive)
    _ = try inspector.handle(
      "layout-edit", ["node": node, "huggingHorizontal": 280, "compressionVertical": 800])
    XCTAssertEqual(view.contentHuggingPriority(for: .horizontal).rawValue, 280)
    XCTAssertEqual(view.contentCompressionResistancePriority(for: .vertical).rawValue, 800)
    XCTAssertThrowsError(
      try inspector.handle(
        "layout-edit", ["node": node, "constraint": id, "constant": 200, "priority": 1001]))
    XCTAssertEqual(width.constant, 180, "Validation must precede any mutation")
    XCTAssertThrowsError(
      try inspector.handle("layout-edit", ["node": node, "constraint": id, "active": 1]))
    let count = (inspector.snapshot()["nodes"] as! [[String: Any]]).count
    _ = try inspector.handle("layout-highlight", ["constraint": id])
    XCTAssertEqual((inspector.snapshot()["nodes"] as! [[String: Any]]).count, count)
    XCTAssertNil(
      window.contentView!.subviews.last!.hitTest(.zero),
      "Relationship overlays cannot intercept input")
    _ = try inspector.handle("layout-highlight", [:])
  }

  func testUnnamedViewsGetReadableLabelsWithoutChangingPersistenceKeys() throws {
    let (window, inspector, view, _, node) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    view.identifier = nil
    let result = try inspector.handle("layout", ["node": node])
    XCTAssertEqual(result["name"] as? String, "NSTextField “Layout subject”")
    let entries = result["constraints"] as! [[String: Any]]
    let height = entries.first { $0["firstAttribute"] as? String == "height" }!
    XCTAssertEqual(height["firstLabel"] as? String, "NSTextField “Layout subject”")
    XCTAssertTrue((height["key"] as! String).contains("NSTextField:"))
    let guide = NSLayoutGuide()
    guide.identifier = .init("Safe area")
    view.addLayoutGuide(guide)
    let guideWidth = guide.widthAnchor.constraint(equalTo: view.widthAnchor)
    guideWidth.isActive = true
    let layout = NativeLayout()
    let inspected = try layout.inspect(view, id: { _ in node })
    XCTAssertTrue(
      (inspected["constraints"] as! [[String: Any]]).contains {
        ($0["firstLabel"] as? String)?.hasSuffix(" / Safe area") == true
      })
  }

  func testOverridesReplayStableIdentifiersAndRollbackFailedBatch() throws {
    let (window, inspector, view, width, _) = fixture()
    defer {
      inspector.stop()
      window.close()
    }
    let target: [String: Any] = ["id": "subject", "tag": "NSTextField"]
    let valid: [String: Any] = [
      "target": target,
      "styles": [["name": "opacity", "value": "0.5"]],
      "attributes": ["value": "Persisted text"],
      "constraints": [["key": "id:subject.width", "constant": 200]],
      "priorities": ["compressionHorizontal": 820],
    ]
    try inspector.applyOverrides(
      JSONSerialization.data(withJSONObject: ["version": 1, "edits": [valid]]))
    XCTAssertEqual(view.alphaValue, 0.5)
    XCTAssertEqual((view as! NSTextField).stringValue, "Persisted text")
    XCTAssertEqual(width.constant, 200)
    XCTAssertEqual(view.contentCompressionResistancePriority(for: .horizontal).rawValue, 820)
    let altered: [String: Any] = [
      "target": target,
      "styles": [["name": "opacity", "value": "0.2"]],
      "attributes": ["value": "Should roll back"],
      "constraints": [["key": "id:subject.width", "constant": 250]],
    ]
    let invalid: [String: Any] = [
      "target": target, "styles": [["name": "transform", "value": "rotate(NaNdeg)"]],
    ]
    XCTAssertThrowsError(
      try inspector.applyOverrides(
        JSONSerialization.data(withJSONObject: ["version": 1, "edits": [altered, invalid]])))
    XCTAssertEqual(view.alphaValue, 0.5)
    XCTAssertEqual((view as! NSTextField).stringValue, "Persisted text")
    XCTAssertEqual(width.constant, 200)
    let wrong: [String: Any] = [
      "target": ["id": "subject", "tag": "NSButton"], "attributes": ["title": "Wrong"],
    ]
    XCTAssertThrowsError(
      try inspector.applyOverrides(
        JSONSerialization.data(withJSONObject: ["version": 1, "edits": [altered, wrong]])))
    XCTAssertEqual(width.constant, 200, "Resolve every target before mutating the UI")
  }
}
